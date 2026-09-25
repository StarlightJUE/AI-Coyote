const fs = require('fs');
const path = require('path');
const { ProxyAgent } = require('undici');
const config = require('./config');
const sessionManager = require('./session');
const promptManager = require('./prompt-manager');

// 缓存 ProxyAgent 实例，避免重复创建
const proxyAgentCache = new Map();

function getDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (!proxyAgentCache.has(proxyUrl)) {
    try {
      proxyAgentCache.set(proxyUrl, new ProxyAgent(proxyUrl));
    } catch (e) {
      console.warn(`[AI Proxy] 创建代理 Agent 失败 (${proxyUrl}): ${e.message}`);
      return undefined;
    }
  }
  return proxyAgentCache.get(proxyUrl);
}

/**
 * 智能自适应 fetch：按需代理分流，并在代理不可达 (ECONNREFUSED) 时自动尝试直连兜底重试
 */
async function smartFetch(url, options = {}, proxyUrl = '') {
  const dispatcher = getDispatcher(proxyUrl);
  const fetchOpts = { ...options };
  if (dispatcher) {
    fetchOpts.dispatcher = dispatcher;
  }

  try {
    return await fetch(url, fetchOpts);
  } catch (err) {
    const isConnRefused = err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED');
    if (dispatcher && isConnRefused) {
      console.warn(`[AI Proxy] 代理服务器不可达 (${proxyUrl})，正在尝试无代理直连重试...`);
      const directOpts = { ...options };
      delete directOpts.dispatcher;
      return await fetch(url, directOpts);
    }
    throw err;
  }
}

// 默认 API 配置（优先从 .env 环境变量读取）
const DEFAULT_CONFIG = {
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    apiUrl: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash'
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    apiUrl: process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models',
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash'
  }
};

// 本地专属定制角色提示词
const DEFAULT_PROMPT_PATH = path.resolve(__dirname, 'prompts/character_succubus.md');
let lastPromptMtime = 0;
let cachedSystemPrompt = '';

function getSystemPrompt() {
  try {
    if (fs.existsSync(DEFAULT_PROMPT_PATH)) {
      const stats = fs.statSync(DEFAULT_PROMPT_PATH);
      if (!cachedSystemPrompt || stats.mtimeMs > lastPromptMtime) {
        cachedSystemPrompt = fs.readFileSync(DEFAULT_PROMPT_PATH, 'utf8');
        lastPromptMtime = stats.mtimeMs;
        console.log('[AI] 动态载入/刷新项目定制角色提示词:', DEFAULT_PROMPT_PATH);
      }
    }
  } catch (e) {
    console.warn('[AI] 无法从项目加载定制提示词:', e.message);
  }
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = `你扮演「魅魔」，高傲挑逗风格。输出格式必须为 JSON: {"line": "（动作）台词", "actions": [{"op":"hold_strength","channel":"A","value":10}]}`;
  }
  return cachedSystemPrompt;
}

/**
 * 流式 JSON 字段提取器 (实时抽取 line 字段内容推送给前端，同时收集完整 JSON 解析 actions)
 */
class StreamJsonExtractor {
  constructor(onTextChunk) {
    this.onTextChunk = onTextChunk;
    this.buffer = '';
    this.bufferFromLine = '';
    this.inLine = false;
    this.lineFinished = false;
    this.isRawFallback = false;
    this.emittedIndex = 0;
  }

  feed(token) {
    if (!token) return;
    this.buffer += token;

    if (this.lineFinished) return;

    if (!this.inLine && !this.isRawFallback) {
      const match = this.buffer.match(/"line"\s*:\s*"/i);
      if (match) {
        this.inLine = true;
        const startIndex = match.index + match[0].length;
        this.bufferFromLine = this.buffer.slice(startIndex);
        this.scanLine();
        return;
      }

      // 若超过 100 字符且不符合 JSON 规范，退化为原始流式输出
      if (this.buffer.length > 100 && !this.buffer.trim().startsWith('{') && !this.buffer.trim().startsWith('```')) {
        this.isRawFallback = true;
        this.onTextChunk(this.buffer);
        this.emittedIndex = this.buffer.length;
      }
      return;
    }

    if (this.isRawFallback) {
      const newChars = this.buffer.slice(this.emittedIndex);
      this.emittedIndex = this.buffer.length;
      if (newChars) this.onTextChunk(newChars);
      return;
    }

    if (this.inLine) {
      const match = this.buffer.match(/"line"\s*:\s*"/i);
      if (match) {
        const startIndex = match.index + match[0].length;
        this.bufferFromLine = this.buffer.slice(startIndex);
        this.scanLine();
      }
    }
  }

  scanLine() {
    let i = this.emittedIndex;
    let newText = '';
    while (i < this.bufferFromLine.length) {
      const ch = this.bufferFromLine[i];
      if (ch === '\\') {
        if (i + 1 < this.bufferFromLine.length) {
          const next = this.bufferFromLine[i + 1];
          if (next === 'n') newText += '\n';
          else if (next === 'r') newText += '\r';
          else if (next === 't') newText += '\t';
          else if (next === '"') newText += '"';
          else if (next === '\\') newText += '\\';
          else if (next === '/') newText += '/';
          else newText += next;
          i += 2;
        } else {
          // 转义未完，留待下一个 token
          break;
        }
      } else if (ch === '"') {
        this.lineFinished = true;
        this.emittedIndex = i;
        break;
      } else {
        newText += ch;
        i++;
      }
    }

    if (newText) {
      this.onTextChunk(newText);
      this.emittedIndex = i;
    }
  }

  getBuffer() {
    return this.buffer;
  }
}

// 统一 AI 聊天处理 (非流式普通请求)

// 确保输入大模型的历史记录中，assistant 的消息均为合法的 JSON 格式，保持 few-shot 模式一致性
function formatMessagesForModel(messages = []) {
  return messages.map(msg => {
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      const trimmed = msg.content.trim();
      if (!trimmed.startsWith('{')) {
        return {
          role: 'assistant',
          content: JSON.stringify({ line: trimmed, actions: [] })
        };
      }
    }
    return msg;
  });
}

function resolveEffectivePrompt(options = {}) {
  const sid = options.sessionId;
  const promptId = options.promptId;
  let persona = '';

  // 1. 若指定了具体预设（非 custom），严格只读取预设文件内容，绝不混入自定义文本
  if (promptId && promptId !== 'custom') {
    persona = promptManager.getPresetContent(promptId);
  } else if (promptId === 'custom' && options.systemPrompt) {
    // 2. 仅在明确选择 custom 时，才采用自定义人设
    persona = options.systemPrompt;
  } else if (!persona && sid) {
    const session = sessionManager.getSession(sid);
    if (session.promptId && session.promptId !== 'custom') {
      persona = promptManager.getPresetContent(session.promptId);
    } else if (session.customPrompt) {
      persona = session.customPrompt;
    }
  }

  if (!persona) {
    persona = promptManager.getDefaultPrompt();
  }
  return promptManager.assembleSystemPrompt(persona);
}

function formatStateSnippet(state = {}) {
  const mapping = state.mapping || 'A=大腿内侧、B=腰部';
  const sA = state.strengthA ?? 0;
  const limitA = state.softLimitA ?? 200;
  const sB = state.strengthB ?? 0;
  const limitB = state.softLimitB ?? 200;
  const nickname = state.nickname || '小明';
  return `\n\n【会话状态】称呼: ${nickname} | 映射: ${mapping} | A通道强度: ${sA} (当前安全上限 ${limitA}) | B通道强度: ${sB} (当前安全上限 ${limitB})`;
}

function prepareMessagesWithState(messages = [], state = {}) {
  const list = messages.map(m => ({ ...m }));
  let rawLastUserText = '';

  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user') {
      const content = String(list[i].content || '');
      if (!content.includes('【会话状态】')) {
        rawLastUserText = content;
        list[i].content = content + formatStateSnippet(state);
      } else {
        rawLastUserText = content.split('\n\n【会话状态】')[0];
      }
      break;
    }
  }

  const latestUserMsg = list.findLast ? list.findLast(m => m.role === 'user') : [...list].reverse().find(m => m.role === 'user');

  return {
    messagesForModel: formatMessagesForModel(list),
    latestUserMsg,
    rawLastUserText
  };
}

async function handleChat(options = {}) {
  const provider = options.provider || 'deepseek';
  const sid = options.sessionId;
  let userMessages = options.messages || [];
  const state = options.state || {};
  const fullSystemPrompt = resolveEffectivePrompt(options);

  if (sid) {
    sessionManager.updateSessionMeta(sid, {
      nickname: state.nickname,
      mapping: state.mapping,
      model: `${provider}:${options.model || ''}`,
      promptId: options.promptId,
      customPrompt: options.promptId === 'custom' ? (options.systemPrompt || '') : ''
    });
    if (!userMessages || userMessages.length === 0) {
      userMessages = sessionManager.getSession(sid).history;
    }
  }

  const { messagesForModel, latestUserMsg, rawLastUserText } = prepareMessagesWithState(userMessages, state);

  let result;
  if (provider === 'deepseek') {
    result = await callDeepSeek({
      apiKey: options.apiKey || DEFAULT_CONFIG.deepseek.apiKey,
      model: options.model || DEFAULT_CONFIG.deepseek.model,
      systemPrompt: fullSystemPrompt,
      messages: messagesForModel
    });
  } else if (provider === 'gemini') {
    result = await callGemini({
      apiKey: options.apiKey || DEFAULT_CONFIG.gemini.apiKey,
      model: options.model || DEFAULT_CONFIG.gemini.model,
      systemPrompt: fullSystemPrompt,
      messages: messagesForModel
    });
  } else {
    throw new Error(`不支持的 AI 提供商: ${provider}`);
  }

  if (sid && result) {
    if (latestUserMsg) {
      sessionManager.appendMessage(sid, 'user', latestUserMsg.content, 'user', rawLastUserText || latestUserMsg.content);
    }
    const modelPayload = JSON.stringify({
      line: result.line,
      actions: result.actions || []
    });
    sessionManager.appendMessage(sid, 'assistant', modelPayload, 'ai', result.line);
  }

  return result;
}

// 统一 AI 聊天流式处理 (SSE 流式输出)
async function handleChatStream(options = {}, sseCallback) {
  const provider = options.provider || 'deepseek';
  const sid = options.sessionId;
  let userMessages = options.messages || [];
  const state = options.state || {};
  const fullSystemPrompt = resolveEffectivePrompt(options);

  if (sid) {
    sessionManager.updateSessionMeta(sid, {
      nickname: state.nickname,
      mapping: state.mapping,
      model: `${provider}:${options.model || ''}`,
      promptId: options.promptId,
      customPrompt: options.promptId === 'custom' ? (options.systemPrompt || '') : ''
    });
    if (!userMessages || userMessages.length === 0) {
      userMessages = sessionManager.getSession(sid).history;
    }
  }

  const { messagesForModel, latestUserMsg, rawLastUserText } = prepareMessagesWithState(userMessages, state);

  const onChunk = (chunk) => {
    if (sseCallback && chunk) {
      sseCallback('chunk', { text: chunk });
    }
  };

  let result;
  if (provider === 'deepseek') {
    result = await callDeepSeekStream({
      apiKey: options.apiKey || DEFAULT_CONFIG.deepseek.apiKey,
      model: options.model || DEFAULT_CONFIG.deepseek.model,
      systemPrompt: fullSystemPrompt,
      messages: messagesForModel,
      onChunk
    });
  } else if (provider === 'gemini') {
    result = await callGeminiStream({
      apiKey: options.apiKey || DEFAULT_CONFIG.gemini.apiKey,
      model: options.model || DEFAULT_CONFIG.gemini.model,
      systemPrompt: fullSystemPrompt,
      messages: messagesForModel,
      onChunk
    });
  } else {
    throw new Error(`不支持的 AI 提供商: ${provider}`);
  }

  if (sid && result) {
    if (latestUserMsg) {
      sessionManager.appendMessage(sid, 'user', latestUserMsg.content, 'user', rawLastUserText || latestUserMsg.content);
    }
    const modelPayload = JSON.stringify({
      line: result.line,
      actions: result.actions || []
    });
    sessionManager.appendMessage(sid, 'assistant', modelPayload, 'ai', result.line);
  }

  if (sseCallback) {
    sseCallback('done', {
      line: result.line,
      actions: result.actions || []
    });
  }

  return result;
}

// 1. 调用 DeepSeek (非流式)
async function callDeepSeek({ apiKey, model, systemPrompt, messages }) {
  if (!apiKey) {
    throw new Error('未配置 DeepSeek API Key，请在 .env 文件中设置 DEEPSEEK_API_KEY');
  }
  const dsMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const payload = {
    model: model || DEFAULT_CONFIG.deepseek.model || 'deepseek-flash',
    messages: dsMessages,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    stream: false
  };

  const res = await smartFetch(DEFAULT_CONFIG.deepseek.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  }, config.proxy.deepseek);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek 请求失败 (${res.status}): ${errText}`);
  }

  const json = await res.json();
  const rawContent = json.choices?.[0]?.message?.content || '{}';
  return parseModelOutput(rawContent);
}

// 2. 调用 DeepSeek (流式)
async function callDeepSeekStream({ apiKey, model, systemPrompt, messages, onChunk }) {
  if (!apiKey) {
    throw new Error('未配置 DeepSeek API Key，请在 .env 文件中设置 DEEPSEEK_API_KEY');
  }
  const dsMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const payload = {
    model: model || DEFAULT_CONFIG.deepseek.model || 'deepseek-flash',
    messages: dsMessages,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    stream: true
  };

  const res = await smartFetch(DEFAULT_CONFIG.deepseek.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  }, config.proxy.deepseek);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek 请求失败 (${res.status}): ${errText}`);
  }

  const extractor = new StreamJsonExtractor(onChunk);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') break;
      try {
        const parsed = JSON.parse(dataStr);
        const token = parsed.choices?.[0]?.delta?.content || '';
        if (token) {
          extractor.feed(token);
        }
      } catch (e) {}
    }
  }

  return parseModelOutput(extractor.getBuffer());
}

// 3. 调用 Gemini (具备智能多模型 Fallback 容灾 - 非流式)
async function callGemini({ apiKey, model, systemPrompt, messages }) {
  if (!apiKey) {
    throw new Error('未配置 Gemini API Key，请在 .env 文件中设置 GEMINI_API_KEY');
  }
  const contents = [];
  for (const msg of messages) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }

  const primaryModel = model || DEFAULT_CONFIG.gemini.model;
  const candidateModels = [
    primaryModel,
    'gemini-3.8-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-pro-latest'
  ];
  const queue = [...new Set(candidateModels)];

  let lastError = null;

  for (const m of queue) {
    const url = `${DEFAULT_CONFIG.gemini.apiUrl}/${m}:generateContent?key=${apiKey}`;
    const payload = {
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: contents,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.7
      }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await smartFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      }, config.proxy.gemini);
      clearTimeout(timeoutId);

      if (res.ok) {
        const json = await res.json();
        const rawContent = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        return parseModelOutput(rawContent);
      } else {
        const errText = await res.text();
        console.warn(`[Gemini ${m} 异常 ${res.status}]: ${errText.slice(0, 120)}... 正在自动回退备用模型...`);
        lastError = new Error(`Gemini ${m} 请求失败 (${res.status}): ${errText}`);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err.name === 'AbortError' || err.message.includes('aborted');
      console.warn(`[Gemini ${m} ${isTimeout ? '响应超时(12s)' : '网络中断'}]: 正在自动回退备用模型...`);
      lastError = isTimeout ? new Error(`Gemini ${m} 响应超时`) : err;
    }
  }

  throw lastError || new Error('所有 Gemini 备用模型均暂时不可用，请稍后再试');
}

// 4. 调用 Gemini (流式)
async function callGeminiStream({ apiKey, model, systemPrompt, messages, onChunk }) {
  if (!apiKey) {
    throw new Error('未配置 Gemini API Key，请在 .env 文件中设置 GEMINI_API_KEY');
  }
  const contents = [];
  for (const msg of messages) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }

  const primaryModel = model || DEFAULT_CONFIG.gemini.model;
  const candidateModels = [
    primaryModel,
    'gemini-3.8-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-pro-latest'
  ];
  const queue = [...new Set(candidateModels)];

  let lastError = null;

  for (const m of queue) {
    const url = `${DEFAULT_CONFIG.gemini.apiUrl}/${m}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const payload = {
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: contents,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.7
      }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await smartFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      }, config.proxy.gemini);
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[Gemini Stream ${m} 异常 ${res.status}]: ${errText.slice(0, 120)}... 正在自动回退备用模型...`);
        lastError = new Error(`Gemini ${m} 请求失败 (${res.status}): ${errText}`);
        continue;
      }

      const extractor = new StreamJsonExtractor(onChunk);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          try {
            const parsed = JSON.parse(dataStr);
            const token = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (token) {
              extractor.feed(token);
            }
          } catch (e) {}
        }
      }

      return parseModelOutput(extractor.getBuffer());
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err.name === 'AbortError' || err.message.includes('aborted');
      console.warn(`[Gemini Stream ${m} ${isTimeout ? '响应超时(12s)' : '网络中断'}]: 正在自动回退备用模型...`);
      lastError = isTimeout ? new Error(`Gemini ${m} 响应超时`) : err;
    }
  }

  throw lastError || new Error('所有 Gemini 备用模型均暂时不可用，请稍后再试');
}

// 清洗并提取有效 JSON (极致防线：绝不让原始代码或 JSON 泄露到前端台词气泡)
function parseModelOutput(raw) {
  let cleaned = (raw || '').trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  let line = '';
  let actions = [];

  try {
    const parsed = JSON.parse(cleaned);
    line = typeof parsed.line === 'string' ? parsed.line.trim() : '';
    actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch (err) {
    if (!cleaned) {
      console.warn('[AI] 警告: 大模型流式输出缓冲区为空 (可能是网络瞬断、上游空响应或历史未对齐)，触发人设动作兜底');
    } else {
      console.warn('[AI] JSON 解析未通过，执行正则容错提取. 原始片段:', cleaned.slice(0, 120));
      const lineMatch = cleaned.match(/"line"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (lineMatch) {
        line = lineMatch[1].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
      }
      const actionsMatch = cleaned.match(/"actions"\s*:\s*(\[[^\]]*\])/);
      if (actionsMatch) {
        try {
          actions = JSON.parse(actionsMatch[1]);
        } catch (e) {}
      }
    }
  }

  // 严密防线 1：如果 line 是空的，或者 line 本身包含了裸 JSON 报文
  const looksLikeRawJson = !line || line.startsWith('{') || line.startsWith('[') || line.includes('"actions"') || line.includes('"op":');

  if (looksLikeRawJson) {
    // 尝试从 cleaned 中挽救提取 actions
    if (actions.length === 0) {
      try {
        const obj = JSON.parse(cleaned);
        if (Array.isArray(obj.actions)) actions = obj.actions;
      } catch (e) {}
    }

    // 根据 actions 动作类型智能合成通用台词描写，彻底杜绝裸 JSON 暴露给用户
    if (actions.some(a => a.op === 'bg_wave_start')) {
      line = '（微弱起伏的律动底色长久地蔓延开来……）嘘……放松点，慢慢感受。';
    } else if (actions.some(a => a.op === 'pulse' || a.op === 'hold_strength')) {
      line = '（一阵细密柔和的脉冲刺激悄然传递……）感觉到了吗？别怕……';
    } else {
      const naturalFallbacks = [
        '（微弱的脉冲在暗处轻柔流淌，耐心地等待着你的回应……）我在呢，怎么了？',
        '（细微的电流轻缓地起伏滑过……）嘘……在想什么呢？',
        '（微弱的电感安静地环绕起伏，微微收紧又松开……）别发呆，感受我……'
      ];
      line = naturalFallbacks[Math.floor(Math.random() * naturalFallbacks.length)];
    }
  }

  return { line, actions };
}

module.exports = {
  handleChat,
  handleChatStream,
  getSystemPrompt,
  resolveEffectivePrompt,
  DEFAULT_CONFIG,
  sessionManager,
  promptManager,
  StreamJsonExtractor
};
