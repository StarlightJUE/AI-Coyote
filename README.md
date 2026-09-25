# DG-LAB Coyote AI

基于大语言模型（DeepSeek / Google Gemini）与 DG-LAB 郊狼脉冲主机（官方 V4 协议优先 / V3 兼容）的智能联动控制器。

## 核心机制

- **纯 IP 无证书直连 & 域名 HTTPS 双栈自适应**：
  - **纯 IP / 本地访问**：通过局域网 IP（如 `http://192.168.x.x`）、公网 IP 或 `localhost` 访问时，自动提供明文 HTTP 网页与 `ws://` 二维码，**无需任何证书**，避免浏览器证书警告及手机 DG-LAB APP 拒连自签名 `wss://` 的问题。
  - **单端口 WS/WSS 复用**：WebSocket 端口（默认 `54321`）支持首字节协议识别，同一端口同时兼容 `ws://`（纯 IP 明文）与 `wss://`（域名 TLS 加密）。
  - **域名自动续期**：配置 Cloudflare 凭据后，启动时自动检查证书有效期，剩余不足 7 天自动通过 DNS-01 申请/续期 Let's Encrypt 证书并热重载。
- **按需代理分流**：移除全局代理劫持。DeepSeek 默认直连国内 API；Gemini 独立读取 `GEMINI_PROXY`。
- **多角色与底波引擎**：支持预设角色切换、自定义 Prompt、后台持续底波、双通道软上限保护与一键急停。

---

## 快速开始

### 1. 安装依赖

```bash
cd server
npm install
cd ..
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

按需修改根目录 `.env`（至少填入一个模型的 API Key）：

#### 场景 A：纯 IP 无证书使用（局域网 / 公网 IP 直连，开箱即用）
无需配置域名与 Cloudflare，直接保持默认或开启 `DISABLE_SSL=true`：

```ini
DEEPSEEK_API_KEY=sk-your-key
DISABLE_SSL=true
HTTP_PORT=8080
WS_PORT=54321
```
启动后直接访问 `http://<你的IP>:8080`，手机 DG-LAB APP 扫码即通过 `ws://<你的IP>:54321` 直连。

#### 场景 B：域名访问 + 自动证书（同时兼容 IP 明文访问）
```ini
DEEPSEEK_API_KEY=sk-your-key
DOMAIN=coyote.example.com
SSL_DOMAINS=coyote.example.com,*.coyote.example.com
CF_EMAIL=your@email.com
CF_API_KEY=your_cloudflare_global_api_key
```
启动后：
- 访问 `https://coyote.example.com` 自动使用 HTTPS 与 `wss://`；
- 访问 `http://<局域网或公网IP>` 自动走明文 HTTP 与 `ws://`，互不干扰。

### 3. 启动服务

```bash
node server/index.js
```

---

## `.env` 配置参考

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `DEEPSEEK_API_KEY` | - | DeepSeek API 密钥 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | DeepSeek 模型名称 |
| `DEEPSEEK_PROXY` | *(空)* | DeepSeek 代理（国内直连留空即可） |
| `GEMINI_API_KEY` | - | Google Gemini API 密钥 |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini 模型名称 |
| `GEMINI_PROXY` | `http://127.0.0.1:7890` | Gemini 代理地址（留空尝试直连） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `WS_PORT` | `54321` | WebSocket 端口（同端口支持 `ws` 与 `wss`） |
| `HTTP_PORT` | `80` | HTTP 端口（`DISABLE_SSL=true` 时为主端口，支持纯 IP 直接访问） |
| `HTTPS_PORT` | `443` | HTTPS 端口 |
| `DOMAIN` | `localhost` | 默认域名 |
| `DISABLE_SSL` | `false` | 设为 `true` 时完全关闭 SSL，仅运行纯 HTTP + WS |
| `ALLOW_SELF_SIGNED` | `true` | 缺少公网证书时是否自动生成自签名证书 |
| `SSL_RENEW_DAYS` | `7` | 证书剩余天数小于该值时自动触发续期 |
| `SSL_DOMAINS` | - | Let's Encrypt 申请域名列表（逗号分隔） |
| `CF_EMAIL` | - | Cloudflare 邮箱 |
| `CF_API_KEY` | - | Cloudflare Global API Key |

---

## 安全须知与免责声明

1. **严禁接触危险部位**：严禁将电极贴附于**胸部、心脏前区、颈部、头部或粘膜伤口处**。
2. **禁忌人群**：孕妇、植入心脏起搏器等电子医疗设备者、心律失常及癫痫患者**严禁使用**。
3. **安全限幅**：使用前请设置合理的通道强度软上限，从低强度开始适应，保持“紧急全停”按钮随手可触。
4. **免责声明**：本项目仅供合法成人体验与技术交流学习。使用者需自行承担全部使用风险，因不当使用或软件故障导致的任何意外或人身损害，开发者不承担任何法律责任。

