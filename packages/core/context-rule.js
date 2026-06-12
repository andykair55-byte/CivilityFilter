/**
 * context-rule.js — 上下文敏感规则引擎
 *
 * 用于 Layer 2 行为分析中的上下文感知判断。
 * 触发词 + 周边负面信号 = suspicious → 送 Layer 3 确认
 * 触发词 + 无负面信号 = safe（不误杀正常内容）
 *
 * 规则来源：ai_learned（AI 学习器自动生成）、manual（用户手动添加）
 */

const CONTEXT_RULES_KEY = 'cs_context_rules';

export class ContextRuleEngine {
  constructor() {
    this.rules = [];
    this._load();
  }

  /**
   * 添加一条上下文敏感规则
   */
  addRule(rule) {
    const exists = this.rules.some(r => r.trigger === rule.trigger);
    if (exists) return;
    this.rules.push({
      trigger: rule.trigger,
      canonical: rule.canonical || rule.trigger,
      requireNegativeContext: true,
      negativeSignals: rule.negativeSignals || [],
      confidence: rule.confidence || 0.5,
      source: rule.source || 'ai_learned',
      createdAt: Date.now(),
      hitCount: 0,
    });
    this._save();
  }

  /**
   * 添加多条规则（供 rule-learner 批量同步）
   */
  addRules(rules) {
    for (const r of rules) {
      this.addRule(r);
    }
  }

  /**
   * 评估文本是否触发上下文敏感规则
   * @param {string} text  - 要分析的文本
   * @returns {object|null} { trigger, canonical, confidence, matchedSignal } 或 null
   */
  evaluate(text) {
    const lower = text.toLowerCase();

    for (const rule of this.rules) {
      // 检查触发词是否在文本中
      if (!lower.includes(rule.trigger)) continue;

      // 检查周边文本是否包含负面信号
      const matchedSignal = rule.negativeSignals.find(s => lower.includes(s));

      if (matchedSignal) {
        // 有负面信号 → suspicious
        rule.hitCount++;
        this._save();
        return {
          verdict: 'suspicious',
          trigger: rule.trigger,
          canonical: rule.canonical,
          confidence: Math.min(rule.confidence + 0.1, 0.95), // 命中后置信度递增
          matchedSignal,
          source: rule.source,
        };
      } else {
        // 触发词出现但无负面信号 → safe
        rule.hitCount++;
        this._save();
        return {
          verdict: 'safe',
          trigger: rule.trigger,
          canonical: rule.canonical,
          confidence: 1.0,
          matchedSignal: null,
          source: rule.source,
          note: 'Trigger word found but no negative context',
        };
      }
    }

    return null;
  }

  /**
   * 评估文本是否触发上下文敏感规则 — 收集所有匹配规则
   * @param {string} text  - 要分析的文本
   * @returns {Array<object>} [{ trigger, canonical, confidence, matchedSignal, verdict, note }]
   */
  evaluateAll(text) {
    const results = [];
    const lower = text.toLowerCase();

    for (const rule of this.rules) {
      // 检查触发词是否在文本中
      if (!lower.includes(rule.trigger)) continue;

      // 检查周边文本是否包含负面信号
      const matchedSignal = rule.negativeSignals.find(s => lower.includes(s));

      if (matchedSignal) {
        // 有负面信号 → suspicious
        rule.hitCount++;
        results.push({
          verdict: 'suspicious',
          trigger: rule.trigger,
          canonical: rule.canonical,
          confidence: Math.min(rule.confidence + 0.1, 0.95),
          matchedSignal,
          source: rule.source,
        });
      } else {
        // 触发词出现但无负面信号 → safe
        rule.hitCount++;
        results.push({
          verdict: 'safe',
          trigger: rule.trigger,
          canonical: rule.canonical,
          confidence: 1.0,
          matchedSignal: null,
          source: rule.source,
          note: 'Trigger word found but no negative context',
        });
      }
    }

    this._save();
    return results;
  }

  /**
   * 获取所有规则
   */
  getAllRules() {
    return [...this.rules];
  }

  /** 清理低置信度规则 */
  prune(minConfidence = 0.3) {
    this.rules = this.rules.filter(r => r.confidence >= minConfidence);
    this._save();
  }

  _load() {
    try {
      const data = GM_getValue(CONTEXT_RULES_KEY, '[]');
      this.rules = JSON.parse(data);
    } catch (e) {
      this.rules = [];
    }
  }

  _save() {
    try {
      GM_setValue(CONTEXT_RULES_KEY, JSON.stringify(this.rules));
    } catch (e) { /* silent */ }
  }
}