// DG-LAB Coyote 提示词框架管理器 (人设预设管理、用户自定义MD导入、底层驱动协议独立组装)
const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.resolve(__dirname, 'prompts');
const BASE_CONTRACT_FILE = path.join(PROMPTS_DIR, 'base_coyote_contract.md');

// 预设角色列表定义
const PRESETS = [
  {
    id: 'succubus',
    name: '深渊魅魔（高傲·挑衅惩戒）',
    desc: '居高临下、恶作剧掌控。将刺激转化为侵蚀意志的紫黑魔力电弧与酥麻电流。',
    filename: 'character_succubus.md'
  },
  {
    id: 'android',
    name: '仿生医生（冷淡·体征监测）',
    desc: '无机质科学观察、数据汇报。将刺激转化为微安级神经导联校准电流。',
    filename: 'character_android.md'
  },
  {
    id: 'catgirl',
    name: '傲娇猫娘（调皮·口是心非）',
    desc: '炸毛傲娇、反差依恋。将刺激转化为带微弱静电的毛茸茸双尾与猫猫拳。',
    filename: 'character_catgirl.md'
  }
];

class PromptManager {
  constructor() {
    this.cachedBaseContract = '';
    this.lastContractMtime = 0;
  }

  // 读取底层系统强制驱动契约
  getBaseContract() {
    try {
      if (fs.existsSync(BASE_CONTRACT_FILE)) {
        const stats = fs.statSync(BASE_CONTRACT_FILE);
        if (!this.cachedBaseContract || stats.mtimeMs > this.lastContractMtime) {
          this.cachedBaseContract = fs.readFileSync(BASE_CONTRACT_FILE, 'utf8');
          this.lastContractMtime = stats.mtimeMs;
        }
      }
    } catch (e) {
      console.error('[PromptManager] 读取底层契约失败:', e.message);
    }
    return this.cachedBaseContract || '输出格式必须为严格 JSON: {"line": "（动作）台词", "actions": []}';
  }

  // 获取所有角色预设列表（元数据）
  getPresetsList() {
    return PRESETS.map(p => ({
      id: p.id,
      name: p.name,
      desc: p.desc
    }));
  }

  // 获取指定预设的纯人设内容
  getPresetContent(id) {
    const item = PRESETS.find(p => p.id === id) || PRESETS[0];
    const fullPath = path.join(PROMPTS_DIR, item.filename);
    try {
      if (fs.existsSync(fullPath)) {
        return fs.readFileSync(fullPath, 'utf8');
      }
    } catch (e) {
      console.error(`[PromptManager] 读取预设人设 ${item.filename} 失败:`, e.message);
    }
    return '';
  }

  // 获取默认角色人设 (魅魔)
  getDefaultPrompt() {
    return this.getPresetContent('succubus');
  }

  /**
   * 后端智能拼装 System Prompt：
   * 将【纯角色人设 (用户上传/预设)】与【独立底层驱动与JSON格式契约】合并拼接
   */
  assembleSystemPrompt(personaText) {
    let persona = (personaText && typeof personaText === 'string') ? personaText.trim() : '';
    if (!persona) {
      persona = this.getDefaultPrompt();
    }

    const baseContract = this.getBaseContract().trim();

    // 如果传入的人设文本里已经包含底层协议声明，直接返回避免重复
    const hasJsonRule = persona.includes('"line"') && persona.includes('"actions"');
    const hasOpRule = persona.includes('hold_strength') || persona.includes('bg_wave');
    if (hasJsonRule && hasOpRule) {
      return persona;
    }

    return `${persona}\n\n---\n\n${baseContract}`;
  }

  // 兼容旧调用名
  ensureCoyoteContract(promptText) {
    return this.assembleSystemPrompt(promptText);
  }
}

module.exports = new PromptManager();
