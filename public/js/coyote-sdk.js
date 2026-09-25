/**
 * DG-Lab Coyote 3.0 控制 SDK (V4 优先 / V3 兼容)
 * 完美支持 DG-LAB 4.6 APP 官方 V4 协议与 V4 二维码短链规范
 */
class CoyoteSDK extends EventTarget {
  constructor(options = {}) {
    super();

    this.options = Object.assign({
      baseWsUrl: '',           // 基础 ws 服务地址 (如 wss://coyote.example.com:54321)
      serverWsUrl: '',         // 兼容传入的完整地址
      protocol: 'v4',          // 默认 'v4' 优先模式 ('v4' | 'v3')
      defaultWaveDuration: 3   // 默认波形下发时长（秒）
    }, options);

    this.ws = null;
    this.clientId = '';
    this.targetId = '';
    this.slotId = '';          // V4 设备 slotId
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'waiting_bind' | 'paired'
    this.devices = [];

    // 双通道实时状态
    this.channelA = { strength: 0, softLimit: 200 };
    this.channelB = { strength: 0, softLimit: 200 };

    this.isEmergencyStopped = false;
    this._reqCounter = 1;
    this._pendingRpcs = new Map();

    // 长期底层波形循环任务 { A: null, B: null }
    this.bgWaves = { A: null, B: null };
  }

  // 获取基础 WebSocket 服务地址 (协议 + 主机 + 端口，无路径)
  getBaseWsUrl() {
    let base = this.options.baseWsUrl || this.options.serverWsUrl || '';
    if (base) {
      // 剥离尾部 /v4 或多余斜杠
      base = base.replace(/\/v4\/?$/, '').replace(/\/+$/, '');
      return base;
    }
    const isHttps = window.location.protocol === 'https:';
    const proto = isHttps ? 'wss:' : 'ws:';
    const host = window.location.hostname || 'localhost';
    return `${proto}//${host}:54321`;
  }

  // 根据当前协议获取实际连接端点 (携带持久化 clientId)
  getConnectUrl() {
    const base = this.getBaseWsUrl();
    if (!this.clientId) {
      this.clientId = localStorage.getItem('coyote_client_id_' + this.options.protocol) || '';
    }
    const query = this.clientId ? `?clientId=${this.clientId}` : '';
    return this.options.protocol === 'v4' ? `${base}/v4${query}` : `${base}${query}`;
  }

  // 1. 初始化连接
  connect(customBaseUrl = null) {
    if (customBaseUrl) {
      this.options.baseWsUrl = customBaseUrl;
    }

    const connectUrl = this.getConnectUrl();
    this._updateStatus('connecting');

    try {
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      }
      this.ws = new WebSocket(connectUrl);
    } catch (err) {
      console.error('[CoyoteSDK] WebSocket 异常:', err);
      this._updateStatus('disconnected', err.message);
      return;
    }

    this.ws.onopen = () => {
      console.log(`[CoyoteSDK] 已连接至服务端 (${this.options.protocol.toUpperCase()} 模式: ${connectUrl})`);
    };

    this.ws.onmessage = (event) => {
      this._handleMessage(event.data);
    };

    this.ws.onerror = (err) => {
      console.error('[CoyoteSDK] WS 发生错误:', err);
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    };

    this.ws.onclose = (event) => {
      console.warn('[CoyoteSDK] 连接断开:', event.code, event.reason);
      this._updateStatus('disconnected');
    };
  }

  // 手动重新生成二维码与新配对 ID
  regenerateNewPairing() {
    localStorage.removeItem('coyote_client_id_' + this.options.protocol);
    localStorage.removeItem('coyote_target_id_' + this.options.protocol);
    this.clientId = '';
    this.targetId = '';
    this.slotId = '';
    this.devices = [];
    this.connect();
  }

  // 切换协议模式
  setProtocol(version) {
    if (version !== 'v4' && version !== 'v3') return;
    this.options.protocol = version;
    this.clientId = localStorage.getItem('coyote_client_id_' + version) || '';
    this.targetId = '';
    this.slotId = '';
    this.devices = [];
    this.connect();
  }

  // 2. 报文消息分发
  _handleMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch (e) {
      return;
    }

    // 处理 V4 服务端广播帧
    if (msg.type === 'hello') {
      this.clientId = msg.clientId;
      localStorage.setItem('coyote_client_id_' + this.options.protocol, this.clientId);
      console.log(`[CoyoteSDK V4] 获得控制方 ClientId: ${this.clientId}`);
      this._updateStatus('waiting_bind');
      this.dispatchEvent(new CustomEvent('ready_for_scan', {
        detail: { clientId: this.clientId, qrText: this.getQrCodeUrl(), protocol: 'v4' }
      }));
      return;
    }

    if (msg.type === 'client_attached') {
      this.targetId = msg.clientId;
      localStorage.setItem('coyote_target_id_' + this.options.protocol, this.targetId);
      this.isEmergencyStopped = false;
      console.log(`[CoyoteSDK V4] APP 被控方接入! ID: ${this.targetId}`);
      this._updateStatus('paired');
      this.dispatchEvent(new CustomEvent('paired', { detail: { targetId: this.targetId, protocol: 'v4' } }));
      // 接入后主动请求设备列表
      this._rpc('devices.get');
      return;
    }

    if (msg.type === 'client_disconnected') {
      console.warn(`[CoyoteSDK V4] 被控方断开: ${msg.clientId}`);
      this.targetId = '';
      localStorage.removeItem('coyote_target_id_' + this.options.protocol);
      this._updateStatus('waiting_bind');
      this.dispatchEvent(new CustomEvent('peer_disconnected'));
      return;
    }

    if (msg.type === 'message') {
      this._handleV4AppData(msg.data);
      return;
    }

    // 兼容 V3 协议帧
    if (msg.type === 'bind') {
      if (!msg.targetId) {
        this.clientId = msg.clientId;
        this._updateStatus('waiting_bind');
        this.dispatchEvent(new CustomEvent('ready_for_scan', {
          detail: { clientId: this.clientId, qrText: this.getQrCodeUrl(), protocol: 'v3' }
        }));
      } else if (msg.message === '200') {
        this.targetId = msg.targetId;
        this.isEmergencyStopped = false;
        this._updateStatus('paired');
        this.dispatchEvent(new CustomEvent('paired', { detail: { targetId: this.targetId, protocol: 'v3' } }));
      }
      return;
    }

    if (msg.type === 'break') {
      this.targetId = '';
      this._updateStatus('waiting_bind');
      this.dispatchEvent(new CustomEvent('peer_disconnected'));
      return;
    }

    if (msg.type === 'msg' || (typeof msg.message === 'string')) {
      this._handleV3AppFeedback(msg.message || '');
      return;
    }
  }

  // 处理 V4 协议下 APP 上报的数据
  _handleV4AppData(data) {
    if (!data || typeof data !== 'object') return;

    // 1. 设备快照事件
    if (data.t === 'ev' && data.ev === 'devices.snapshot') {
      if (Array.isArray(data.devices) && data.devices.length > 0) {
        this.devices = data.devices;
        this.slotId = data.devices[0].slotId;
        console.log(`[CoyoteSDK V4] 捕获设备 SlotId: ${this.slotId} (${data.devices[0].name || '郊狼'})`);
        this._syncV4DeviceProps(data.devices[0]);
      }
      return;
    }

    // 2. 设备增量事件 (强度更新)
    if (data.t === 'ev' && data.ev === 'devices.patch') {
      if (Array.isArray(data.added)) {
        this.devices = data.added;
        if (data.added[0]) {
          this.slotId = data.added[0].slotId;
          this._syncV4DeviceProps(data.added[0]);
        }
      }
      return;
    }

    // 3. 自定义动作按键事件 (feedback 0~9)
    if (data.t === 'ev' && data.ev === 'custom.action') {
      const act = data.action;
      const isA = act <= 4;
      this.dispatchEvent(new CustomEvent('button_feedback', {
        detail: { index: act, channel: isA ? 'A' : 'B', symbolIndex: isA ? act : act - 5 }
      }));
      return;
    }

    // 4. RPC 响应
    if (data.t === 'resp' && data.reqId) {
      const pending = this._pendingRpcs.get(data.reqId);
      if (pending) {
        this._pendingRpcs.delete(data.reqId);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.result);
      }
      if (data.result && Array.isArray(data.result.devices) && data.result.devices.length > 0) {
        this.devices = data.result.devices;
        this.slotId = data.result.devices[0].slotId;
      }
      return;
    }
  }

  // 同步 V4 设备属性 (强度/软上限)
  _syncV4DeviceProps(dev) {
    if (!dev || !dev.props) return;
    const p = dev.props;
    // 官方 V4 props: aIntensity, bIntensity, aLimit, bLimit
    if (typeof p.aIntensity === 'number') this.channelA.strength = p.aIntensity;
    if (typeof p.bIntensity === 'number') this.channelB.strength = p.bIntensity;
    if (typeof p.aLimit === 'number') this.channelA.softLimit = p.aLimit;
    if (typeof p.bLimit === 'number') this.channelB.softLimit = p.bLimit;

    this.dispatchEvent(new CustomEvent('strength_update', {
      detail: { channelA: { ...this.channelA }, channelB: { ...this.channelB } }
    }));
  }

  // 兼容 V3 回传
  _handleV3AppFeedback(content) {
    if (content.includes('strength')) {
      const nums = content.match(/\d+/g);
      if (nums && nums.length >= 4) {
        this.channelA.strength = parseInt(nums[0], 10);
        this.channelB.strength = parseInt(nums[1], 10);
        this.channelA.softLimit = parseInt(nums[2], 10);
        this.channelB.softLimit = parseInt(nums[3], 10);
        this.dispatchEvent(new CustomEvent('strength_update', {
          detail: { channelA: { ...this.channelA }, channelB: { ...this.channelB } }
        }));
      }
    } else if (content.includes('feedback')) {
      const btnIndex = parseInt(content.replace('feedback-', ''), 10);
      const isChannelA = btnIndex <= 4;
      this.dispatchEvent(new CustomEvent('button_feedback', {
        detail: { index: btnIndex, channel: isChannelA ? 'A' : 'B', symbolIndex: isChannelA ? btnIndex : btnIndex - 5 }
      }));
    }
  }

  _updateStatus(newStatus, detail = null) {
    this.status = newStatus;
    this.dispatchEvent(new CustomEvent('status_change', {
      detail: { status: newStatus, detail, protocol: this.options.protocol }
    }));
  }

  // 3. 生成二维码
  getQrCodeUrl() {
    if (!this.clientId) return '';
    const base = this.getBaseWsUrl();

    if (this.options.protocol === 'v4') {
      // 官方 DG-LAB 4 APP 专属 V4 二维码短链规范
      const appWsUrl = `${base}/v4?tid=${this.clientId}`;
      return `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appWsUrl)}`;
    } else {
      // 经典 V3 二维码
      return `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${base}/${this.clientId}`;
    }
  }

  renderQrCode(containerId, size = 200) {
    const el = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    if (!el) return;
    el.innerHTML = '';
    const text = this.getQrCodeUrl();
    if (!text) {
      el.innerText = '等待中继分发 ID...';
      return;
    }
    if (typeof QRCode !== 'undefined') {
      new QRCode(el, {
        text: text,
        width: size,
        height: size,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      el.innerText = text;
    }
  }

  // 发送底层报文
  _sendRaw(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[CoyoteSDK] 发送失败: WS 未连接');
      return false;
    }
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  // V4 RPC 调用封装
  _rpc(method, data = undefined) {
    const reqId = String(this._reqCounter++);
    const payload = {
      type: 'message',
      clientId: this.targetId,
      data: {
        t: 'req',
        reqId,
        m: method,
        ...(data !== undefined ? { data } : {})
      }
    };

    return new Promise((resolve, reject) => {
      this._pendingRpcs.set(reqId, { resolve, reject });
      setTimeout(() => {
        if (this._pendingRpcs.has(reqId)) {
          this._pendingRpcs.delete(reqId);
          reject(new Error(`RPC ${method} 请求超时`));
        }
      }, 5000);
      this._sendRaw(payload);
    });
  }

  // 4. 强度控制 API (V4 优先，V3 兼容)
  increaseStrength(channel = 1, step = 1) {
    if (this.isEmergencyStopped) return;
    const chNum = channel === 'A' || channel === 1 ? 1 : 2;
    const chIndex = chNum === 1 ? 0 : 1;
    const curVal = chNum === 1 ? this.channelA.strength : this.channelB.strength;
    const targetVal = Math.min(curVal + step, 200);

    if (this.options.protocol === 'v4' && this.targetId) {
      // 官方 V4: t=3 为 AddIntensity (相对增加)
      const slot = this.slotId || '1';
      this._rpc('device.op', { s: slot, c: chIndex, t: 3, v: step })
        .catch(e => console.error('[V4 addIntensity Error]:', e.message));
    } else {
      this.setStrength(chNum, targetVal);
      return;
    }

    if (chNum === 1) this.channelA.strength = targetVal;
    else this.channelB.strength = targetVal;
    this.dispatchEvent(new CustomEvent('strength_update', {
      detail: { channelA: { ...this.channelA }, channelB: { ...this.channelB } }
    }));
  }

  decreaseStrength(channel = 1, step = 1) {
    const chNum = channel === 'A' || channel === 1 ? 1 : 2;
    const chIndex = chNum === 1 ? 0 : 1;
    const curVal = chNum === 1 ? this.channelA.strength : this.channelB.strength;
    const targetVal = Math.max(curVal - step, 0);

    if (this.options.protocol === 'v4' && this.targetId) {
      const slot = this.slotId || '1';
      if (targetVal === 0) {
        // 官方 V4: 降到0使用 t=7 (SetIntensity/resetIntensity)
        this._rpc('device.op', { s: slot, c: chIndex, t: 7, v: 0 })
          .catch(e => console.error('[V4 resetIntensity Error]:', e.message));
      } else {
        // 官方 V4: t=3 传入负数即为减少
        this._rpc('device.op', { s: slot, c: chIndex, t: 3, v: -step })
          .catch(e => console.error('[V4 reduceIntensity Error]:', e.message));
      }
    } else {
      this.setStrength(chNum, targetVal);
      return;
    }

    if (chNum === 1) this.channelA.strength = targetVal;
    else this.channelB.strength = targetVal;
    this.dispatchEvent(new CustomEvent('strength_update', {
      detail: { channelA: { ...this.channelA }, channelB: { ...this.channelB } }
    }));
  }

  setStrength(channel = 1, val = 0) {
    if (this.isEmergencyStopped && val > 0) return;
    const chNum = channel === 'A' || channel === 1 ? 1 : 2;
    const chIndex = chNum === 1 ? 0 : 1;
    const safeVal = Math.max(0, Math.min(val, 200));
    const curVal = chNum === 1 ? this.channelA.strength : this.channelB.strength;

    if (this.options.protocol === 'v4' && this.targetId) {
      const slot = this.slotId || '1';
      if (safeVal === 0) {
        // 官方 V4: t=7 仅用于归零 (resetIntensity)
        this._rpc('device.op', { s: slot, c: chIndex, t: 7, v: 0 })
          .catch(e => console.error('[V4 resetIntensity Error]:', e.message));
      } else {
        // 官方 V4: 设为指定绝对值通过相对差值 t=3 (AddIntensity) 达成
        const delta = safeVal - curVal;
        if (delta !== 0) {
          this._rpc('device.op', { s: slot, c: chIndex, t: 3, v: delta })
            .catch(e => console.error('[V4 addIntensity Error]:', e.message));
        }
      }
    } else {
      // V3 兼容
      this._sendRaw({
        type: 3,
        channel: chNum,
        strength: safeVal,
        message: 'set channel',
        clientId: this.clientId,
        targetId: this.targetId
      });
    }

    // 乐观更新本地显示
    if (chNum === 1) this.channelA.strength = safeVal;
    else this.channelB.strength = safeVal;
    this.dispatchEvent(new CustomEvent('strength_update', {
      detail: { channelA: { ...this.channelA }, channelB: { ...this.channelB } }
    }));
  }

  // 清空通道
  clearChannel(channel = 1) {
    const chNum = channel === 'A' || channel === 1 ? 1 : 2;
    if (this.options.protocol === 'v4' && this.targetId) {
      const slot = this.slotId || '1';
      this._rpc('device.op.clear', { s: slot, c: chNum === 1 ? 0 : 1 })
        .catch(e => console.error('[V4 clearChannel Error]:', e.message));
    } else {
      this._sendRaw({
        type: 4,
        channel: chNum,
        message: 'clear',
        clientId: this.clientId,
        targetId: this.targetId
      });
    }
  }

  // 5. 波形发送 API
  playWave(channel = 'A', waveData, durationSec = null) {
    if (this.isEmergencyStopped) return;
    const ch = channel === 1 || channel === 'A' ? 'A' : 'B';
    const chIndex = ch === 'A' ? 0 : 1;
    const duration = durationSec || this.options.defaultWaveDuration;

    let hexArray = waveData;
    if (typeof waveData === 'string') {
      if (typeof COYOTE_WAVES !== 'undefined' && COYOTE_WAVES[waveData]) {
        hexArray = COYOTE_WAVES[waveData];
      } else {
        try {
          hexArray = JSON.parse(waveData);
        } catch (e) {
          return;
        }
      }
    }

    // 格式化确保每个切片为严格 16 位 HEX 字符串 (4点频率 + 4点强度)
    if (Array.isArray(hexArray)) {
      hexArray = hexArray.map(f => {
        let str = String(f).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
        if (str.length < 16) str = str.padEnd(16, '0');
        if (str.length > 16) str = str.slice(0, 16);
        return str;
      });
    }

    if (this.options.protocol === 'v4' && this.targetId) {
      // 官方 V4 标准: t: 0 (AppendPulseData), d: 毫秒, v: 16位HEX数组, p: 1
      const slot = this.slotId || '1';
      this._rpc('device.op', { s: slot, c: chIndex, t: 0, p: 1, d: duration * 1000, v: hexArray })
        .catch(e => console.error('[V4 playWave RPC Error]:', e.message));
    } else {
      // V3 兼容
      this._sendRaw({
        type: 'clientMsg',
        channel: ch,
        time: duration,
        message: `${ch}:${JSON.stringify(hexArray)}`,
        clientId: this.clientId,
        targetId: this.targetId
      });
    }
    console.log(`[CoyoteSDK] 触发波形 [通道 ${ch}] [${this.options.protocol.toUpperCase()} 模式]`);
  }

  // 6. 长期底层波形 API (持续性低强度底色，可启动/暂停/恢复/删除)
  startBackgroundWave(channel = 'A', pattern = '呼吸', intervalMs = 3000) {
    if (this.isEmergencyStopped) return;
    const ch = (channel === 1 || channel === 'A') ? 'A' : 'B';
    const interval = Math.max(1000, intervalMs || 3000);

    // 若当前通道已有运行中的任务，先清理计时器
    if (this.bgWaves[ch]?.timerId) {
      clearInterval(this.bgWaves[ch].timerId);
    }

    const task = {
      pattern,
      intervalMs: interval,
      active: true,
      timerId: null
    };

    // 立即下发第一段底波
    const durSec = Math.max(2, Math.ceil(interval / 1000) + 1);
    this.playWave(ch, pattern, durSec);

    // 开启循环保持
    task.timerId = setInterval(() => {
      if (this.bgWaves[ch]?.active && !this.isEmergencyStopped) {
        this.playWave(ch, this.bgWaves[ch].pattern, durSec);
      }
    }, interval);

    this.bgWaves[ch] = task;
    console.log(`[CoyoteSDK] 启动底层持续波形 [通道 ${ch}]:`, pattern, `周期 ${interval}ms`);

    this.dispatchEvent(new CustomEvent('bg_wave_update', {
      detail: { channel: ch, state: 'running', pattern, intervalMs: interval }
    }));
  }

  pauseBackgroundWave(channel = 'A') {
    const ch = (channel === 1 || channel === 'A') ? 'A' : 'B';
    if (!this.bgWaves[ch]) return;

    this.bgWaves[ch].active = false;
    this.clearChannel(ch);
    console.log(`[CoyoteSDK] 已暂停通道 ${ch} 的底层波形`);

    this.dispatchEvent(new CustomEvent('bg_wave_update', {
      detail: { channel: ch, state: 'paused', pattern: this.bgWaves[ch].pattern }
    }));
  }

  resumeBackgroundWave(channel = 'A') {
    if (this.isEmergencyStopped) return;
    const ch = (channel === 1 || channel === 'A') ? 'A' : 'B';
    if (!this.bgWaves[ch]) return;

    this.bgWaves[ch].active = true;
    const durSec = Math.max(2, Math.ceil(this.bgWaves[ch].intervalMs / 1000) + 1);
    this.playWave(ch, this.bgWaves[ch].pattern, durSec);
    console.log(`[CoyoteSDK] 已恢复通道 ${ch} 的底层波形`);

    this.dispatchEvent(new CustomEvent('bg_wave_update', {
      detail: { channel: ch, state: 'running', pattern: this.bgWaves[ch].pattern }
    }));
  }

  stopBackgroundWave(channel = 'A') {
    const ch = (channel === 1 || channel === 'A') ? 'A' : 'B';
    if (!this.bgWaves[ch]) return;

    if (this.bgWaves[ch].timerId) {
      clearInterval(this.bgWaves[ch].timerId);
    }
    this.bgWaves[ch] = null;
    this.clearChannel(ch);
    console.log(`[CoyoteSDK] 已停止并删除通道 ${ch} 的底层波形`);

    this.dispatchEvent(new CustomEvent('bg_wave_update', {
      detail: { channel: ch, state: 'stopped' }
    }));
  }

  // 7. 一键急停 (Panic Button)
  emergencyStop() {
    this.isEmergencyStopped = true;
    console.warn('[CoyoteSDK] 🚨 触发一键急停！两通道强度归零并清空全部任务！');

    // 彻底停止双通道的底层持续波形
    this.stopBackgroundWave('A');
    this.stopBackgroundWave('B');

    if (this.options.protocol === 'v4' && this.targetId) {
      const slot = this.slotId || '1';
      // 归零两通道
      this._rpc('device.op', { s: slot, c: 0, t: 7, v: 0 }).catch(() => {});
      this._rpc('device.op', { s: slot, c: 1, t: 7, v: 0 }).catch(() => {});
      this._rpc('device.op.clear', { s: slot }).catch(() => {});
    } else {
      this._sendRaw({ type: 3, channel: 1, strength: 0, message: 'set channel', clientId: this.clientId, targetId: this.targetId });
      this._sendRaw({ type: 3, channel: 2, strength: 0, message: 'set channel', clientId: this.clientId, targetId: this.targetId });
      this._sendRaw({ type: 4, channel: 1, message: 'clear', clientId: this.clientId, targetId: this.targetId });
      this._sendRaw({ type: 4, channel: 2, message: 'clear', clientId: this.clientId, targetId: this.targetId });
    }

    this.channelA.strength = 0;
    this.channelB.strength = 0;

    this.dispatchEvent(new CustomEvent('emergency_stop'));
    this.dispatchEvent(new CustomEvent('strength_update', {
      detail: { channelA: { ...this.channelA }, channelB: { ...this.channelB } }
    }));
  }
}

window.CoyoteSDK = CoyoteSDK;
