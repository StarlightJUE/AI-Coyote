const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const acme = require('acme-client');
const forge = require('node-forge');
const config = require('./config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 解析并检查本地证书状态与剩余有效天数
 * @param {string} certPath 证书路径
 * @param {string} keyPath 私钥路径
 */
function checkCertificateStatus(certPath = config.ssl.certPath, keyPath = config.ssl.keyPath) {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    return {
      exists: false,
      valid: false,
      daysRemaining: 0,
      expiresAt: null,
      domains: [],
      ips: [],
      matchesDomain: false,
      reason: '本地证书或私钥文件不存在'
    };
  }

  try {
    const certPem = fs.readFileSync(certPath, 'utf8');
    const x509 = new crypto.X509Certificate(certPem);
    const expiresAt = new Date(x509.validTo);
    const daysRemaining = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    // 解析 SAN (Subject Alternative Name) 中的 DNS 与 IP 列表
    const domains = [];
    const ips = [];
    if (x509.subjectAltName) {
      const parts = x509.subjectAltName.split(',');
      for (const p of parts) {
        const trimmed = p.trim();
        if (trimmed.startsWith('DNS:')) {
          domains.push(trimmed.slice(4).trim());
        } else if (trimmed.startsWith('IP Address:')) {
          ips.push(trimmed.slice(11).trim());
        }
      }
    }

    // 检查是否覆盖主域名、通配符、localhost 或局域网环境
    const targetPrimary = (config.ssl.domains && config.ssl.domains[0]) || config.domain || 'localhost';
    const isLocalTarget = targetPrimary === 'localhost' || targetPrimary === '127.0.0.1';
    const matchesDomain = domains.includes(targetPrimary)
      || domains.some(d => d.startsWith('*.') && targetPrimary.endsWith(d.slice(2)))
      || (isLocalTarget && (domains.includes('localhost') || ips.includes('127.0.0.1')))
      || domains.includes('localhost')
      || (x509.subject && x509.subject.includes(`CN=${targetPrimary}`));

    const isSelfSigned = x509.issuer === x509.subject || Boolean(x509.issuer && x509.issuer.includes('DG-LAB Coyote AI Local'));
    const valid = daysRemaining > 0 && matchesDomain && (!isSelfSigned || config.ssl.allowSelfSigned);

    return {
      exists: true,
      valid,
      isSelfSigned,
      daysRemaining,
      expiresAt,
      subject: x509.subject,
      issuer: x509.issuer,
      domains,
      ips,
      matchesDomain,
      reason: isSelfSigned && !config.ssl.allowSelfSigned
        ? '当前为自签名证书且未开启 ALLOW_SELF_SIGNED'
        : (!matchesDomain
          ? `证书保护范围 (${[...domains, ...ips].join(', ')}) 未涵盖目标域名 ${targetPrimary}`
          : (daysRemaining <= 0 ? '证书已过期' : '正常'))
    };
  } catch (err) {
    return {
      exists: true,
      valid: false,
      daysRemaining: 0,
      expiresAt: null,
      domains: [],
      matchesDomain: false,
      reason: `证书解析异常: ${err.message}`
    };
  }
}

/**
 * 构建 Cloudflare 请求头
 */
function getCfHeaders(email, apiKey) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (email && apiKey) {
    headers['X-Auth-Email'] = email;
    headers['X-Auth-Key'] = apiKey;
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * 提取根域名（如从子域名提取 apex 根域名）并查询 Cloudflare Zone ID
 */
async function resolveCloudflareZoneId(domain, email, apiKey) {
  if (process.env.CF_ZONE_ID) {
    return process.env.CF_ZONE_ID;
  }
  const cleanDomain = domain.replace(/^\*\./, '');
  const parts = cleanDomain.split('.');
  const rootDomain = parts.length >= 2 ? parts.slice(-2).join('.') : cleanDomain;

  const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(rootDomain)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: getCfHeaders(email, apiKey)
  });
  const data = await res.json();
  if (!data.success || !data.result || data.result.length === 0) {
    const errMsg = data.errors ? JSON.stringify(data.errors) : '未找到对应域名 Zone';
    throw new Error(`Cloudflare Zone 查询失败 (${rootDomain}): ${errMsg}`);
  }
  return data.result[0].id;
}

/**
 * 在 Cloudflare 创建 DNS TXT 记录
 */
async function createCfTxtRecord(zoneId, recordName, content, email, apiKey) {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getCfHeaders(email, apiKey),
    body: JSON.stringify({
      type: 'TXT',
      name: recordName,
      content: content,
      ttl: 60
    })
  });
  const data = await res.json();
  if (!data.success || !data.result?.id) {
    const errMsg = data.errors ? JSON.stringify(data.errors) : '未知错误';
    throw new Error(`创建 Cloudflare TXT 记录失败 (${recordName}): ${errMsg}`);
  }
  return data.result.id;
}

/**
 * 删除指定的 Cloudflare DNS TXT 记录
 */
async function deleteCfTxtRecord(zoneId, recordId, email, apiKey) {
  if (!recordId) return;
  try {
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`;
    await fetch(url, {
      method: 'DELETE',
      headers: getCfHeaders(email, apiKey)
    });
  } catch (err) {
    console.warn(`[SSL] 清理 Cloudflare TXT 记录 (${recordId}) 警告: ${err.message}`);
  }
}

/**
 * 清理指定名称下残留的 ACME TXT 记录
 */
async function cleanupResidualTxtRecords(zoneId, recordName, email, apiKey) {
  try {
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(recordName)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: getCfHeaders(email, apiKey)
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.result)) {
      for (const rec of data.result) {
        await deleteCfTxtRecord(zoneId, rec.id, email, apiKey);
      }
    }
  } catch (e) {}
}

/**
 * 通过 DoH (Cloudflare 1.1.1.1) 检查 TXT 记录是否已在权威边缘生效
 */
async function waitForDnsPropagation(recordName, expectedValues, maxWaitMs = 45000) {
  const startTime = Date.now();
  // 先固定等待 10 秒让 Cloudflare 权威节点完成同步
  await sleep(10000);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(recordName)}&type=TXT`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/dns-json' }
      });
      if (res.ok) {
        const data = await res.json();
        const answers = (data.Answer || []).map(a => (a.data || '').replace(/^"|"$/g, ''));
        const allFound = expectedValues.every(val => answers.includes(val));
        if (allFound) {
          console.log(`[SSL] DNS TXT 记录已在边缘节点生效: ${recordName}`);
          // 再额外等待 5 秒确保全球各探测点同步
          await sleep(5000);
          return true;
        }
      }
    } catch (e) {}
    await sleep(4000);
  }
  console.log(`[SSL] DNS 预检等待完成，继续提交 ACME 验证...`);
  return false;
}

/**
 * 针对给定域名列表执行单次 ACME 订单与 DNS-01 验证签发
 */
async function issueCertificateForDomains(client, domains, zoneId, email, apiKey) {
  const primaryDomain = domains[0];
  console.log(`[SSL] 正在生成 CSR 与私钥，申请域名列表: ${domains.join(', ')}`);

  const [certificateKey, certificateCsr] = await acme.crypto.createCsr({
    commonName: primaryDomain,
    altNames: domains
  });

  const order = await client.createOrder({
    identifiers: domains.map(d => ({ type: 'dns', value: d }))
  });

  const authorizations = await client.getAuthorizations(order);
  const createdRecords = [];
  const pendingChallenges = [];

  try {
    // 1. 为所有待验证的授权统一创建 Cloudflare TXT 记录
    for (const authz of authorizations) {
      const d = authz.identifier.value;
      if (authz.status === 'valid') {
        console.log(`[SSL] 域名授权已处于有效状态，跳过验证: ${authz.wildcard ? '*.' + d : d}`);
        continue;
      }

      const challenge = authz.challenges.find(c => c.type === 'dns-01');
      if (!challenge) {
        throw new Error(`未找到域名 ${d} 的 dns-01 挑战类型`);
      }

      const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
      const recordName = `_acme-challenge.${d.replace(/^\*\./, '')}`;

      console.log(`[SSL] 正在添加 Cloudflare DNS TXT 记录: ${recordName} -> ${keyAuthorization}`);
      const recordId = await createCfTxtRecord(zoneId, recordName, keyAuthorization, email, apiKey);

      createdRecords.push({ recordId, recordName, keyAuthorization });
      pendingChallenges.push({ authz, challenge, recordName, keyAuthorization, displayDomain: authz.wildcard ? `*.${d}` : d });
    }

    // 2. 等待 DNS 记录在 Cloudflare 权威节点传播生效
    if (pendingChallenges.length > 0) {
      const recordName = pendingChallenges[0].recordName;
      const expectedValues = pendingChallenges.map(p => p.keyAuthorization);
      console.log(`[SSL] 等待 Cloudflare DNS TXT 记录全球传播 (${expectedValues.length} 条记录)...`);
      await waitForDnsPropagation(recordName, expectedValues);
    }

    // 3. 逐一提交挑战完成通知并等待 Let's Encrypt 验证通过
    for (const item of pendingChallenges) {
      console.log(`[SSL] 正在请求 Let's Encrypt 验证域名: ${item.displayDomain}`);
      await client.completeChallenge(item.challenge);
      await client.waitForValidStatus(item.challenge);
      console.log(`[SSL] 域名验证通过: ${item.displayDomain}`);
    }

    // 4. 终结订单并下载证书链
    console.log(`[SSL] 所有域名验证通过，正在签发并下载证书...`);
    const finalized = await client.finalizeOrder(order, certificateCsr);
    const certPem = await client.getCertificate(finalized);

    return {
      cert: certPem.toString(),
      key: certificateKey.toString(),
      domains
    };
  } finally {
    // 5. 无论成功或失败，清理创建的临时 TXT 记录
    for (const rec of createdRecords) {
      console.log(`[SSL] 正在清理临时 DNS TXT 记录: ${rec.recordName} (${rec.recordId})`);
      await deleteCfTxtRecord(zoneId, rec.recordId, email, apiKey);
    }
  }
}

/**
 * 触发 Let's Encrypt 证书自动申请/续期主流程
 * 优先申请配置的所有域名与通配符，若通配符失败则自动降级为单域名
 */
async function renewCertificate(options = {}) {
  const email = options.cfEmail || config.ssl.cfEmail || process.env.CF_EMAIL;
  const apiKey = options.cfApiKey || config.ssl.cfApiKey || process.env.CF_API_KEY;
  const requestedDomains = options.domains || config.ssl.domains || [config.domain || 'localhost'];
  const certPath = options.certPath || config.ssl.certPath;
  const keyPath = options.keyPath || config.ssl.keyPath;
  const accountKeyPath = options.accountKeyPath || config.ssl.accountKeyPath;

  // 严格过滤，确保绝不夹带主根域名 (如从 sub.example.com 排除 example.com)
  const cleanDomain = (requestedDomains[0] || '').replace(/^\*\./, '');
  const parts = cleanDomain.split('.');
  const rootDomain = parts.length >= 2 ? parts.slice(-2).join('.') : '';
  const targetDomains = requestedDomains.filter(d => d && d !== rootDomain && d !== `*.${rootDomain}`);
  if (targetDomains.length === 0 && requestedDomains.length > 0) {
    targetDomains.push(requestedDomains[0]);
  }

  if (!apiKey) {
    throw new Error('缺少 Cloudflare API 凭据 (CF_API_KEY)，无法执行 DNS-01 自动续期');
  }

  // 确保证书目录存在
  const certDir = path.dirname(certPath);
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  // 1. 查询 Cloudflare Zone ID
  const zoneId = await resolveCloudflareZoneId(targetDomains[0], email, apiKey);
  console.log(`[SSL] 已匹配 Cloudflare Zone ID: ${zoneId}`);

  // 清理可能残留的旧挑战记录
  const baseChallengeName = `_acme-challenge.${targetDomains[0].replace(/^\*\./, '')}`;
  await cleanupResidualTxtRecords(zoneId, baseChallengeName, email, apiKey);

  // 2. 加载或创建 ACME 账户私钥
  let accountKey;
  if (fs.existsSync(accountKeyPath)) {
    accountKey = fs.readFileSync(accountKeyPath);
  } else {
    console.log(`[SSL] 正在创建新的 Let's Encrypt 账户密钥...`);
    accountKey = await acme.crypto.createPrivateKey();
    fs.writeFileSync(accountKeyPath, accountKey);
  }

  const client = new acme.Client({
    directoryUrl: options.staging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production,
    accountKey
  });

  // 注册或确认 ACME 账户
  try {
    client.getAccountUrl();
  } catch (e) {
    console.log(`[SSL] 正在向 Let's Encrypt 注册/关联账户 (${email})...`);
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: email ? [`mailto:${email}`] : []
    });
  }

  // 3. 尝试签发（优先包含通配符，失败则自动回退至单域名）
  let result;
  try {
    result = await issueCertificateForDomains(client, targetDomains, zoneId, email, apiKey);
  } catch (err) {
    const primaryOnly = targetDomains.filter(d => !d.startsWith('*.'));
    if (targetDomains.length > 1 && primaryOnly.length > 0) {
      console.warn(`[SSL] 包含通配符的证书申请未成功 (${err.message})，正在自动回退为仅申请 ${primaryOnly.join(', ')}...`);
      result = await issueCertificateForDomains(client, primaryOnly, zoneId, email, apiKey);
    } else {
      throw err;
    }
  }

  // 4. 写入证书与私钥文件
  fs.writeFileSync(certPath, result.cert, 'utf8');
  fs.writeFileSync(keyPath, result.key, 'utf8');

  const newStatus = checkCertificateStatus(certPath, keyPath);
  console.log(`[SSL] 新证书已成功写入本地: ${certPath}`);
  console.log(`[SSL] 签发域名: ${newStatus.domains.join(', ')} | 有效天数: ${newStatus.daysRemaining.toFixed(1)} 天`);

  return {
    cert: result.cert,
    key: result.key,
    status: newStatus
  };
}

/**
 * 生成覆盖 localhost、127.0.0.1、局域网 IP 与回退域名的通用自签名证书
 */
function generateSelfSignedCertificate(options = {}) {
  const certPath = options.certPath || config.ssl.certPath;
  const keyPath = options.keyPath || config.ssl.keyPath;
  const pki = forge.pki;

  console.log('[SSL] 正在生成通用自签名 SSL 证书 (包含 localhost、127.0.0.1 及所有活动局域网 IP)...');
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2); // 2年有效期

  const primaryDomain = config.domain || 'coyote.local';
  const attrs = [
    { name: 'commonName', value: primaryDomain },
    { name: 'organizationName', value: 'DG-LAB Coyote AI Local' }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  const localIps = typeof config.getLocalIps === 'function' ? config.getLocalIps() : ['127.0.0.1'];
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: primaryDomain },
    { type: 7, ip: '127.0.0.1' }
  ];
  for (const ip of localIps) {
    if (ip !== '127.0.0.1') {
      altNames.push({ type: 7, ip });
    }
  }

  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectAltName', altNames }
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = pki.certificateToPem(cert);
  const keyPem = pki.privateKeyToPem(keys.privateKey);

  const certDir = path.dirname(certPath);
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  fs.writeFileSync(certPath, certPem, 'utf8');
  fs.writeFileSync(keyPath, keyPem, 'utf8');
  console.log(`[SSL] 自签名证书已保存至: ${certPath}`);
  console.log(`[SSL] 证书保护范围: localhost, 127.0.0.1, ${localIps.join(', ')}, ${primaryDomain}`);

  const status = checkCertificateStatus(certPath, keyPath);
  return {
    cert: certPem,
    key: keyPem,
    status
  };
}

/**
 * 启动时或定时检查证书有效期，若不足阈值天数（默认 7 天）或不存在则自动更新并回调应用
 * 支持根据环境配置自动降级：Let's Encrypt -> 自签名证书 -> 纯明文模式
 */
async function ensureValidCertificate(options = {}) {
  // 1. 若显式禁用了 SSL (DISABLE_SSL=true)
  if (config.ssl.disabled) {
    console.log('[SSL] DISABLE_SSL=true，已显式关闭 SSL/TLS 加密支持，将以纯明文 HTTP/WS 模式运行');
    return {
      disabled: true,
      renewed: false,
      cert: null,
      key: null,
      status: { exists: false, valid: false, disabled: true, reason: 'DISABLE_SSL=true' }
    };
  }

  const thresholdDays = options.renewDays ?? config.ssl.renewDays ?? 7;
  const status = checkCertificateStatus();

  // 2. 本地已存在有效证书且有效期充裕
  if (status.exists && status.valid && status.daysRemaining >= thresholdDays) {
    console.log(
      `[SSL] 证书检查通过: 覆盖 [${[...status.domains, ...status.ips].join(', ')}]，剩余有效期 ${status.daysRemaining.toFixed(1)} 天 (阈值: ${thresholdDays} 天)，无需续期`
    );
    return {
      renewed: false,
      cert: fs.readFileSync(config.ssl.certPath),
      key: fs.readFileSync(config.ssl.keyPath),
      status
    };
  }

  const hasCloudflare = Boolean(options.cfApiKey || config.ssl.cfApiKey || process.env.CF_API_KEY);

  // 3. 需要更新或签发证书
  if (!status.exists) {
    console.log(`[SSL] 本地未找到证书文件 (${config.ssl.certPath})，正在准备签发...`);
  } else if (!status.matchesDomain) {
    console.log(`[SSL] 本地证书域名不匹配 (${status.reason})，正在准备重新签发...`);
  } else {
    console.log(
      `[SSL] 证书剩余有效期仅 ${status.daysRemaining.toFixed(1)} 天 (小于 ${thresholdDays} 天阈值)，准备续期...`
    );
  }

  let result;
  if (hasCloudflare) {
    // 策略 A: Cloudflare DNS-01 Let's Encrypt 自动签发/续期
    console.log(`[SSL] 检测到 Cloudflare 凭据，触发 Let's Encrypt 自动续期流程...`);
    try {
      result = await renewCertificate(options);
    } catch (err) {
      console.warn(`[SSL] Let's Encrypt 续期失败 (${err.message})`);
      if (config.ssl.allowSelfSigned && !status.valid) {
        console.warn(`[SSL] 正在自动降级生成局域网自签名证书保障服务启动...`);
        result = generateSelfSignedCertificate(options);
      } else {
        throw err;
      }
    }
  } else if (config.ssl.allowSelfSigned) {
    // 策略 B: 无 Cloudflare 凭据且允许自签名，生成通用局域网/本地证书
    console.log(`[SSL] 未配置 Cloudflare 凭据，正在自动生成覆盖局域网与 localhost 的通用自签名证书...`);
    result = generateSelfSignedCertificate(options);
  } else {
    // 策略 C: 无法签发，降级为纯明文模式
    console.warn(`[SSL] 未配置 Cloudflare 且 ALLOW_SELF_SIGNED=false，服务将以降级纯明文 HTTP/WS 模式运行`);
    return {
      disabled: true,
      renewed: false,
      cert: null,
      key: null,
      status: { exists: false, valid: false, disabled: true, reason: '无可用证书且不允许自签名' }
    };
  }

  if (typeof options.onRenewed === 'function' && result) {
    options.onRenewed({
      cert: result.cert,
      key: result.key,
      status: result.status
    });
  }

  return {
    renewed: true,
    cert: result.cert,
    key: result.key,
    status: result.status
  };
}

module.exports = {
  checkCertificateStatus,
  renewCertificate,
  generateSelfSignedCertificate,
  ensureValidCertificate
};
