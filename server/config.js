const path = require('path');
const fs = require('fs');
const os = require('os');

// 获取当前主机的所有局域网活动 IPv4 地址
function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// 自动加载 .env 环境变量文件
function loadEnv() {
  const envPaths = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(process.cwd(), '.env')
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      if (typeof process.loadEnvFile === 'function') {
        try {
          process.loadEnvFile(p);
          console.log('[Config] 已加载环境变量:', p);
          return;
        } catch (e) {
          // fallback
        }
      }
      try {
        const content = fs.readFileSync(p, 'utf8');
        content.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const idx = trimmed.indexOf('=');
            if (idx !== -1) {
              const key = trimmed.slice(0, idx).trim();
              const val = trimmed.slice(idx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
              if (process.env[key] === undefined) {
                process.env[key] = val;
              }
            }
          }
        });
        console.log('[Config] 已加载环境变量(解析):', p);
        return;
      } catch (e) {}
    }
  }
}
loadEnv();

module.exports = {
  // 高位 WebSocket (WSS / WS) 端口
  wsPort: parseInt(process.env.WS_PORT || '54321', 10),

  // 前端 HTTPS 端口
  httpsPort: parseInt(process.env.HTTPS_PORT || '443', 10),

  // 前端明文 HTTP 端口 (默认 80 重定向到 HTTPS；DISABLE_SSL 时为 Web 服务主端口)
  httpPort: parseInt(process.env.HTTP_PORT || '80', 10),

  // 绑定 IP
  host: process.env.HOST || '0.0.0.0',

  // 域名配置 (客户端无 Host 请求头时的默认回退域名)
  domain: process.env.DOMAIN || 'localhost',

  // 局域网活动 IP 列表
  localIps: getLocalIps(),
  getLocalIps,

  // 服务级代理配置 (按需分流，零硬编码全局劫持)
  proxy: {
    gemini: process.env.GEMINI_PROXY || process.env.GLOBAL_PROXY || '',
    deepseek: process.env.DEEPSEEK_PROXY || '',
    global: process.env.GLOBAL_PROXY || ''
  },

  // SSL 证书路径与多层级弹性策略
  ssl: {
    disabled: process.env.DISABLE_SSL === 'true',
    allowSelfSigned: process.env.ALLOW_SELF_SIGNED !== 'false',
    certPath: process.env.SSL_CERT_PATH ? path.resolve(process.env.SSL_CERT_PATH) : path.resolve(__dirname, '../certs/fullchain.pem'),
    keyPath: process.env.SSL_KEY_PATH ? path.resolve(process.env.SSL_KEY_PATH) : path.resolve(__dirname, '../certs/privkey.key'),
    accountKeyPath: path.resolve(__dirname, '../certs/account.key'),
    renewDays: parseInt(process.env.SSL_RENEW_DAYS || '7', 10),
    domains: (process.env.SSL_DOMAINS || (process.env.DOMAIN ? `${process.env.DOMAIN},*.${process.env.DOMAIN}` : 'localhost')).split(',').map(d => d.trim()).filter(Boolean),
    cfEmail: process.env.CF_EMAIL || '',
    cfApiKey: process.env.CF_API_KEY || '',
    cfZoneId: process.env.CF_ZONE_ID || ''
  },

  // 消息与心跳控制
  message: {
    heartbeatInterval: 60000,
    defaultPunishmentDuration: 5, // 默认波形发送时长（秒）
    defaultPunishmentTime: 1,     // 每秒发送次数
    maxMessageLength: 1950,       // APP 允许的最大单条消息长度
  }
};
