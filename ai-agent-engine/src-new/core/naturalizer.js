/**
 * naturalizer.js — 自然语言回复生成器
 *
 * 将结构化 AIAction 转换为面向用户的自然语言。
 * 避免使用 "我检测到关键词..." 这类机械式表达。
 *
 * 模板策略：
 *   1. 优先使用具体上下文（话题名、关键词数量、风险等级）填充模板
 *   2. 提供 L0-L4 的风险声明
 *   3. 每次回复都包含四要素：理解 → 计划 → 确认提示 → 下一步动作
 *
 * 兼容：
 *   - 默认中文输出，可通过 lang='en' 切换
 *   - 模板按意图分类，避免一刀切
 */

import { RISK_LEVEL, RISK_LABELS } from './risk.js';

const CONFIRM_TEMPLATES = {
  L1: {
    zh: '我刚刚已经自动帮你{action}，影响范围很小。如果不喜欢，告诉我"撤销"即可。',
    en: 'I auto-applied {action} (very low risk). Say "undo" to revert.',
  },
  L2: {
    zh: '这次会修改你的过滤规则（中等风险）。请确认是否执行？',
    en: 'This will modify your filter rules (medium risk). Confirm?',
  },
  L3: {
    zh: '⚠️ 这是一次批量操作，影响较大。请确认是否真的要执行？',
    en: '⚠️ This is a bulk operation with major impact. Are you sure?',
  },
  L4: {
    zh: '⚠️⚠️ 这是一次不可逆操作：{action}。请再次确认。',
    en: '⚠️⚠️ Irreversible action: {action}. Please confirm once more.',
  },
};

const SUCCESS_TEMPLATES = {
  enable_topic: { zh: '已为你启用「{topic}」话题过滤', en: 'Topic "{topic}" filter enabled' },
  create_topic: { zh: '已创建新话题「{topic}」并加入 {n} 个关键词', en: 'Created topic "{topic}" with {n} keywords' },
  add_keywords: { zh: '已为「{topic}」加入 {n} 个关键词', en: 'Added {n} keywords to "{topic}"' },
  remove_keyword: { zh: '已从「{topic}」移除关键词「{keyword}」', en: 'Removed keyword "{keyword}" from "{topic}"' },
  toggle_topic: { zh: '已将「{topic}」切换为{state}', en: 'Topic "{topic}" set to {state}' },
  diagnose: { zh: '诊断完成', en: 'Diagnosis complete' },
  generic: { zh: '操作完成', en: 'Done' },
};

const UNDO_TEMPLATES = {
  zh: '已撤销：{summary}。相关数据已恢复到 {time} 之前。',
  en: 'Undone: {summary}. Data restored to {time} ago.',
};

function _lang() {
  try {
    const l = GM_getValue('cs_lang', '') || (navigator.language || '').startsWith('zh') ? 'zh' : 'en';
    return l === 'en' ? 'en' : 'zh';
  } catch (e) { return 'zh'; }
}

function _tpl(map, lang) {
  return map[lang] || map.zh;
}

/**
 * 根据 AIAction 生成自然语言主回复
 * @param {object} action    AIAction
 * @param {object} ctx       { mode, planResult, task, error }
 * @returns {string}
 */
export function naturalizeResponse(action, ctx = {}) {
  const lang = _lang();
  const intent = action?.intent;
  const plan = action?.plan || [];
  const risk = action?.riskLevel || RISK_LEVEL.L0;

  // 1) 理解（必说）
  let understanding = '';
  if (action?.entities?.topic) {
    const topic = action.entities.topic;
    understanding = lang === 'en'
      ? `I understand you want to filter content related to "${topic}".`
      : `我理解你想屏蔽「${topic}」相关的内容。`;
  } else if (intent === 'DIAGNOSE') {
    understanding = lang === 'en'
      ? `I\'ll help you diagnose why that content wasn\'t filtered.`
      : `我来帮你排查为什么那条内容没被过滤。`;
  } else if (intent === 'INFORMATION_QUERY') {
    understanding = lang === 'en'
      ? `Let me pull up your current filter configuration.`
      : `我来查一下你当前的过滤配置。`;
  } else if (intent === 'UNDO') {
    understanding = lang === 'en'
      ? `Got it. Undoing the last change.`
      : `好的，正在撤销上一步操作。`;
  } else if (intent === 'STATUS_QUERY') {
    understanding = lang === 'en'
      ? `Here\'s the current task status.`
      : `这是当前任务的进度。`;
  } else {
    understanding = lang === 'en'
      ? `I\'m analyzing your request.`
      : `我在分析你的请求。`;
  }

  // 2) 计划或推荐（针对 PLANNING/RECOMMENDING/EXECUTE）
  let planText = '';
  if (action?.recommendedOptions?.length) {
    const opts = action.recommendedOptions.slice(0, 3).map(o => o.label).join(' / ');
    planText = lang === 'en' ? ` Options: ${opts}.` : ` 候选：${opts}。`;
  } else if (plan.length > 0) {
    const labels = plan.slice(0, 3).map(s => s.label).join('、');
    planText = lang === 'en' ? ` Plan: ${labels}.` : ` 计划：${labels}。`;
  }

  // 3) 风险与确认提示
  let riskText = '';
  if (risk === RISK_LEVEL.L0) {
    riskText = ''; // 无副作用，不强调
  } else if (ctx.mode === 'auto' && (risk === RISK_LEVEL.L1 || risk === RISK_LEVEL.L2)) {
    riskText = lang === 'en'
      ? ` (${RISK_LABELS[risk].en} risk, auto-executed.)`
      : `（${RISK_LABELS[risk].zh}风险，已自动执行。）`;
  } else {
    const tpl = _tpl(CONFIRM_TEMPLATES[risk] || CONFIRM_TEMPLATES.L2, lang);
    riskText = ' ' + tpl.replace(/\{action\}/g, _humanAction(action, lang));
  }

  // 4) 下一步动作
  let nextText = '';
  if (action?.needClarification && action?.clarificationQuestions?.length) {
    nextText = lang === 'en'
      ? ` Please pick one of the options above.`
      : ` 请在上方选项中告诉我。`;
  } else if (action?.requiresConfirmation) {
    nextText = lang === 'en'
      ? ` Click "Confirm" to proceed, or "Cancel" to stop.`
      : ` 点击下方"确认"继续，或"取消"放弃。`;
  } else if (ctx.planResult?.success) {
    nextText = ' ' + _formatSuccess(ctx.planResult, lang);
  } else if (ctx.error) {
    nextText = lang === 'en'
      ? ` Something went wrong: ${ctx.error}.`
      : ` 出了点问题：${ctx.error}。`;
  }

  return understanding + planText + riskText + nextText;
}

/**
 * 生成"待确认"摘要（独立使用，UI 在 WAITING_CONFIRMATION 展示）
 * @param {object} action
 */
export function buildConfirmationPrompt(action) {
  const lang = _lang();
  const risk = action?.riskLevel || RISK_LEVEL.L0;
  const steps = action?.plan || [];
  if (steps.length === 0) return lang === 'en' ? 'Ready to proceed?' : '可以执行吗？';
  const list = steps.map((s, i) => `${i + 1}. ${s.label}`).join('\n');
  const tag = risk === RISK_LEVEL.L4 ? '⚠️⚠️' : (risk === RISK_LEVEL.L3 ? '⚠️' : '');
  return lang === 'en'
    ? `${tag} About to do:\n${list}\nConfirm?`
    : `${tag} 即将执行：\n${list}\n确认执行吗？`;
}

/**
 * 操作成功后的回执
 * @param {object} result  { type, topicLabel, count, etc. }
 */
export function formatSuccess(result) {
  return _formatSuccess(result, _lang());
}

/**
 * 撤销回执
 * @param {object} info  { summary, timeAgo }
 */
export function formatUndo(info) {
  const lang = _lang();
  const tpl = _tpl(UNDO_TEMPLATES, lang);
  return tpl
    .replace(/\{summary\}/g, info?.summary || (lang === 'en' ? 'last change' : '上一步操作'))
    .replace(/\{time\}/g, info?.timeAgo || (lang === 'en' ? 'a few seconds' : '几秒'));
}

function _formatSuccess(result, lang) {
  if (!result || !result.type) return lang === 'en' ? 'Done.' : '已完成。';
  const tpl = SUCCESS_TEMPLATES[result.type] || SUCCESS_TEMPLATES.generic;
  const str = _tpl(tpl, lang);
  return str
    .replace(/\{topic\}/g, result.topicLabel || result.topicId || (lang === 'en' ? 'topic' : '话题'))
    .replace(/\{n\}/g, result.count != null ? String(result.count) : (lang === 'en' ? 'a few' : '若干'))
    .replace(/\{state\}/g, result.enabled ? (lang === 'en' ? 'enabled' : '启用') : (lang === 'en' ? 'disabled' : '禁用'))
    .replace(/\{keyword\}/g, result.keyword || '');
}

function _humanAction(action, lang) {
  if (action?.plan?.[0]?.label) return action.plan[0].label;
  if (action?.entities?.topic) {
    return lang === 'en' ? `filter "${action.entities.topic}"` : `屏蔽「${action.entities.topic}」`;
  }
  return lang === 'en' ? 'perform this action' : '执行该操作';
}
