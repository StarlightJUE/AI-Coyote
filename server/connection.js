class ConnectionManager {
  constructor() {
    // 存储所有连接：clientId -> { ws, type, createdAt, lastHeartbeat }
    this.connections = new Map();
    // 网页端 clientId -> APP 端 targetId
    this.pairings = new Map();
    // APP 端 targetId -> 网页端 clientId
    this.reversePairings = new Map();
  }

  register(ws, clientId, type = 'unknown') {
    this.connections.set(clientId, {
      ws,
      type,
      createdAt: new Date(),
      lastHeartbeat: new Date(),
    });
    console.log(`[连接注册] ${clientId} (${type})`);
  }

  getClient(clientId) {
    return this.connections.get(clientId) || null;
  }

  hasClient(clientId) {
    return this.connections.has(clientId);
  }

  pair(webClientId, appClientId) {
    if (!this.hasClient(webClientId) || !this.hasClient(appClientId)) {
      return {
        success: false,
        code: '401',
        message: '客户端未连接'
      };
    }

    if (this.pairings.has(webClientId) || this.reversePairings.has(appClientId)) {
      return {
        success: false,
        code: '400',
        message: '客户端已被配对'
      };
    }

    this.pairings.set(webClientId, appClientId);
    this.reversePairings.set(appClientId, webClientId);

    console.log(`[配对成功] 控制端 ${webClientId} ↔ APP端 ${appClientId}`);

    return {
      success: true,
      code: '200',
      message: '配对成功',
      webClientId,
      appClientId
    };
  }

  unpair(clientId) {
    let appClientId = this.pairings.get(clientId);
    let webClientId = clientId;

    if (!appClientId) {
      webClientId = this.reversePairings.get(clientId);
      appClientId = clientId;
    }

    if (webClientId && appClientId) {
      this.pairings.delete(webClientId);
      this.reversePairings.delete(appClientId);
      console.log(`[解除配对] ${webClientId} ↔ ${appClientId}`);
      return { success: true, webClientId, appClientId };
    }

    return { success: false };
  }

  isPaired(clientId1, clientId2) {
    return (
      this.pairings.get(clientId1) === clientId2 ||
      this.reversePairings.get(clientId1) === clientId2
    );
  }

  getPair(clientId) {
    return this.pairings.get(clientId) || this.reversePairings.get(clientId) || null;
  }

  disconnect(clientId) {
    const unpairResult = this.unpair(clientId);

    if (unpairResult.success) {
      const otherId = unpairResult.webClientId === clientId ? unpairResult.appClientId : unpairResult.webClientId;
      const otherClient = this.getClient(otherId);

      if (otherClient && otherClient.ws && otherClient.ws.readyState === 1) {
        const breakMsg = {
          type: 'break',
          clientId: otherId,
          targetId: clientId,
          message: '209'
        };
        try {
          otherClient.ws.send(JSON.stringify(breakMsg));
        } catch (e) {
          console.error(`发送断开通知失败: ${e.message}`);
        }
      }
    }

    this.connections.delete(clientId);
    console.log(`[连接断开] ${clientId}`);
  }

  getAllClients() {
    return Array.from(this.connections.entries()).map(([id, info]) => ({
      id,
      type: info.type,
      pairedWith: this.getPair(id)
    }));
  }
}

module.exports = new ConnectionManager();
