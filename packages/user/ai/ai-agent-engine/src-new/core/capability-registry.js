/**
 * capability-registry.js — 业务能力注册表
 *
 * 把 topicFilter / ruleLearner / scanner / memory 等业务模块的「程序员接口」
 * 包装为「语义化能力单元」供任务层调用。
 *
 * 每个能力声明：name / module / action / riskLevel / rollbackable / argsSchema / execute
 *
 * 设计目的：
 *   1. 任务层与业务模块解耦 — 编排器只调 registry，不直接 import 业务模块
 *   2. 风险契约显式化 — 每个能力自带 riskLevel，编排器据此判断是否需要确认
 *   3. 可观测性 — registry.list() 即可输出全部能力清单（用于「你能做什么」）
 *   4. 可扩展性 — 新增能力只改注册表，编排器逻辑不变
 */

import { RISK_LEVEL } from './types.js';

export class CapabilityRegistry {
  constructor() {
    this._caps = new Map();
  }

  /** 注册一个能力（重复名会覆盖并打 warn） */
  register(cap) {
    if (!cap?.name) throw new Error('capability.name is required');
    if (!cap.execute || typeof cap.execute !== 'function') {
      throw new Error(`capability.execute must be a function: ${cap.name}`);
    }
    if (this._caps.has(cap.name)) {
      console.warn(`[capability-registry] 覆盖已有能力：${cap.name}`);
    }
    this._caps.set(cap.name, cap);
  }

  /** 列出所有能力（按 riskLevel 升序） */
  list() {
    const arr = Array.from(this._caps.values());
    const order = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
    return arr.sort((a, b) => (order[a.riskLevel] ?? 9) - (order[b.riskLevel] ?? 9));
  }

  /** 按名字取能力 */
  get(name) {
    return this._caps.get(name) || null;
  }

  /** 按风险等级筛选 */
  filterByRisk(level) {
    return this.list().filter(c => c.riskLevel === level);
  }

  /** 执行一个能力（args 由调用方保证合法） */
  async execute(name, args, ctx) {
    const cap = this.get(name);
    if (!cap) throw new Error(`未知能力：${name}`);
    return cap.execute(args, ctx);
  }

  /** 数量 */
  size() {
    return this._caps.size;
  }
}

/**
 * 创建默认能力注册表（已注册所有 CyberShield 业务能力）
 *
 * @param {object} services - 业务模块实例
 * @param {object} services.topicFilter
 * @param {object} services.ruleLearner
 * @param {object} services.scanner
 * @param {object} services.memory
 * @param {object} services.knowledge
 * @returns {CapabilityRegistry}
 */
export function createDefaultRegistry(services = {}) {
  const reg = new CapabilityRegistry();

  // ── 话题相关 ──────────────────────────────────
  reg.register({
    name: 'capability.topicFilter.createUserTopic',
    module: 'topicFilter',
    action: 'createUserTopic',
    riskLevel: RISK_LEVEL.L2,
    rollbackable: true,
    description: '创建用户自定义话题',
    argsSchema: ['topicId?', 'topicLabel', 'description?', 'keywords?', 'scopes?'],
    execute: async (args) => {
      if (!services.topicFilter?.addUserTopic) {
        return { success: false, reason: 'topicFilter 不可用' };
      }
      const topicId = args.topicId || `user_${Date.now()}`;
      const result = services.topicFilter.addUserTopic({
        id: topicId,
        label: args.topicLabel,
        description: args.description || '',
        keywords: args.keywords || [],
        scopes: args.scopes || ['comment'],
        createdBy: 'ai',
      });
      return { success: true, topicId, data: result };
    },
  });

  reg.register({
    name: 'capability.topicFilter.addKeywordsToTopic',
    module: 'topicFilter',
    action: 'addKeywords',
    riskLevel: RISK_LEVEL.L1,
    rollbackable: true,
    description: '给话题追加关键词',
    argsSchema: ['topicId', 'keywords', 'lang?'],
    execute: async (args) => {
      if (!services.topicFilter) return { success: false, reason: 'topicFilter 不可用' };
      const topicId = args.topicId;
      const before = JSON.parse(JSON.stringify(services.topicFilter.topics?.[topicId]?.keywords || {}));
      // 优先用桥接方法 _addKeywords，否则用原 addKeywordsToTopic
      if (typeof services.topicFilter._addKeywords === 'function') {
        services.topicFilter._addKeywords(topicId, args.keywords, args.lang || 'zh');
      } else if (typeof services.topicFilter.addKeywordsToTopic === 'function') {
        services.topicFilter.addKeywordsToTopic(topicId, args.keywords, args.lang || 'zh');
      }
      const after = JSON.parse(JSON.stringify(services.topicFilter.topics?.[topicId]?.keywords || {}));
      return { success: true, before, after, topicId };
    },
  });

  reg.register({
    name: 'capability.topicFilter.toggleTopic',
    module: 'topicFilter',
    action: 'toggle',
    riskLevel: RISK_LEVEL.L1,
    rollbackable: true,
    description: '启用/禁用话题',
    argsSchema: ['topicId', 'enabled'],
    execute: async (args) => {
      if (!services.topicFilter?.toggleTopic) {
        return { success: false, reason: 'topicFilter 不可用' };
      }
      const before = !!services.topicFilter.topics?.[args.topicId]?.enabled;
      services.topicFilter.toggleTopic(args.topicId, !!args.enabled);
      return { success: true, before: { enabled: before }, after: { enabled: !!args.enabled } };
    },
  });

  reg.register({
    name: 'capability.topicFilter.getAllTopics',
    module: 'topicFilter',
    action: 'query',
    riskLevel: RISK_LEVEL.L0,
    rollbackable: false,
    description: '获取所有话题',
    execute: async () => {
      if (!services.topicFilter?.getAllTopics) {
        return { success: false, reason: 'topicFilter 不可用' };
      }
      return { success: true, topics: services.topicFilter.getAllTopics() || [] };
    },
  });

  // ── 规则学习 ──────────────────────────────────
  reg.register({
    name: 'capability.ruleLearner.learnFromSample',
    module: 'ruleLearner',
    action: 'learn',
    riskLevel: RISK_LEVEL.L2,
    rollbackable: true,
    description: '从样本中学习新规则',
    argsSchema: ['text', 'verdict', 'topicId?'],
    execute: async (args) => {
      if (!services.ruleLearner?.learnFromSample) {
        return { success: false, reason: 'ruleLearner 不可用' };
      }
      const result = services.ruleLearner.learnFromSample(args.text, {
        verdict: args.verdict,
        topicId: args.topicId,
      });
      return { success: !!result, data: result };
    },
  });

  // ── 扫描器 ──────────────────────────────────
  reg.register({
    name: 'capability.scanner.refresh',
    module: 'scanner',
    action: 'refresh',
    riskLevel: RISK_LEVEL.L0,
    rollbackable: false,
    description: '刷新过滤器（应用新配置）',
    execute: async () => {
      if (typeof services.scanner?.refresh === 'function') {
        services.scanner.refresh();
      }
      return { success: true };
    },
  });

  // ── 记忆 ──────────────────────────────────
  reg.register({
    name: 'capability.memory.recordPreference',
    module: 'memory',
    action: 'record',
    riskLevel: RISK_LEVEL.L1,
    rollbackable: true,
    description: '记录用户偏好到记忆',
    argsSchema: ['topicId', 'topicLabel', 'scopes?', 'sensitivity?', 'keywords?'],
    execute: async (args) => {
      if (!services.memory?.recordPreference) {
        return { success: false, reason: 'memory 不可用' };
      }
      services.memory.recordPreference(args);
      return { success: true };
    },
  });

  return reg;
}
