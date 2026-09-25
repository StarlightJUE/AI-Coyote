const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');

// 确保存储目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 内存缓存会话
let sessions = {};

// 加载已有会话
try {
  if (fs.existsSync(DATA_FILE)) {
    sessions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}');
    console.log(`[Session] 已从持久化存储恢复 ${Object.keys(sessions).length} 个会话`);
  }
} catch (e) {
  console.warn('[Session] 加载持久化会话失败，创建新存储:', e.message);
  sessions = {};
}

// 保存会话到文件
function saveToFile() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (e) {
    console.error('[Session] 保存持久化会话失败:', e.message);
  }
}

// 获取或初始化一个会话
function getSession(sid) {
  if (!sid) sid = 'default_session';
  if (!sessions[sid]) {
    sessions[sid] = {
      id: sid,
      nickname: '小明',
      mapping: 'A=大腿内侧、B=腰部',
      model: 'gemini:gemini-3.8-flash',
      promptId: 'succubus',
      customPrompt: '',
      history: [],          // 给大模型的上下文 [{ role, content }]
      displayMessages: [],  // 给前端还原气泡用 [{ sender, text, time }]
      updatedAt: Date.now()
    };
    saveToFile();
  }
  return sessions[sid];
}

// 更新会话元数据（称呼、映射、选择的模型、提示词）
function updateSessionMeta(sid, meta = {}) {
  const s = getSession(sid);
  if (meta.nickname) s.nickname = meta.nickname;
  if (meta.mapping) s.mapping = meta.mapping;
  if (meta.model) s.model = meta.model;
  if (meta.promptId !== undefined) s.promptId = meta.promptId;
  if (meta.customPrompt !== undefined) s.customPrompt = meta.customPrompt;
  s.updatedAt = Date.now();
  saveToFile();
  return s;
}

// 显式更新玩家与部位设定
function updateSessionProfile(sid, profile = {}) {
  const s = getSession(sid);
  if (typeof profile.nickname === 'string' && profile.nickname.trim()) s.nickname = profile.nickname.trim();
  if (typeof profile.mapping === 'string' && profile.mapping.trim()) s.mapping = profile.mapping.trim();
  if (typeof profile.model === 'string' && profile.model.trim()) s.model = profile.model.trim();
  if (typeof profile.promptId === 'string' && profile.promptId.trim()) s.promptId = profile.promptId.trim();
  if (typeof profile.customPrompt === 'string') s.customPrompt = profile.customPrompt;
  s.updatedAt = Date.now();
  saveToFile();
  return s;
}

// 追加对话记录 (contentForModel 保持模型结构化 JSON 上下文，displayText 给人类聊天气泡展示)
function appendMessage(sid, role, contentForModel, sender = null, displayText = null) {
  const s = getSession(sid);
  s.history.push({ role, content: contentForModel });
  // 控制历史长度，保留最新 30 轮
  if (s.history.length > 30) {
    s.history = s.history.slice(-30);
  }

  s.displayMessages.push({
    sender: sender || (role === 'user' ? 'user' : 'ai'),
    text: displayText || contentForModel,
    time: new Date().toLocaleTimeString()
  });
  if (s.displayMessages.length > 50) {
    s.displayMessages = s.displayMessages.slice(-50);
  }

  s.updatedAt = Date.now();
  saveToFile();
  return s;
}

// 重置会话历史
function resetSession(sid) {
  const s = getSession(sid);
  s.history = [];
  s.displayMessages = [];
  s.updatedAt = Date.now();
  saveToFile();
  return s;
}

module.exports = {
  getSession,
  updateSessionMeta,
  updateSessionProfile,
  appendMessage,
  resetSession
};
