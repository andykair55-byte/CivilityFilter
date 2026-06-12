/**
 * audit-log.js — 任务审计日志
 *
 * 记录 AI 任务流的每一步关键事件：
 *   user_input → ai_understanding → ai_plan → clarification → user_confirmation
 *   → execution → result → rollback / error
 *
 * 用途：
 *   1. UI 展示"AI 做了什么、为什么、怎么撤销"
 *   2. 排查任务失败
 *   3. 用户可回看最近 N 个任务的完整轨迹
 *
 * 设计：
 *   - 内存为主 + GM_setValue 持久化最近 200 条
 *   - 支持按 taskId 过滤
 *   - 事件订阅：onEvent() 返回 unsubscribe
 *   - 导出为 JSON 字符串（供 UI 复制）
 */

import { makeId } from './types.js';

const STORAGE_KEY = 'cs_ai_audit_log';
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export class AuditLog {
  constructor() {
    /** @type {AuditLogEntry[]} */
    this._entries = [];
    this._listeners = new Set();
    this._load();
  }

  /**
   * 记录一条审计事件
   * @param {object} entry
   * @returns {AuditLogEntry}
   */
  log(entry) {
    const e = {
      id: makeId('log'),
      timestamp: entry.timestamp || Date.now(),
      taskId: entry.taskId || null,
      type: entry.type,
      actor: entry.actor || 'ai',
      riskLevel: entry.riskLevel || null,
      payload: entry.payload || null,
      summary: entry.summary || null,
    };
    this._entries.push(e);
    this._enforceLimit();
    this._persist();
    this._emit(e);
    return e;
  }

  // 便捷方法
  userInput(taskId, input) { return this.log({ taskId, type: 'user_input', actor: 'user', payload: { input }, summary: input?.slice(0, 80) }); }
  aiUnderstanding(taskId, understanding) { return this.log({ taskId, type: 'ai_understanding', actor: 'ai', payload: understanding, summary: understanding?.intent || '理解意图' }); }
  aiPlan(taskId, plan) { return this.log({ taskId, type: 'ai_plan', actor: 'ai', payload: { plan }, summary: `计划 ${plan?.length || 0} 步` }); }
  clarification(taskId, questions) { return this.log({ taskId, type: 'clarification', actor: 'ai', payload: { questions }, summary: `询问 ${questions?.length || 0} 个问题` }); }
  userConfirmation(taskId, confirmed, message) { return this.log({ taskId, type: 'user_confirmation', actor: 'user', payload: { confirmed }, summary: confirmed ? '用户确认执行' : '用户取消' }); }
  execution(taskId, opId, type) { return this.log({ taskId, type: 'execution', actor: 'system', payload: { opId, opType: type }, summary: `执行 ${type}` }); }
  result(taskId, ok, summary) { return this.log({ taskId, type: 'result', actor: 'system', payload: { ok }, summary: summary || (ok ? '执行成功' : '执行失败') }); }
  rollback(taskId, opId) { return this.log({ taskId, type: 'rollback', actor: 'system', payload: { opId }, summary: '已回滚' }); }
  error(taskId, message) { return this.log({ taskId, type: 'error', actor: 'system', payload: { error: message }, summary: `错误: ${message?.slice(0, 80)}` }); }

  /**
   * 订阅事件（任务执行过程中实时推送）
   * @param {function} fn
   * @returns {function} unsubscribe
   */
  onEvent(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * 查询某 taskId 的所有日志
   * @param {string} taskId
   * @returns {AuditLogEntry[]}
   */
  forTask(taskId) {
    return this._entries.filter(e => e.taskId === taskId).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 查询最近 N 条
   * @param {number} [n=50]
   * @returns {AuditLogEntry[]}
   */
  recent(n = 50) {
    return this._entries.slice(-n).reverse();
  }

  /**
   * 按类型过滤
   * @param {string} type
   * @param {number} [n=20]
   */
  byType(type, n = 20) {
    return this._entries.filter(e => e.type === type).slice(-n).reverse();
  }

  /**
   * 导出为可读文本
   * @param {string} [taskId]
   */
  exportText(taskId) {
    const entries = taskId ? this.forTask(taskId) : this.recent(50);
    const lines = entries.map(e => {
      const t = new Date(e.timestamp).toLocaleTimeString();
      return `[${t}] [${e.actor}] [${e.type}] ${e.summary || ''}`;
    });
    return lines.join('\n');
  }

  /**
   * 清空
   */
  clear() {
    this._entries = [];
    this._persist();
  }

  /**
   * 统计
   */
  stats() {
    return {
      total: this._entries.length,
      tasks: new Set(this._entries.map(e => e.taskId).filter(Boolean)).size,
      executions: this._entries.filter(e => e.type === 'execution').length,
      rollbacks: this._entries.filter(e => e.type === 'rollback').length,
      errors: this._entries.filter(e => e.type === 'error').length,
    };
  }

  // ── 内部 ──

  _emit(entry) {
    for (const fn of this._listeners) {
      try { fn(entry); } catch (e) { /* silent */ }
    }
  }

  _enforceLimit() {
    const now = Date.now();
    this._entries = this._entries.filter(
      e => e.timestamp && now - e.timestamp < MAX_AGE_MS
    );
    if (this._entries.length > MAX_ENTRIES) {
      this._entries = this._entries.slice(-MAX_ENTRIES);
    }
  }

  _load() {
    try {
      const raw = GM_getValue(STORAGE_KEY, '[]');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) this._entries = list;
    } catch (e) { /* silent */ }
    this._enforceLimit();
  }

  _persist() {
    try {
      GM_setValue(STORAGE_KEY, JSON.stringify(this._entries));
    } catch (e) { /* silent */ }
  }
}
