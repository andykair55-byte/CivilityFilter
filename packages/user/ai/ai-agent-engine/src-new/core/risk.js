/**
 * risk.js — 风险分级（核心边界）
 *
 * 为每一次 AI 操作打上风险等级，决定是否需要确认。
 *
 * 等级定义：
 *   L0  纯说明 / 查询 / 描述（直接回复，不产生副作用）
 *   L1  轻量操作：少量关键词、建议生成（可自动执行 + 短提示）
 *   L2  创建话题、修改单条规则、开关单项能力（默认需要确认，可在 auto 模式跳过）
 *   L3  批量修改、删除规则、导入/导出、覆盖配置（必须显式确认）
 *   L4  清除配置、恢复默认、全量重置（二次确认）
 *
 * 原则：
 *   - L0 永远不需要确认
 *   - L1 在 manual 模式可跳过确认，在 auto 模式自动执行
 *   - L2 在 manual 模式确认，auto 模式可自动执行
 *   - L3/L4 必须显式确认
 *   - 所有有副作用的操作都应记录并可回滚
 */

import { RISK_LEVEL } from './types.js';

export { RISK_LEVEL };

/**
 * 计划步骤 → 风险等级映射
 * 按"module/action"组合判定，未知组合默认 L3（保守）
 */
const STEP_RISK_RULES = [
  // ── L0：纯查询 / 诊断 ──
  { match: { module: 'aiAnalyzer', action: 'diagnose' }, level: RISK_LEVEL.L0 },
  { match: { module: 'aiAnalyzer', action: 'classify' }, level: RISK_LEVEL.L0 },
  { match: { module: 'aiAnalyzer', action: 'chat' }, level: RISK_LEVEL.L0 },
  { match: { module: 'storage', action: 'read' }, level: RISK_LEVEL.L0 },
  { match: { module: 'storage', action: 'getStats' }, level: RISK_LEVEL.L0 },

  // ── L1：轻量 ──
  { match: { module: 'topicFilter', action: 'addUserTopic' }, level: RISK_LEVEL.L2, when: (args) => _countKeywords(args) <= 3 },
  { match: { module: 'topicFilter', action: 'addKeywordsToTopic' }, level: RISK_LEVEL.L1, when: (args) => _countKeywords(args) <= 5 },
  { match: { module: 'topicFilter', action: 'addKeywordsToTopic' }, level: RISK_LEVEL.L2, when: (args) => _countKeywords(args) > 5 && _countKeywords(args) <= 15 },
  { match: { module: 'topicFilter', action: 'addKeywordsToTopic' }, level: RISK_LEVEL.L3, when: (args) => _countKeywords(args) > 15 },
  { match: { module: 'topicFilter', action: 'toggleTopic' }, level: RISK_LEVEL.L1 },
  { match: { module: 'ruleLearner', action: 'confirmUpgrade' }, level: RISK_LEVEL.L1 },
  { match: { module: 'ruleLearner', action: 'rejectUpgrade' }, level: RISK_LEVEL.L1 },
  { match: { module: 'scanner', action: 'manualScan' }, level: RISK_LEVEL.L0 },

  // ── L2：修改单条规则 / 创建话题 ──
  { match: { module: 'topicFilter', action: 'removeKeywordFromTopic' }, level: RISK_LEVEL.L2 },
  { match: { module: 'topicFilter', action: 'removeTopic' }, level: RISK_LEVEL.L2 },
  { match: { module: 'topicFilter', action: 'resetTopicKeywords' }, level: RISK_LEVEL.L2 },
  { match: { module: 'ruleLearner', action: 'learn' }, level: RISK_LEVEL.L2 },
  { match: { module: 'ruleLearner', action: 'recordCorrection' }, level: RISK_LEVEL.L2 },
  { match: { module: 'storage', action: 'updateConfig' }, level: RISK_LEVEL.L2 },

  // ── L3：批量 / 覆盖 / 导入导出 ──
  { match: { module: 'storage', action: 'import' }, level: RISK_LEVEL.L3 },
  { match: { module: 'storage', action: 'export' }, level: RISK_LEVEL.L1 }, // 导出只读
  { match: { module: 'storage', action: 'clearCustom' }, level: RISK_LEVEL.L3 },
  { match: { module: 'ruleLearner', action: 'prune' }, level: RISK_LEVEL.L3 },
  { match: { module: 'memory', action: 'clear' }, level: RISK_LEVEL.L3 },

  // ── L4：清空 / 恢复默认 ──
  { match: { module: 'storage', action: 'reset' }, level: RISK_LEVEL.L4 },
  { match: { module: 'storage', action: 'clearAll' }, level: RISK_LEVEL.L4 },
  { match: { module: 'topicFilter', action: 'resetAll' }, level: RISK_LEVEL.L4 },
];

function _countKeywords(args) {
  if (!args) return 0;
  if (Array.isArray(args)) return args.length;
  if (Array.isArray(args.keywords)) return args.keywords.length;
  if (Array.isArray(args.kw)) return args.kw.length;
  return 0;
}

/**
 * 判断单个步骤的风险等级
 * @param {object} step 计划步骤 { module, action, args }
 * @returns {RiskLevel}
 */
export function classifyStep(step) {
  if (!step || !step.module || !step.action) return RISK_LEVEL.L3; // 未知：保守
  for (const rule of STEP_RISK_RULES) {
    if (rule.match.module === step.module && rule.match.action === step.action) {
      if (rule.when && !rule.when(step.args)) continue;
      return rule.level;
    }
  }
  return RISK_LEVEL.L3; // 未匹配规则：保守
}

/**
 * 聚合一个计划的总风险等级 = 最高单步等级
 * @param {Array} plan
 * @returns {RiskLevel}
 */
export function aggregateRisk(plan = []) {
  const order = [RISK_LEVEL.L0, RISK_LEVEL.L1, RISK_LEVEL.L2, RISK_LEVEL.L3, RISK_LEVEL.L4];
  let max = RISK_LEVEL.L0;
  for (const s of plan) {
    const r = classifyStep(s);
    if (order.indexOf(r) > order.indexOf(max)) max = r;
  }
  return max;
}

/**
 * 风险等级的人类可读标签
 */
export const RISK_LABELS = {
  L0: { zh: '只读', en: 'Read-only' },
  L1: { zh: '轻量', en: 'Light' },
  L2: { zh: '中等', en: 'Medium' },
  L3: { zh: '高', en: 'High' },
  L4: { zh: '危险', en: 'Critical' },
};

/**
 * 是否需要用户确认（结合 AgentMode）
 * @param {RiskLevel} level
 * @param {'manual'|'auto'} mode
 * @returns {boolean}
 */
export function requiresConfirmation(level, mode) {
  if (level === RISK_LEVEL.L0) return false;
  if (level === RISK_LEVEL.L1) return false; // L1 自动执行
  if (level === RISK_LEVEL.L2) return mode === 'manual';
  // L3/L4 always require
  return true;
}

/**
 * L4 是否需要二次确认
 * @param {RiskLevel} level
 * @returns {boolean}
 */
export function requiresDoubleConfirm(level) {
  return level === RISK_LEVEL.L4;
}

/**
 * 风险等级颜色（用于 UI）
 */
export const RISK_COLORS = {
  L0: '#22c55e',
  L1: '#3b82f6',
  L2: '#f59e0b',
  L3: '#ef4444',
  L4: '#7c2d12',
};
