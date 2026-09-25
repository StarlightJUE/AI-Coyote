class TimerManager {
  constructor() {
    // 存储格式：`${clientId}-${channel}` -> timerTask
    this.timers = new Map();
  }

  sendMessage(clientId, channel, targetWs, message, totalSends, timeSpace, sourceWs) {
    const timerKey = `${clientId}-${channel}`;

    if (this.timers.has(timerKey)) {
      console.log(`[Timer] 通道 ${channel} 已有波形任务，清除旧任务重新发送`);
      const oldTask = this.timers.get(timerKey);
      this.clearTimer(clientId, channel, oldTask.sourceWs);

      const clearMessage = {
        type: 'msg',
        clientId: clientId,
        targetId: oldTask.message.targetId,
        message: `clear-${channel === 'A' ? '1' : '2'}`
      };

      try {
        targetWs.send(JSON.stringify(clearMessage));
      } catch (err) {
        console.error(`发送清除指令失败: ${err.message}`);
      }

      setTimeout(() => {
        this._startSending(clientId, channel, targetWs, message, totalSends, timeSpace, sourceWs);
      }, 150);

      if (sourceWs && sourceWs.readyState === 1) {
        try {
          sourceWs.send(JSON.stringify({
            type: 'notify',
            clientId,
            targetId: '',
            message: `当前通道${channel}有正在发送的消息，已自动覆盖`
          }));
        } catch (e) {}
      }
      return;
    }

    this._startSending(clientId, channel, targetWs, message, totalSends, timeSpace, sourceWs);
  }

  _startSending(clientId, channel, targetWs, message, totalSends, timeSpace, sourceWs) {
    const timerKey = `${clientId}-${channel}`;
    const timerTask = {
      clientId,
      channel,
      targetWs,
      sourceWs,
      message: JSON.parse(JSON.stringify(message)),
      remaining: totalSends,
      timeSpace,
      timerId: null
    };

    this._safeSend(targetWs, message);
    timerTask.remaining--;

    if (timerTask.remaining > 0) {
      const timerId = setInterval(() => {
        if (targetWs.readyState !== 1) {
          this.clearTimer(clientId, channel, sourceWs);
          return;
        }

        if (timerTask.remaining <= 0) {
          this.clearTimer(clientId, channel, sourceWs);
          if (sourceWs && sourceWs.readyState === 1) {
            try {
              sourceWs.send(JSON.stringify({
                type: 'notify',
                clientId,
                targetId: message.targetId || '',
                message: `通道${channel}波形发送完毕`
              }));
            } catch (e) {}
          }
          return;
        }

        this._safeSend(targetWs, timerTask.message);
        timerTask.remaining--;
      }, timeSpace);

      timerTask.timerId = timerId;
      this.timers.set(timerKey, timerTask);
    } else {
      if (sourceWs && sourceWs.readyState === 1) {
        try {
          sourceWs.send(JSON.stringify({
            type: 'notify',
            clientId,
            targetId: message.targetId || '',
            message: `通道${channel}波形发送完毕`
          }));
        } catch (e) {}
      }
    }
  }

  _safeSend(ws, data) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      } catch (err) {
        console.error(`发送波形帧异常: ${err.message}`);
      }
    }
  }

  clearTimer(clientId, channel, sourceWs = null) {
    const timerKey = `${clientId}-${channel}`;
    const task = this.timers.get(timerKey);
    if (task) {
      if (task.timerId) {
        clearInterval(task.timerId);
      }
      this.timers.delete(timerKey);
      console.log(`[Timer] 清除定时器: ${timerKey}`);
      return true;
    }
    return false;
  }

  clearClientTimers(clientId) {
    this.clearTimer(clientId, 'A');
    this.clearTimer(clientId, 'B');
  }
}

module.exports = new TimerManager();
