const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

// 全局日志自动添加统一时间戳 [HH:mm:ss]
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
function getLogTime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}
console.log = (...args) => _origLog(getLogTime(), ...args);
console.warn = (...args) => _origWarn(getLogTime(), ...args);
console.error = (...args) => _origError(getLogTime(), ...args);

const config = require('./config');
const connectionManager = require('./connection');
const messageRouter = require('./message');
const timerManager = require('./timer');
const V4RelayServer = require('./v4-relay');
const CoyoteDeviceHub = require('./coyote-device-hub');
const ai = require('./ai');

// 实例化官方 V4 Relay 与 服务端设备 Hub (持久化维护设备状态与底波引擎)
const v4Relay = new V4RelayServer();
v4Relay.start();
const coyoteDeviceHub = new CoyoteDeviceHub(v4Relay);

// SSL 证书管理器与上下文
const sslManager = require('./ssl-manager');
let sslOptions = null;
let wsServerInstance = null;
let webServer = null;
const wss = new WebSocket.Server({ noServer: true });

function applySslContext(newCert, newKey) {
  sslOptions = {
    cert: newCert,
    key: newKey
  };
  try {
    if (wsServerInstance && typeof wsServerInstance.setSecureContext === 'function') {
      wsServerInstance.setSecureContext(sslOptions);
    }
    if (webServer && typeof webServer.setSecureContext === 'function') {
      webServer.setSecureContext(sslOptions);
    }
    console.log('[SSL] 新证书已成功热应用至当前运行中的 HTTPS 与 WSS 服务！');
  } catch (err) {
    console.error('[SSL] 热重载证书上下文失败:', err.message);
  }
}

// 2. 启动前端 Web 服务 (443 HTTPS + 80 HTTP 重定向)
const publicDir = path.resolve(__dirname, '../public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function handleHttpRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url.split('?')[0];
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host || config.domain || 'localhost';
  const clientHost = rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.split(':')[0];
  const isRequestSecure = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') && !!sslOptions;

  if (urlPath === '/api/config') {
    const protocol = isRequestSecure ? 'wss' : 'ws';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      domain: config.domain,
      currentHost: clientHost,
      localIps: config.localIps,
      wsPort: config.wsPort,
      isSecure: isRequestSecure,
      protocol,
      wsUrl: `${protocol}://${clientHost}:${config.wsPort}`,
      v4WsUrl: `${protocol}://${clientHost}:${config.wsPort}/v4`
    }));
    return;
  }

  if (urlPath === '/api/prompts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      data: ai.promptManager.getPresetsList()
    }));
    return;
  }

  if (urlPath === '/api/prompt' && req.method === 'GET') {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pid = parsedUrl.searchParams.get('id');
    const sid = parsedUrl.searchParams.get('sid');
    let content = '';

    if (pid) {
      content = ai.promptManager.getPresetContent(pid);
    } else if (sid) {
      const s = ai.sessionManager.getSession(sid);
      if (s.promptId === 'custom') {
        content = s.customPrompt || '';
      } else {
        content = ai.promptManager.getPresetContent(s.promptId || 'succubus');
      }
    } else {
      content = ai.promptManager.getDefaultPrompt();
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      prompt: content,
      defaultProvider: 'deepseek',
      providers: ['deepseek', 'gemini']
    }));
    return;
  }

  if (urlPath === '/api/prompt/contract' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      contract: ai.promptManager.getBaseContract()
    }));
    return;
  }

  if (urlPath === '/api/prompt/custom' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const sid = data.sid || 'default';
        const pid = data.promptId || 'custom';
        const persona = pid === 'custom' ? (data.prompt || '').trim() : '';
        ai.sessionManager.updateSessionProfile(sid, {
          promptId: pid,
          customPrompt: persona
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, prompt: persona }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (urlPath === '/api/session' && req.method === 'GET') {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const sid = parsedUrl.searchParams.get('sid') || 'default';
    const s = ai.sessionManager.getSession(sid);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: s }));
    return;
  }

  if (urlPath === '/api/session/reset' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const sid = data.sid || 'default';
        ai.sessionManager.resetSession(sid);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (urlPath === '/api/session/profile' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const sid = data.sid || 'default';
        const s = ai.sessionManager.updateSessionProfile(sid, data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: s }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 设备状态与控制 REST & SSE 端点
  if (urlPath === '/api/device/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: coyoteDeviceHub.getState(clientHost, isRequestSecure) }));
    return;
  }

  if (urlPath === '/api/device/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    coyoteDeviceHub.addSseClient(res, clientHost, isRequestSecure);
    return;
  }

  if (urlPath === '/api/device/action' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const op = payload.op;
        const channel = payload.channel || 'A';
        let result = null;

        switch (op) {
          case 'adjust':
            result = coyoteDeviceHub.adjustStrength(channel, payload.delta || 0);
            break;
          case 'set':
            result = coyoteDeviceHub.setStrength(channel, payload.value || 0);
            break;
          case 'zero':
            coyoteDeviceHub.setStrength(channel, 0);
            coyoteDeviceHub.clearChannel(channel);
            break;
          case 'clear':
            coyoteDeviceHub.clearChannel(channel);
            break;
          case 'pulse':
            if (channel === 'AB') {
              coyoteDeviceHub.playWave('A', payload.pattern, payload.duration || 3);
              coyoteDeviceHub.playWave('B', payload.pattern, payload.duration || 3);
            } else {
              coyoteDeviceHub.playWave(channel, payload.pattern, payload.duration || 3);
            }
            break;
          case 'bg_wave':
            const subOp = payload.subOp;
            if (subOp === 'start') {
              coyoteDeviceHub.startBgWave(channel, payload.pattern || '呼吸', payload.intervalMs || 3000);
            } else if (subOp === 'pause') {
              coyoteDeviceHub.pauseBgWave(channel);
            } else if (subOp === 'resume') {
              coyoteDeviceHub.resumeBgWave(channel);
            } else if (subOp === 'stop') {
              coyoteDeviceHub.stopBgWave(channel);
            }
            break;
          case 'panic':
          case 'emergency_stop':
            coyoteDeviceHub.emergencyStop();
            break;
          case 'set_protocol':
            result = coyoteDeviceHub.setProtocol(payload.protocol);
            break;
          case 'regenerate_qr':
            result = coyoteDeviceHub.regenerateQr(payload.customHost || clientHost, isRequestSecure);
            break;
          case 'disconnect':
            coyoteDeviceHub.disconnectCurrent('user_disconnect');
            break;
          default:
            throw new Error(`未知操作类型: ${op}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, result, state: coyoteDeviceHub.getState(clientHost, isRequestSecure) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (urlPath === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');

        // 注入 WebSocket 服务端实时维护的真实硬件通道强度与 APP 安全软上限
        const devState = coyoteDeviceHub.getState();
        const clientState = payload.state || {};
        payload.state = {
          nickname: clientState.nickname || '小明',
          mapping: clientState.mapping || 'A=大腿内侧、B=腰部',
          strengthA: devState.isConnected ? devState.channelA.strength : (clientState.strengthA ?? 0),
          softLimitA: devState.isConnected ? devState.channelA.softLimit : (clientState.softLimitA ?? devState.channelA.softLimit ?? 200),
          strengthB: devState.isConnected ? devState.channelB.strength : (clientState.strengthB ?? 0),
          softLimitB: devState.isConnected ? devState.channelB.softLimit : (clientState.softLimitB ?? devState.channelB.softLimit ?? 200)
        };

        // 支持 SSE 流式传输
        if (payload.stream !== false) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
          await ai.handleChatStream(payload, (event, data) => {
            if (event === 'done' && data && Array.isArray(data.actions)) {
              // 由服务端设备 Hub 直接执行 AI 下发的所有波形与强度动作！
              coyoteDeviceHub.executeActions(data.actions);
            }
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          });
          res.end();
          return;
        }

        const result = await ai.handleChat(payload);
        if (result && Array.isArray(result.actions)) {
          coyoteDeviceHub.executeActions(result.actions);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: result }));
      } catch (err) {
        console.error('[API /api/chat Error]:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  let safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';

  const filePath = path.join(publicDir, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}



// 3. 经典 V3 协议处理器
function handleV3Connection(ws, req) {
  const clientId = crypto.randomUUID();
  connectionManager.register(ws, clientId, 'unknown');

  const initMsg = {
    type: 'bind',
    clientId,
    targetId: '',
    message: 'targetId'
  };

  try {
    ws.send(JSON.stringify(initMsg));
  } catch (err) {}

  ws.on('message', (raw) => {
    const rawStr = raw.toString('utf8');
    const { valid, code, data } = messageRouter.validate(rawStr);

    if (!valid) {
      try {
        ws.send(JSON.stringify({ type: 'msg', clientId: '', targetId: '', message: String(code) }));
      } catch (e) {}
      return;
    }

    // 优先检查是否为连接到服务端设备 Hub 的 V3 APP
    if (coyoteDeviceHub.protocol === 'v3' && coyoteDeviceHub.isTargetOfV3(data.targetId, data.clientId)) {
      if (data.type === 'bind') {
        coyoteDeviceHub.handleV3AppBind(data.clientId, ws);
        return;
      }
      coyoteDeviceHub.handleV3AppMessage(data.message || rawStr);
      return;
    }

    switch (data.type) {
      case 'bind':
        messageRouter.handleBind(data, ws);
        break;
      case 1:
      case 2:
      case 3:
        messageRouter.handleStrengthAdjust(data, ws);
        break;
      case 4:
        messageRouter.handleCustomCommand(data, ws, timerManager);
        break;
      case 'clientMsg':
        messageRouter.handleClientMessage(data, ws, timerManager);
        break;
      default:
        messageRouter.forwardMessage(data, ws);
        break;
    }
  });

  ws.on('close', (code) => {
    if (coyoteDeviceHub.v3ClientWs === ws) {
      coyoteDeviceHub.handleV3AppClose(ws);
    }
    timerManager.clearClientTimers(clientId);
    connectionManager.disconnect(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[V3 错误] ${clientId}:`, err.message);
  });
}

// 全局心跳广播 (仅向经典 V3 连接广播，避免破坏官方 V4 协议帧)
setInterval(() => {
  const heartbeatMsg = JSON.stringify({
    type: 'heartbeat',
    clientId: '',
    targetId: '',
    message: '200'
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && !v4Relay.sockets.has(client)) {
      try {
        client.send(heartbeatMsg);
      } catch (e) {}
    }
  });
}, config.message.heartbeatInterval);

// 启动服务主流程（含证书检查、自动续期与热重载）
async function startServers() {
  // 1. 启动检查本地证书状态与有效期
  if (config.ssl.disabled) {
    console.log('[SSL] DISABLE_SSL=true，已显式关闭 SSL/TLS 加密支持，将以纯明文 HTTP/WS 模式运行');
    sslOptions = null;
  } else {
    const certStatus = sslManager.checkCertificateStatus(config.ssl.certPath, config.ssl.keyPath);

    if (certStatus.exists && certStatus.valid) {
      sslOptions = {
        cert: fs.readFileSync(config.ssl.certPath),
        key: fs.readFileSync(config.ssl.keyPath)
      };
      console.log(`[SSL] 已成功加载本地证书: ${config.ssl.certPath}`);
      console.log(`[SSL] 证书覆盖范围: [${[...certStatus.domains, ...certStatus.ips].join(', ')}] | 剩余有效期: ${certStatus.daysRemaining.toFixed(1)} 天 (自动续期阈值: ${config.ssl.renewDays} 天)`);

      // 若剩余天数小于阈值（默认 7 天）或主域名不匹配，在后台自动触发续期并热应用
      if (certStatus.daysRemaining < config.ssl.renewDays || !certStatus.matchesDomain) {
        console.log(`[SSL] 证书剩余有效期不足 ${config.ssl.renewDays} 天或域名不匹配，正在后台自动触发续期流程...`);
        sslManager.ensureValidCertificate({
          onRenewed: ({ cert, key }) => applySslContext(cert, key)
        }).catch(err => {
          console.error('[SSL] 后台自动续期异常:', err.message);
        });
      }
    } else {
      // 本地未找到有效证书或已过期，在启动监听前完成首次自动签发
      console.log(`[SSL] 本地未发现有效证书 (${certStatus.reason})，正在执行证书自动准备流程...`);
      try {
        const result = await sslManager.ensureValidCertificate({
          onRenewed: ({ cert, key }) => applySslContext(cert, key)
        });
        if (result && result.cert && result.key) {
          sslOptions = {
            cert: result.cert,
            key: result.key
          };
          console.log(`[SSL] 证书准备就绪并成功加载！`);
        }
      } catch (err) {
        console.error(`[SSL] 自动准备证书失败: ${err.message}`);
        console.warn(`[SSL] 将以降级明文 HTTP/WS 模式启动服务`);
      }
    }
  }

  // 2. 启动高位端口 WebSocket (WS / WSS) 服务 (54321)
  const onWsUpgrade = (req, socket, head) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const tid = parsedUrl.searchParams.get('targetId') || parsedUrl.searchParams.get('tid') || undefined;
    const cid = parsedUrl.searchParams.get('clientId') || parsedUrl.searchParams.get('cid') || undefined;
    const isV4 = parsedUrl.pathname.includes('/v4') || tid !== undefined || parsedUrl.searchParams.get('protocol') === 'v4';

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (isV4) {
        v4Relay.onConnection(ws, tid, cid);
      } else {
        handleV3Connection(ws, req);
      }
    });
  };

  const httpWsServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('DG-LAB Coyote V4 & V3 WS Service Running');
  });
  httpWsServer.on('upgrade', onWsUpgrade);

  if (sslOptions) {
    const httpsWsServer = https.createServer(sslOptions, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('DG-LAB Coyote V4 & V3 WSS Service Running');
    });
    httpsWsServer.on('upgrade', onWsUpgrade);
    wsServerInstance = httpsWsServer;

    // 单端口智能分流：纯 IP / 明文请求走 ws://，TLS 请求走 wss:// (完美支持纯 IP 无证书接入)
    const wsDualServer = net.createServer((socket) => {
      socket.once('data', (buf) => {
        socket.pause();
        const target = (buf[0] === 0x16 && httpsWsServer) ? httpsWsServer : httpWsServer;
        socket.unshift(buf);
        target.emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
      socket.on('error', () => {});
    });

    wsDualServer.listen(config.wsPort, config.host, () => {
      console.log(`[WS/WSS] 双栈 WebSocket 服务已就绪: ${config.host}:${config.wsPort} (同端口无缝兼容 ws:// 纯IP直连与 wss:// 加密)`);
    });
  } else {
    wsServerInstance = httpWsServer;
    httpWsServer.listen(config.wsPort, config.host, () => {
      console.log(`[WS] WebSocket 服务已就绪 (纯明文模式): ws://${config.host}:${config.wsPort}`);
    });
  }

  // 3. 启动前端 Web 服务 (HTTPS 443 + HTTP 80/8080)
  if (sslOptions) {
    webServer = https.createServer(sslOptions, handleHttpRequest);

    const redirectPort = config.httpPort || 80;
    const httpEntryServer = http.createServer((req, res) => {
      const rawHost = req.headers['x-forwarded-host'] || req.headers.host || '';
      const hostHeader = rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.split(':')[0];
      const isIpOrLocal = !hostHeader || net.isIP(hostHeader) !== 0 || hostHeader === 'localhost';

      // 纯 IP 或 localhost 访问时直接提供明文 HTTP Web 界面，不强跳 HTTPS（避免浏览器和 APP 无证书证书报错）
      if (isIpOrLocal) {
        return handleHttpRequest(req, res);
      }

      // 域名访问且已开启 SSL 时自动 301 重定向至 HTTPS
      const targetPort = config.httpsPort === 443 ? '' : `:${config.httpsPort}`;
      const targetUrl = `https://${hostHeader}${targetPort}${req.url}`;
      res.writeHead(301, { 'Location': targetUrl });
      res.end(`Redirecting to ${targetUrl}`);
    });

    httpEntryServer.on('error', (err) => {
      console.warn(`[HTTP ${redirectPort}] 明文 HTTP 端口启动受限: ${err.message}`);
    });

    httpEntryServer.listen(redirectPort, config.host, () => {
      console.log(`[HTTP ${redirectPort}] 明文 Web 智能接入服务已启动 (纯IP直接访问，域名自动重定向至 HTTPS)`);
    });
  } else {
    webServer = http.createServer(handleHttpRequest);
  }

  const webPort = sslOptions ? config.httpsPort : (config.httpPort || 8080);
  webServer.listen(webPort, config.host, () => {
    const proto = sslOptions ? 'https' : 'http';
    const portSuffix = (proto === 'https' && webPort === 443) || (proto === 'http' && webPort === 80) ? '' : `:${webPort}`;
    console.log(`[Web] 前端控制台已就绪:`);
    if (sslOptions) {
      console.log(`  - 域名 HTTPS 访问: https://${config.domain}${portSuffix}`);
    }
    console.log(`  - 纯 IP / 局域网访问 (免证书): http://${config.localIps[0] || '127.0.0.1'}:${config.httpPort || 80}`);
    console.log(`  - 本地回环 (免证书): http://localhost:${config.httpPort || 80}`);
  });

  // 4. 定时证书检查与热续期（每 12 小时检查一次）
  if (!config.ssl.disabled) {
    setInterval(() => {
      sslManager.ensureValidCertificate({
        onRenewed: ({ cert, key }) => applySslContext(cert, key)
      }).catch(err => {
        console.error('[SSL] 定时检查续期失败:', err.message);
      });
    }, 12 * 60 * 60 * 1000);
  }
}

startServers();

