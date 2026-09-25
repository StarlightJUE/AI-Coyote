// DG-LAB Coyote 服务端设备控制中枢 (服务端维护设备状态机与底波引擎，支持 V4 与 V3 协议)
const crypto = require('crypto');
const net = require('net');
const config = require('./config');
const { normalizeWaveHex, COYOTE_WAVES } = require('./waves');

class CoyoteDeviceHub {
  constructor(v4Relay) {
    this.v4Relay = v4Relay;

    // 当前工作协议: 'v4' 或 'v3'
    this.protocol = 'v4';

    // 控制端唯一身份 ID (8位 Hex)
    this.controllerId = this.generateControllerId();
    this.targetId = null;
    this.slotId = '1';
    this.paired = false;
    this.devices = [];

    // V3 被控端 WebSocket 句柄
    this.v3ClientWs = null;

    // 双通道实时状态
    this.channelA = { strength: 0, softLimit: 200 };
    this.channelB = { strength: 0, softLimit: 200 };

    // 长期底层持续波形状态机 { A: { state: 'stopped', pattern, intervalMs, timer }, B: ... }
    this.bgWaves = {
      A: { state: 'stopped', pattern: null, intervalMs: 3000, timer: null },
      B: { state: 'stopped', pattern: null, intervalMs: 3000, timer: null }
    };

    this.isEmergencyStopped = false;
    this._reqCounter = 1;
    this._pendingRpcs = new Map();

    // SSE 网页监听者池 (res 响应句柄集合)
    this.sseClients = new Set();

    // 向 V4 Relay 注册服务端常驻虚拟控制器
    this._registerToRelay();
  }

  generateControllerId() {
    return crypto.randomBytes(4).toString('hex');
  }

  _registerToRelay() {
    this.v4Relay.registerVirtualController(this.controllerId, {
      onAttached: (clientId) => this._onClientAttached(clientId),
      onDisconnected: (clientId) => this._onClientDisconnected(clientId),
      onMessage: (clientId, data) => this._onAppMessage(clientId, data)
    });
  }

  // 协议切换 (V4 / V3)
  setProtocol(proto) {
    const p = proto === 'v3' ? 'v3' : 'v4';
    if (this.protocol === p) return this.getState();

    console.log(`[DeviceHub] 切换协议: ${this.protocol.toUpperCase()} -> ${p.toUpperCase()}`);
    // 如果当前有连接，主动断开以进行重新绑定
    if (this.targetId) {
      this.disconnectCurrent('protocol_change');
    }
    this.protocol = p;
    const qrText = this.getQrCodeUrl();

    this.broadcast('protocol_change', { protocol: this.protocol, qrText });
    this.broadcast('qr_update', { controllerId: this.controllerId, qrText });
    this.broadcast('state', this.getState());
    return this.getState();
  }

  // 获取 APP 扫码直连短链 (支持动态根据客户端请求 Host 或局域网 IP 生成)
  getQrCodeUrl(preferredHost = null, isSecure = null) {
    const host = preferredHost || config.domain || 'localhost';
    const isIpHost = net.isIP(host) !== 0 || host === 'localhost';
    const isHttps = isSecure !== null ? Boolean(isSecure) : (!isIpHost && !config.ssl.disabled);
    const proto = isHttps ? 'wss' : 'ws';
    const base = `${proto}://${host}:${config.wsPort}`;

    if (this.protocol === 'v4') {
      const appWsUrl = `${base}/v4?tid=${this.controllerId}`;
      return `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appWsUrl)}`;
    } else {
      return `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${base}/${this.controllerId}`;
    }
  }

  // 手动重新生成二维码与新配对 ID
  regenerateQr(customHost = null, isSecure = null) {
    console.log('[DeviceHub] 收到手动重新生成二维码与配对 ID 请求');
    // 如果已有连接中的 APP，主动断开
    if (this.targetId) {
      this.disconnectCurrent('manual_regenerate_qr');
    }
    this.v4Relay.unregisterVirtualController(this.controllerId);

    this.controllerId = this.generateControllerId();
    this.isEmergencyStopped = false;
    this._clearAllBgWaves();

    this._registerToRelay();
    const qrText = this.getQrCodeUrl(customHost, isSecure);
    console.log(`[DeviceHub] 新配对 ID 已就绪: ${this.controllerId} (${this.protocol.toUpperCase()}) -> ${qrText}`);

    this.broadcast('qr_update', { controllerId: this.controllerId, qrText });
    this.broadcast('state', this.getState(customHost, isSecure));
    return { controllerId: this.controllerId, qrText };
  }

  disconnectCurrent(reason = 'user_disconnect') {
    if (this.protocol === 'v4' && this.targetId) {
      this.v4Relay.disconnectClient(this.targetId, reason);
    } else if (this.protocol === 'v3' && this.v3ClientWs) {
      try {
        this.v3ClientWs.close(1000, reason);
      } catch (e) {}
      this.v3ClientWs = null;
    }

    this.targetId = null;
    this.paired = false;
    this._clearAllBgWaves();
    this.broadcast('disconnected', { reason });
    this.broadcast('state', this.getState());
  }

  // ================= V3 协议接入与报文处理 =================

  isTargetOfV3(targetId, clientId) {
    const tid = String(targetId || '').trim().toLowerCase();
    const cid = String(clientId || '').trim().toLowerCase();
    const myId = String(this.controllerId).toLowerCase();
    return tid === myId || cid === myId;
  }

  handleV3AppBind(appClientId, ws) {
    this.v3ClientWs = ws;
    this.targetId = appClientId;
    this.paired = true;
    this.isEmergencyStopped = false;
    console.log(`[DeviceHub] 🎉 DG-LAB APP (V3) 配对成功! ClientId: ${appClientId}`);

    // 发送标准 V3 绑定成功确认
    const bindSuccessMsg = {
      type: 'bind',
      clientId: this.controllerId,
      targetId: appClientId,
      message: '200'
    };
    try {
      ws.send(JSON.stringify(bindSuccessMsg));
    } catch (e) {}

    this.broadcast('paired', { targetId: appClientId, controllerId: this.controllerId, protocol: 'v3' });
    this.broadcast('state', this.getState());
  }

  handleV3AppMessage(rawText) {
    const str = String(rawText || '');
    if (str.includes('strength')) {
      const nums = str.match(/\d+/g);
      if (nums && nums.length >= 4) {
        this.channelA.strength = parseInt(nums[0], 10);
        this.channelB.strength = parseInt(nums[1], 10);
        this.channelA.softLimit = parseInt(nums[2], 10);
        this.channelB.softLimit = parseInt(nums[3], 10);
        this.broadcast('strength_update', {
          channelA: { ...this.channelA },
          channelB: { ...this.channelB }
        });
      }
    } else if (str.includes('feedback')) {
      const btnIndex = parseInt(str.replace(/[^0-9]/g, ''), 10);
      const isChannelA = btnIndex <= 4;
      this.broadcast('button_feedback', {
        index: btnIndex,
        channel: isChannelA ? 'A' : 'B',
        symbolIndex: isChannelA ? btnIndex : btnIndex - 5
      });
    }
  }

  handleV3AppClose(ws) {
    if (this.v3ClientWs === ws) {
      console.warn(`[DeviceHub] ⚠️ DG-LAB APP (V3) 已断开连接: ${this.targetId}`);
      this.v3ClientWs = null;
      this.targetId = null;
      this.paired = false;
      this._clearAllBgWaves();
      this.broadcast('disconnected', { protocol: 'v3' });
      this.broadcast('state', this.getState());
    }
  }

  // ================= V4 协议接入与报文处理 =================

  _onClientAttached(clientId) {
    this.targetId = clientId;
    this.paired = true;
    this.isEmergencyStopped = false;
    console.log(`[DeviceHub] 🎉 DG-LAB APP (V4) 配对成功! ClientId: ${clientId}`);

    // 接入后主动请求设备列表
    this._rpc('devices.get').catch(e => console.warn('[DeviceHub devices.get Error]:', e.message));

    this.broadcast('paired', { targetId: clientId, controllerId: this.controllerId, protocol: 'v4' });
    this.broadcast('state', this.getState());
  }

  _onClientDisconnected(clientId) {
    if (this.targetId === clientId) {
      console.warn(`[DeviceHub] ⚠️ DG-LAB APP (V4) 已断开连接: ${clientId}`);
      this.targetId = null;
      this.paired = false;
      this._clearAllBgWaves();
      this.broadcast('disconnected', { clientId, protocol: 'v4' });
      this.broadcast('state', this.getState());
    }
  }

  _onAppMessage(clientId, data) {
    if (!data || typeof data !== 'object') return;

    // 1. 设备快照
    if (data.t === 'ev' && data.ev === 'devices.snapshot') {
      if (Array.isArray(data.devices) && data.devices.length > 0) {
        this.devices = data.devices;
        this.slotId = data.devices[0].slotId;
        this._syncProps(data.devices[0]);
      }
      return;
    }

    // 2. 设备增量
    if (data.t === 'ev' && data.ev === 'devices.patch') {
      if (Array.isArray(data.added) && data.added[0]) {
        this.devices = data.added;
        this.slotId = data.added[0].slotId;
        this._syncProps(data.added[0]);
      }
      return;
    }

    // 3. 按键反馈
    if (data.t === 'ev' && data.ev === 'custom.action') {
      const act = data.action;
      const isA = act <= 4;
      this.broadcast('button_feedback', {
        index: act,
        channel: isA ? 'A' : 'B',
        symbolIndex: isA ? act : act - 5
      });
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
        this._syncProps(data.result.devices[0]);
      }
      return;
    }
  }

  _syncProps(dev) {
    if (!dev || !dev.props) return;
    const p = dev.props;
    let changed = false;
    if (typeof p.aIntensity === 'number' && this.channelA.strength !== p.aIntensity) {
      this.channelA.strength = p.aIntensity;
      changed = true;
    }
    if (typeof p.bIntensity === 'number' && this.channelB.strength !== p.bIntensity) {
      this.channelB.strength = p.bIntensity;
      changed = true;
    }
    if (typeof p.aLimit === 'number' && this.channelA.softLimit !== p.aLimit) {
      this.channelA.softLimit = p.aLimit;
      changed = true;
    }
    if (typeof p.bLimit === 'number' && this.channelB.softLimit !== p.bLimit) {
      this.channelB.softLimit = p.bLimit;
      changed = true;
    }

    if (changed) {
      this.broadcast('strength_update', {
        channelA: { ...this.channelA },
        channelB: { ...this.channelB }
      });
    }
  }

  // 发送 V4 RPC 请求
  _rpc(method, data = undefined) {
    if (!this.targetId) {
      return Promise.reject(new Error('未连接 DG-LAB APP 设备'));
    }
    const reqId = String(this._reqCounter++);
    const payload = {
      t: 'req',
      reqId,
      m: method,
      ...(data !== undefined ? { data } : {})
    };

    return new Promise((resolve, reject) => {
      this._pendingRpcs.set(reqId, { resolve, reject });
      setTimeout(() => {
        if (this._pendingRpcs.has(reqId)) {
          this._pendingRpcs.delete(reqId);
          reject(new Error(`RPC ${method} 请求超时`));
        }
      }, 5000);

      const ok = this.v4Relay.sendToClient(this.targetId, payload);
      if (!ok) {
        this._pendingRpcs.delete(reqId);
        reject(new Error('向被控端发送数据失败'));
      }
    });
  }

  // ================= 核心硬件控制 API (兼容 V4 与 V3) =================

  // 1. 微调强度 (增加/减少)
  adjustStrength(channel, delta) {
    if (this.isEmergencyStopped || !delta) return;
    const ch = (channel === 'A' || channel === 1) ? 'A' : 'B';
    const curVal = ch === 'A' ? this.channelA.strength : this.channelB.strength;
    const limit = ch === 'A' ? this.channelA.softLimit : this.channelB.softLimit;
    const targetVal = Math.max(0, Math.min(curVal + delta, limit || 200));

    return this.setStrength(ch, targetVal);
  }

  // 2. 设置绝对强度
  setStrength(channel, val) {
    if (this.isEmergencyStopped && val > 0) return;
    const ch = (channel === 'A' || channel === 1) ? 'A' : 'B';
    const chIndex = ch === 'A' ? 0 : 1;
    const chNum = ch === 'A' ? 1 : 2;
    const limit = ch === 'A' ? this.channelA.softLimit : this.channelB.softLimit;
    const safeVal = Math.max(0, Math.min(val, limit || 200));
    const curVal = ch === 'A' ? this.channelA.strength : this.channelB.strength;

    if (this.paired && this.targetId) {
      if (this.protocol === 'v4') {
        const slot = this.slotId || '1';
        if (safeVal === 0) {
          this._rpc('device.op', { s: slot, c: chIndex, t: 7, v: 0 })
            .catch(e => console.error('[DeviceHub resetIntensity Error]:', e.message));
        } else {
          const diff = safeVal - curVal;
          if (diff !== 0) {
            this._rpc('device.op', { s: slot, c: chIndex, t: 3, v: diff })
              .catch(e => console.error('[DeviceHub addIntensity Error]:', e.message));
          }
        }
      } else if (this.protocol === 'v3' && this.v3ClientWs) {
        try {
          this.v3ClientWs.send(JSON.stringify({
            type: 3,
            channel: chNum,
            strength: safeVal,
            message: 'set channel',
            clientId: this.controllerId,
            targetId: this.targetId
          }));
        } catch (e) {
          console.error('[DeviceHub V3 setStrength Error]:', e.message);
        }
      }
    }

    if (ch === 'A') this.channelA.strength = safeVal;
    else this.channelB.strength = safeVal;

    this.broadcast('strength_update', {
      channelA: { ...this.channelA },
      channelB: { ...this.channelB }
    });
    console.log(`[DeviceHub] 设绝对强度: 通道 ${ch} -> ${safeVal} [${this.protocol.toUpperCase()}]`);
    return safeVal;
  }

  // 3. 清空通道
  clearChannel(channel) {
    const ch = (channel === 'A' || channel === 1) ? 'A' : 'B';
    if (this.paired && this.targetId) {
      if (this.protocol === 'v4') {
        const slot = this.slotId || '1';
        this._rpc('device.op.clear', { s: slot, c: ch === 'A' ? 0 : 1 })
          .catch(e => console.error('[DeviceHub clearChannel Error]:', e.message));
      } else if (this.protocol === 'v3' && this.v3ClientWs) {
        try {
          this.v3ClientWs.send(JSON.stringify({
            type: 4,
            channel: ch === 'A' ? 1 : 2,
            message: 'clear',
            clientId: this.controllerId,
            targetId: this.targetId
          }));
        } catch (e) {}
      }
    }
    console.log(`[DeviceHub] 清空通道波形: 通道 ${ch}`);
  }

  // 4. 下发脉冲波形
  playWave(channel, pattern, durationSec = 3) {
    if (this.isEmergencyStopped) return;
    const ch = (channel === 'A' || channel === 1) ? 'A' : 'B';
    const chIndex = ch === 'A' ? 0 : 1;
    const duration = Math.max(1, durationSec || 3);
    const hexArray = normalizeWaveHex(pattern);

    if (this.paired && this.targetId) {
      if (this.protocol === 'v4') {
        const slot = this.slotId || '1';
        this._rpc('device.op', { s: slot, c: chIndex, t: 0, p: 1, d: duration * 1000, v: hexArray })
          .catch(e => console.error('[DeviceHub playWave Error]:', e.message));
      } else if (this.protocol === 'v3' && this.v3ClientWs) {
        try {
          this.v3ClientWs.send(JSON.stringify({
            type: 'clientMsg',
            channel: ch,
            time: duration,
            message: `${ch}:${JSON.stringify(hexArray)}`,
            clientId: this.controllerId,
            targetId: this.targetId
          }));
        } catch (e) {
          console.error('[DeviceHub V3 playWave Error]:', e.message);
        }
      }
    }
    console.log(`[DeviceHub] 触发脉冲波形: 通道 ${ch}, 持续 ${duration}s [${this.protocol.toUpperCase()}]`);
  }

  // 5. 长期底层持续波形引擎 (运行在 Node.js 服务端定时器)
  startBgWave(channel, pattern = '呼吸', intervalMs = 3000) {
    if (this.isEmergencyStopped) return;
    const ch = (channel === 'A' || channel === 1) ? 'A' : 'B';
    const interval = Math.max(1000, intervalMs || 3000);

    // 清除旧定时器
    if (this.bgWaves[ch]?.timer) {
      clearInterval(this.bgWaves[ch].timer);
    }

    const durSec = Math.max(2, Math.ceil(interval / 1000) + 1);
    this.playWave(ch, pattern, durSec);

    const timer = setInterval(() => {
      if (this.bgWaves[ch]?.state === 'running' && !this.isEmergencyStopped) {
        this.playWave(ch, this.bgWaves[ch].pattern, durSec);
      }
    }, interval);

    this.bgWaves[ch] = {
      state: 'running',
      pattern,
      intervalMs: interval,
      timer
    };

    console.log(`[DeviceHub] 启动长期底层波形: 通道 ${ch} [${pattern}] 周期 ${interval}ms`);
    this.broadcast('bg_wave_update', {
      channel: ch,
      state: 'running',
      pattern,
      intervalMs: interval
    });
  }

  pauseBgWave(channel) {
    const ch = (channel === 'A' || channel === 1) ? 'A' : 'B';
    if (!this.bgWaves[ch] || this.bgWaves[ch].state === 'stopped') return;

    this.bgWaves[ch].state = 'paused';
    this.clearChannel(ch);
    console.log(`[DeviceHub] 暂停长期底层波形: 通道 ${ch}`);
    this.broadcast('bg_wave_update', {
      channel: ch,
      state: 'paused',
      pattern: this.bgWaves[ch].pattern
    });
  }

  resumeBgWave(channel) {
    const ch = (channel === 'A' || channel === 1) ? 'A' : 'B';
    if (!this.bgWaves[ch] || this.bgWaves[ch].state !== 'paused') return;

    this.bgWaves[ch].state = 'running';
    const durSec = Math.max(2, Math.ceil(this.bgWaves[ch].intervalMs / 1000) + 1);
    this.playWave(ch, this.bgWaves[ch].pattern, durSec);

    console.log(`[DeviceHub] 恢复长期底层波形: 通道 ${ch}`);
    this.broadcast('bg_wave_update', {
      channel: ch,
      state: 'running',
      pattern: this.bgWaves[ch].pattern
    });
  }

  stopBgWave(channel) {
    const ch = (channel === 'A' || channel === 1) ? 'A' : 'B';
    if (this.bgWaves[ch]?.timer) {
      clearInterval(this.bgWaves[ch].timer);
    }
    this.bgWaves[ch] = {
      state: 'stopped',
      pattern: null,
      intervalMs: 3000,
      timer: null
    };
    this.clearChannel(ch);
    console.log(`[DeviceHub] 关闭长期底层波形: 通道 ${ch}`);
    this.broadcast('bg_wave_update', {
      channel: ch,
      state: 'stopped',
      pattern: null
    });
  }

  _clearAllBgWaves() {
    ['A', 'B'].forEach(ch => {
      if (this.bgWaves[ch]?.timer) {
        clearInterval(this.bgWaves[ch].timer);
      }
      this.bgWaves[ch] = {
        state: 'stopped',
        pattern: null,
        intervalMs: 3000,
        timer: null
      };
    });
  }

  // 6. 一键急停 (强制归零并清空所有任务)
  emergencyStop() {
    this.isEmergencyStopped = true;
    this._clearAllBgWaves();

    if (this.paired && this.targetId) {
      if (this.protocol === 'v4') {
        const slot = this.slotId || '1';
        this._rpc('device.op', { s: slot, c: 0, t: 7, v: 0 }).catch(() => {});
        this._rpc('device.op', { s: slot, c: 1, t: 7, v: 0 }).catch(() => {});
        this._rpc('device.op.clear', { s: slot, c: 0 }).catch(() => {});
        this._rpc('device.op.clear', { s: slot, c: 1 }).catch(() => {});
      } else if (this.protocol === 'v3' && this.v3ClientWs) {
        try {
          this.v3ClientWs.send(JSON.stringify({ type: 3, channel: 1, strength: 0, message: 'set channel', clientId: this.controllerId, targetId: this.targetId }));
          this.v3ClientWs.send(JSON.stringify({ type: 3, channel: 2, strength: 0, message: 'set channel', clientId: this.controllerId, targetId: this.targetId }));
          this.v3ClientWs.send(JSON.stringify({ type: 4, channel: 1, message: 'clear', clientId: this.controllerId, targetId: this.targetId }));
          this.v3ClientWs.send(JSON.stringify({ type: 4, channel: 2, message: 'clear', clientId: this.controllerId, targetId: this.targetId }));
        } catch (e) {}
      }
    }

    this.channelA.strength = 0;
    this.channelB.strength = 0;

    console.warn('[DeviceHub] 🚨 一键急停触发！双通道已归零并清空！');
    this.broadcast('emergency_stop', {});
    this.broadcast('strength_update', {
      channelA: { ...this.channelA },
      channelB: { ...this.channelB }
    });
  }

  // 7. 直接在服务端执行 AI 下发的结构化动作数组
  executeActions(actions = []) {
    if (!Array.isArray(actions) || actions.length === 0) return;

    actions.forEach((act, idx) => {
      setTimeout(() => {
        if (this.isEmergencyStopped) return;
        const op = act.op;
        const ch = act.channel || 'A';

        switch (op) {
          case 'hold_strength':
            if (typeof act.value === 'number') {
              this.setStrength(ch, act.value);
            }
            break;

          case 'add_strength':
            if (typeof act.delta === 'number') {
              this.adjustStrength(ch, act.delta);
            }
            break;

          case 'pulse':
          case 'custom_pulse':
            if (act.pattern || act.waves) {
              const p = act.pattern || act.waves;
              const dur = act.duration_s || 3;
              this.playWave(ch, p, dur);
            }
            break;

          case 'pulse_hold':
            if (act.pattern) {
              this.playWave(ch, act.pattern, 5);
            }
            break;

          case 'bg_wave_start':
            if (act.pattern) {
              const interval = act.interval_ms || 3000;
              this.startBgWave(ch, act.pattern, interval);
            }
            break;

          case 'bg_wave_pause':
            this.pauseBgWave(ch);
            break;

          case 'bg_wave_resume':
            this.resumeBgWave(ch);
            break;

          case 'bg_wave_stop':
            this.stopBgWave(ch);
            break;

          case 'temp_strength':
            if (typeof act.value === 'number') {
              const dur = act.duration_s || 3;
              this.setStrength(ch, act.value);
              setTimeout(() => {
                this.setStrength(ch, 0);
              }, dur * 1000);
            }
            break;

          case 'clear':
            this.clearChannel(ch);
            break;

          case 'stop':
            this.emergencyStop();
            break;

          default:
            console.warn('[DeviceHub] 未知 AI 动作:', act);
        }
      }, idx * 250);
    });
  }

  // ================= SSE 实时事件推送 =================

  addSseClient(res, preferredHost = null, isSecure = null) {
    this.sseClients.add(res);
    // 立即向新连入的前端推送当前完整状态
    res.write(`event: state\ndata: ${JSON.stringify(this.getState(preferredHost, isSecure))}\n\n`);

    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch (e) {
        this.sseClients.delete(res);
      }
    }
  }

  // 获取当前状态
  getState(preferredHost = null, isSecure = null) {
    return {
      paired: this.paired,
      protocol: this.protocol,
      controllerId: this.controllerId,
      targetId: this.targetId,
      qrText: this.getQrCodeUrl(preferredHost, isSecure),
      localIps: config.localIps || [],
      domain: config.domain,
      channelA: { ...this.channelA },
      channelB: { ...this.channelB },
      bgWaves: {
        A: { state: this.bgWaves.A.state, pattern: this.bgWaves.A.pattern },
        B: { state: this.bgWaves.B.state, pattern: this.bgWaves.B.pattern }
      },
      isEmergencyStopped: this.isEmergencyStopped
    };
  }
}

module.exports = CoyoteDeviceHub;
