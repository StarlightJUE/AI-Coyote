const connectionManager = require('./connection');
const config = require('./config');

class MessageRouter {
  validate(rawMessage) {
    let data = null;
    try {
      data = JSON.parse(rawMessage);
    } catch (e) {
      return {
        valid: false,
        code: '403',
        message: '期望 JSON 格式',
        data: null
      };
    }

    if (!data.type || !data.clientId || !data.message || (data.type !== 'bind' && !data.targetId)) {
      return {
        valid: false,
        code: '404',
        message: '消息缺少必需字段',
        data: null
      };
    }

    return { valid: true, data };
  }

  validateSource(clientId, ws) {
    const client = connectionManager.getClient(clientId);
    return client && client.ws === ws;
  }

  handleBind(data, ws) {
    const { clientId, targetId } = data;

    // 配对：clientId 为发起方/控制端 ID，targetId 为扫码 APP 端 ID
    const result = connectionManager.pair(clientId, targetId);

    if (result.success) {
      const bindSuccessMsg = {
        type: 'bind',
        clientId,
        targetId,
        message: '200'
      };

      // 通知 APP 端
      try {
        ws.send(JSON.stringify(bindSuccessMsg));
      } catch (err) {
        console.error(`向 APP 发送绑定确认失败: ${err.message}`);
      }

      // 通知控制端
      const webClient = connectionManager.getClient(clientId);
      if (webClient && webClient.ws && webClient.ws !== ws) {
        try {
          webClient.ws.send(JSON.stringify(bindSuccessMsg));
        } catch (err) {
          console.error(`向控制端发送绑定确认失败: ${err.message}`);
        }
      }
    }

    return result;
  }

  // 处理强度增减与指定值 (type 1: -1, type 2: +1, type 3: 指定值)
  handleStrengthAdjust(data, ws) {
    const { clientId, targetId, type, channel, strength } = data;

    if (!connectionManager.isPaired(clientId, targetId)) {
      return { success: false, code: '402', message: '未建立配对关系' };
    }

    const sendType = parseInt(type, 10) - 1; // 0=减, 1=增, 2=设为指定值
    const sendChannel = channel || 1;
    const sendStrength = parseInt(type, 10) >= 3 ? (strength || 0) : 1;

    const strengthMessage = `strength-${sendChannel}+${sendType}+${sendStrength}`;

    const targetClient = connectionManager.getClient(targetId);
    if (targetClient && targetClient.ws) {
      try {
        targetClient.ws.send(JSON.stringify({
          type: 'msg',
          clientId,
          targetId,
          message: strengthMessage
        }));
        console.log(`[下发强度] ${strengthMessage}`);
        return { success: true, code: '200' };
      } catch (err) {
        console.error(`发送强度失败: ${err.message}`);
        return { success: false, code: '500' };
      }
    }
    return { success: false, code: '404' };
  }

  // 直接转发 APP 原生指令（如 clear-1 / clear-2）
  handleCustomCommand(data, ws, timerManager) {
    const { clientId, targetId, message, channel: dataChannel, strength: dataStrength } = data;
    const sendChannel = dataChannel || 1;

    if (!connectionManager.isPaired(clientId, targetId)) {
      return { success: false, code: '402', message: '未建立配对关系' };
    }

    const targetClient = connectionManager.getClient(targetId);
    if (!targetClient || !targetClient.ws) {
      return { success: false, code: '404' };
    }

    if (message && message.includes('clear')) {
      const clearMsg = `clear-${sendChannel}`;
      try {
        targetClient.ws.send(JSON.stringify({
          type: 'msg',
          clientId,
          targetId,
          message: clearMsg
        }));
      } catch (e) {}

      const channelLetter = sendChannel === 1 ? 'A' : 'B';
      if (timerManager) {
        timerManager.clearTimer(clientId, channelLetter, ws);
      }

      try {
        ws.send(JSON.stringify({
          type: 'notify',
          clientId,
          targetId,
          message: `通道 ${channelLetter} 队列已清空`
        }));
      } catch (e) {}

      return { success: true, code: '200' };
    }

    // 指定强度
    const sendStrength = dataStrength || 0;
    const strengthMsg = `strength-${sendChannel}+2+${sendStrength}`;
    try {
      targetClient.ws.send(JSON.stringify({
        type: 'msg',
        clientId,
        targetId,
        message: strengthMsg
      }));
      return { success: true, code: '200' };
    } catch (e) {
      return { success: false, code: '500' };
    }
  }

  // 发送波形数据
  handleClientMessage(data, ws, timerManager) {
    const { clientId, targetId, channel, message, time } = data;

    if (!connectionManager.isPaired(clientId, targetId)) {
      return { success: false, code: '402', message: '未建立配对关系' };
    }

    if (!channel) {
      return { success: false, code: '406', message: '缺少 channel' };
    }

    const targetClient = connectionManager.getClient(targetId);
    if (!targetClient || !targetClient.ws) {
      return { success: false, code: '404' };
    }

    const sendDuration = time || config.message.defaultPunishmentDuration;
    const totalSends = config.message.defaultPunishmentTime * sendDuration;
    const timeSpace = 1000 / config.message.defaultPunishmentTime;

    const pulseMessage = {
      type: 'msg',
      clientId,
      targetId,
      message: `pulse-${message}`
    };

    timerManager.sendMessage(clientId, channel, targetClient.ws, pulseMessage, totalSends, timeSpace, ws);

    return {
      success: true,
      code: '200',
      message: '波形已排队发送'
    };
  }

  // APP 状态上报（强度/按钮等）转发回控制端
  forwardMessage(data, ws) {
    const { clientId, targetId, type, message } = data;

    if (!connectionManager.isPaired(clientId, targetId)) {
      return { success: false, code: '402' };
    }

    const recipient = connectionManager.getClient(clientId);
    if (recipient && recipient.ws && recipient.ws.readyState === 1) {
      try {
        recipient.ws.send(JSON.stringify({
          type: type || 'msg',
          clientId,
          targetId,
          message
        }));
        return { success: true, code: '200' };
      } catch (err) {
        return { success: false, code: '500' };
      }
    }
    return { success: false, code: '404' };
  }
}

module.exports = new MessageRouter();
