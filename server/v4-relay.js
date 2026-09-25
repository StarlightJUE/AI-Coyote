// 移植自官方 dglab-websocket-server V4 Relay 核心 (Node.js 原生 JavaScript 实现)
const crypto = require('crypto');
const WebSocket = require('ws');

const CLOSE_CONTROLLER_DISCONNECTED = 4000;
const CLOSE_CONTROLLER_NOT_FOUND = 4001;
const CLOSE_IDLE_TIMEOUT = 4002;
const CLIENT_ID_BYTES = 4;

class V4RelayServer {
  constructor(options = {}) {
    this.options = Object.assign({
      heartbeatMs: 30000,
      wsPingMs: 15000,
      maxMissedWsPongs: 6, // 容忍 90 秒无响应，防止手机息屏或后台切应用被误杀
      idleTimeoutMs: 10 * 60 * 1000, // 10 分钟空闲超时
    }, options);

    this.sockets = new Set();
    this.wsToClientId = new Map();
    this.controllersById = new Map();
    this.controlledClients = new Map();
    this.clientToController = new Map();
    this.idleTimers = new Map();
    this.missedWsPongs = new Map();
    // 控制端掉线/刷新重连缓冲池 (clientId -> { clients, timer, disconnectTime })
    this.reconnectingControllers = new Map();

    this.heartbeatTimer = null;
    this.wsPingTimer = null;

    // 服务端虚拟控制器支持 (controllerId -> handlers)
    this.virtualControllers = new Map();
    this.clientToVirtualController = new Map();
    this.clientsById = new Map();
  }

  registerVirtualController(controllerId, handlers) {
    this.virtualControllers.set(controllerId, handlers);
    console.log(`[V4 Relay] 成功注册服务端虚拟控制器: ${controllerId}`);
  }

  unregisterVirtualController(controllerId) {
    this.virtualControllers.delete(controllerId);
    console.log(`[V4 Relay] 注销服务端虚拟控制器: ${controllerId}`);
  }

  sendToClient(clientId, data) {
    const ws = this.clientsById.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.sendFrame(ws, { type: 'message', data });
      return true;
    }
    return false;
  }

  disconnectClient(clientId, reason = 'manual_disconnect') {
    const ws = this.clientsById.get(clientId);
    if (ws) {
      try {
        ws.close(4000, reason);
      } catch (e) {}
    }
  }

  start() {
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.broadcastHeartbeat(), this.options.heartbeatMs);
    }
    if (!this.wsPingTimer) {
      this.wsPingTimer = setInterval(() => this.pingConnections(), this.options.wsPingMs);
    }
    console.log('[V4 Relay] 官方 V4 核心中继已就绪 (Heartbeat 30s, Ping 15s, 容忍90s)');
  }

  sendFrame(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  clientIdOf(ws) {
    return this.wsToClientId.get(ws) || '-';
  }

  broadcastHeartbeat() {
    const payload = JSON.stringify({ type: 'heartbeat' });
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  pingConnections() {
    for (const ws of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const missed = this.missedWsPongs.get(ws) || 0;
      if (missed >= this.options.maxMissedWsPongs) {
        console.warn(`[V4] 探活超时: ${this.clientIdOf(ws)}`);
        ws.terminate();
        continue;
      }
      this.missedWsPongs.set(ws, missed + 1);
      try {
        ws.ping();
      } catch (e) {}
    }
  }

  createClientId() {
    let clientId;
    const existing = new Set(this.wsToClientId.values());
    do {
      clientId = crypto.randomBytes(CLIENT_ID_BYTES).toString('hex');
    } while (existing.has(clientId));
    return clientId;
  }

  onConnection(ws, tid = undefined, requestedClientId = undefined) {
    let clientId;

    // 1. 如果是被控端 (手机 APP) 连入
    if (tid) {
      clientId = this.createClientId();
      this.sendFrame(ws, { type: 'hello', clientId });
      this.sockets.add(ws);
      this.wsToClientId.set(ws, clientId);
      this.clientsById.set(clientId, ws);
      this.missedWsPongs.set(ws, 0);
      this.attachClient(ws, clientId, tid);

      ws.on('message', (msg) => this.onMessage(ws, msg));
      ws.on('pong', () => this.missedWsPongs.set(ws, 0));
      ws.on('close', (code, reason) => this.onClose(ws, code, reason ? reason.toString() : ''));
      ws.on('error', (err) => console.error(`[V4 被控端] 连接错误 [${clientId}]:`, err.message));
      return;
    }

    // 2. 如果是控制端 (Web 前端) 连入：优先检查是否为刷新重连
    if (requestedClientId && this.reconnectingControllers.has(requestedClientId)) {
      const existing = this.reconnectingControllers.get(requestedClientId);
      clearTimeout(existing.timer);
      this.reconnectingControllers.delete(requestedClientId);

      clientId = requestedClientId;
      this.sockets.add(ws);
      this.wsToClientId.set(ws, clientId);
      this.controllersById.set(clientId, ws);
      this.controlledClients.set(ws, existing.clients);
      this.missedWsPongs.set(ws, 0);
      this.startIdleTimer(ws);

      this.sendFrame(ws, { type: 'hello', clientId });
      console.log(`[V4 页面刷新/重连保护] 控制端 ${clientId} 重连成功！恢复 ${existing.clients.size} 个被控端连接`);

      // 重新建立反向绑定并通知控制端
      for (const [cId, cWs] of existing.clients) {
        this.clientToController.set(cWs, ws);
        this.sendFrame(ws, { type: 'client_attached', clientId: cId });
      }

      ws.on('message', (msg) => this.onMessage(ws, msg));
      ws.on('pong', () => this.missedWsPongs.set(ws, 0));
      ws.on('close', (code, reason) => this.onClose(ws, code, reason ? reason.toString() : ''));
      ws.on('error', (err) => console.error(`[V4 控制端] 连接错误 [${clientId}]:`, err.message));
      return;
    }

    // 如果客户端携带了保存的 clientId 且当前未被占用，则复用以保证二维码不变
    if (requestedClientId && typeof requestedClientId === 'string' && /^[0-9a-fA-F]{8}$/.test(requestedClientId) && !this.controllersById.has(requestedClientId)) {
      clientId = requestedClientId.toLowerCase();
    } else {
      clientId = this.createClientId();
    }

    this.sendFrame(ws, { type: 'hello', clientId });
    this.sockets.add(ws);
    this.wsToClientId.set(ws, clientId);
    this.missedWsPongs.set(ws, 0);
    this.attachController(ws, clientId);

    ws.on('message', (msg) => this.onMessage(ws, msg));
    ws.on('pong', () => this.missedWsPongs.set(ws, 0));
    ws.on('close', (code, reason) => this.onClose(ws, code, reason ? reason.toString() : ''));
    ws.on('error', (err) => console.error(`[V4 控制端] 连接错误 [${clientId}]:`, err.message));
  }

  attachController(ws, clientId) {
    this.controllersById.set(clientId, ws);
    this.controlledClients.set(ws, new Map());
    this.startIdleTimer(ws);
    console.log(`[V4 控制端就绪] ClientId: ${clientId}`);
  }

  attachClient(ws, clientId, rawTid) {
    const tid = rawTid ? String(rawTid).trim().toLowerCase() : '';

    // 0. 优先检查目标是否为服务端内部的虚拟控制器
    if (this.virtualControllers.has(tid)) {
      this.clientToVirtualController.set(ws, tid);
      this.sendFrame(ws, { type: 'controller_attached', clientId: tid });
      const handler = this.virtualControllers.get(tid);
      console.log(`[V4 配对成功] 服务端虚拟控制器 [${tid}] 接入被控端 [${clientId}]`);
      try {
        handler?.onAttached?.(clientId);
      } catch (e) {
        console.error('[V4 虚拟控制器 onAttached 异常]:', e);
      }
      return;
    }

    let controllerWs = this.controllersById.get(tid);

    // 如果控制端正处于页面刷新临时掉线缓冲期 (60s 内)
    if (!controllerWs && this.reconnectingControllers.has(tid)) {
      const reconnecting = this.reconnectingControllers.get(tid);
      reconnecting.clients.set(clientId, ws);
      this.sendFrame(ws, { type: 'controller_attached', clientId: tid });
      console.log(`[V4 配对排队] 控制端 ${tid} 正在刷新重连，被控端 ${clientId} 已进入就绪队列`);
      return;
    }

    if (!controllerWs || controllerWs.readyState !== WebSocket.OPEN) {
      this.sendFrame(ws, { type: 'error', code: 'controller_not_found' });
      try { ws.close(CLOSE_CONTROLLER_NOT_FOUND, 'controller_not_found'); } catch (e) {}
      const activeIds = [...this.controllersById.keys()].join(', ') || '无';
      console.warn(`[V4 被控端拒绝] 目标控制端 [${tid}] 不在线 (当前在线控制端: ${activeIds})`);
      return;
    }

    const clients = this.controlledClients.get(controllerWs);
    if (!clients) {
      this.sendFrame(ws, { type: 'error', code: 'controller_not_found' });
      try { ws.close(CLOSE_CONTROLLER_NOT_FOUND, 'controller_not_found'); } catch (e) {}
      return;
    }

    clients.set(clientId, ws);
    this.clientToController.set(ws, controllerWs);
    this.cancelIdleTimer(controllerWs);

    // 官方通知
    this.sendFrame(ws, { type: 'controller_attached', clientId: tid });
    this.sendFrame(controllerWs, { type: 'client_attached', clientId });
    console.log(`[V4 配对成功] 控制端 ${tid} 接入被控端 ${clientId} (当前总连接: ${clients.size})`);
  }

  onMessage(ws, raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (parsed && typeof parsed === 'object') {
      if (parsed.type === 'ping') {
        this.sendFrame(ws, { type: 'pong', ts: Date.now() });
        return;
      }
      if (parsed.type === 'pong') return;

      const myId = this.wsToClientId.get(ws);
      if (!myId) return;

      // 1. 控制方发向被控方
      if (this.controllersById.has(myId)) {
        const tid = parsed.clientId;
        if (!tid) return;
        const targetWs = this.controlledClients.get(ws)?.get(tid);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          this.sendFrame(targetWs, { type: 'message', data: parsed.data });
        } else {
          this.sendFrame(ws, { type: 'error', code: 'client_not_found', clientId: tid });
        }
        return;
      }

      // 2. 被控方发向控制方
      const virtualTid = this.clientToVirtualController.get(ws);
      if (virtualTid) {
        const handler = this.virtualControllers.get(virtualTid);
        try {
          handler?.onMessage?.(myId, parsed.data);
        } catch (e) {
          console.error('[V4 虚拟控制器 onMessage 异常]:', e);
        }
        return;
      }

      const controllerWs = this.clientToController.get(ws);
      if (controllerWs && controllerWs.readyState === WebSocket.OPEN) {
        this.sendFrame(controllerWs, {
          type: 'message',
          clientId: myId,
          data: parsed.data
        });
      }
    }
  }

  onClose(ws, code, reason) {
    this.sockets.delete(ws);
    this.missedWsPongs.delete(ws);
    const clientId = this.wsToClientId.get(ws);
    this.wsToClientId.delete(ws);

    if (!clientId) return;
    this.clientsById.delete(clientId);

    // 检查是否为虚拟控制器所绑定的被控端断开
    const virtualTid = this.clientToVirtualController.get(ws);
    if (virtualTid) {
      this.clientToVirtualController.delete(ws);
      const handler = this.virtualControllers.get(virtualTid);
      console.log(`[V4 被控端断开] APP ClientId: ${clientId} (解除与服务端虚拟控制器 [${virtualTid}] 的绑定)`);
      try {
        handler?.onDisconnected?.(clientId);
      } catch (e) {
        console.error('[V4 虚拟控制器 onDisconnected 异常]:', e);
      }
      return;
    }

    if (this.controllersById.has(clientId)) {
      this.controllersById.delete(clientId);
      const clients = this.controlledClients.get(ws) || new Map();
      this.controlledClients.delete(ws);
      this.cancelIdleTimer(ws);

      // 如果有已绑定的 APP 客户端，开启 60 秒刷新重连保护期，绝不立刻杀掉 APP 连接！
      if (clients.size > 0) {
        console.log(`[V4 页面刷新/重连保护] 控制端 ${clientId} 断开，保持 ${clients.size} 个 APP 连接持续在线 (缓冲期 60s)...`);
        const timer = setTimeout(() => {
          this.reconnectingControllers.delete(clientId);
          console.warn(`[V4 控制端重连超时 (60s)] 彻底注销 ClientId: ${clientId}`);
          for (const [cId, cWs] of clients) {
            this.clientToController.delete(cWs);
            this.sendFrame(cWs, { type: 'controller_disconnected', clientId });
            try {
              cWs.close(CLOSE_CONTROLLER_DISCONNECTED, 'controller_disconnected');
            } catch (e) {}
          }
        }, 60000);

        this.reconnectingControllers.set(clientId, { clients, timer, disconnectTime: Date.now() });
      } else {
        console.log(`[V4 控制端断开 (无绑定被控端)] ${clientId}`);
      }
      return;
    }

    const controllerWs = this.clientToController.get(ws);
    if (controllerWs) {
      this.clientToController.delete(ws);
      const clients = this.controlledClients.get(controllerWs);
      clients?.delete(clientId);

      if (controllerWs.readyState === WebSocket.OPEN) {
        this.sendFrame(controllerWs, { type: 'client_disconnected', clientId });
        if (!clients || clients.size === 0) this.startIdleTimer(controllerWs);
      }
      console.log(`[V4 被控端断开] ${clientId}`);
    }
  }

  startIdleTimer(controllerWs) {
    this.cancelIdleTimer(controllerWs);
    const timer = setTimeout(() => {
      this.idleTimers.delete(controllerWs);
      if (controllerWs.readyState === WebSocket.OPEN) {
        this.sendFrame(controllerWs, { type: 'idle_timeout' });
        try {
          controllerWs.close(CLOSE_IDLE_TIMEOUT, 'idle_timeout');
        } catch (e) {}
      }
    }, this.options.idleTimeoutMs);
    this.idleTimers.set(controllerWs, timer);
  }

  cancelIdleTimer(controllerWs) {
    const timer = this.idleTimers.get(controllerWs);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(controllerWs);
    }
  }
}

module.exports = V4RelayServer;
