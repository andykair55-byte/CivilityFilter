/**
 * context-window.js — 短时上下文窗口
 *
 * 按发言者分组，在时间窗口内缓存消息，支持组合分析。
 * 用于检测跨消息拆分攻击（Wiki A2）。
 *
 * 触发条件（同时满足）：
 *   - 同一发言者在窗口内 ≥ 2 条消息
 *   - 单条独立判断均未命中 Layer 1/2
 *   - 任意一条消息长度 ≤ 5 个字符（拆分特征）
 */

const DEFAULT_WINDOW_MS = 60000;  // 60 秒
const MAX_WINDOW_MS = 120000;     // 120 秒上限
const MAX_MESSAGES_PER_USER = 20; // 单用户最多缓存消息数

/**
 * @typedef {Object} WindowMessage
 * @property {string} text       原始文本
 * @property {string} username   发言者
 * @property {number} timestamp  时间戳
 * @property {object} result     检测结果（Layer 1/2 的 verdict）
 * @property {HTMLElement} element  DOM 元素引用
 */

export class ContextWindow {
  /**
   * @param {object} [options]
   * @param {number} [options.windowMs]  时间窗口长度（毫秒），默认 60s
   */
  constructor(options = {}) {
    this.windowMs = Math.min(options.windowMs || DEFAULT_WINDOW_MS, MAX_WINDOW_MS);

    /** @type {Map<string, WindowMessage[]>}  username → messages */
    this._buffer = new Map();

    // 定时清理
    this._cleanupTimer = setInterval(() => this._cleanup(), 10000);
  }

  /**
   * 添加一条消息到窗口
   * @param {string} username  发言者用户名
   * @param {string} text      消息文本
   * @param {object} result    Layer 1/2 检测结果
   * @param {HTMLElement} element  DOM 元素
   */
  addMessage(username, text, result, element) {
    if (!username) return;

    if (!this._buffer.has(username)) {
      this._buffer.set(username, []);
    }

    const messages = this._buffer.get(username);
    messages.push({
      text,
      username,
      timestamp: Date.now(),
      result,
      element,
    });

    // 限制缓存大小
    if (messages.length > MAX_MESSAGES_PER_USER) {
      messages.shift();
    }
  }

  /**
   * 检查是否需要对某用户的消息进行组合分析
   * @param {string} username
   * @returns {boolean}
   */
  shouldCombine(username) {
    if (!username || !this._buffer.has(username)) return false;

    const messages = this._getActiveMessages(username);
    if (messages.length < 2) return false;

    // 检查是否有短消息（拆分特征）
    const hasShortMessage = messages.some(m => m.text.length <= 5);
    if (!hasShortMessage) return false;

    // 检查是否所有单条均未命中 Layer 1/2（即都是 safe 或 suspicious）
    const allMissed = messages.every(m =>
      !m.result || m.result.verdict === 'safe' || m.result.verdict === 'suspicious'
    );

    return allMissed;
  }

  /**
   * 获取某用户在窗口内的消息组合（拼接文本）
   * @param {string} username
   * @returns {{ combinedText: string, messages: WindowMessage[] } | null}
   */
  getCombined(username) {
    if (!username || !this._buffer.has(username)) return null;

    const messages = this._getActiveMessages(username);
    if (messages.length < 2) return null;

    // 按时间排序，拼接文本
    const sorted = messages.sort((a, b) => a.timestamp - b.timestamp);
    const combinedText = sorted.map(m => m.text).join(' ');

    return {
      combinedText,
      messages: sorted,
      elements: sorted.map(m => m.element).filter(Boolean),
    };
  }

  /**
   * 获取某用户在窗口内的活跃消息（未过期的）
   * @param {string} username
   * @returns {WindowMessage[]}
   */
  _getActiveMessages(username) {
    const messages = this._buffer.get(username) || [];
    const cutoff = Date.now() - this.windowMs;
    return messages.filter(m => m.timestamp >= cutoff);
  }

  /** 清理过期消息 */
  _cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [username, messages] of this._buffer) {
      const active = messages.filter(m => m.timestamp >= cutoff);
      if (active.length === 0) {
        this._buffer.delete(username);
      } else {
        this._buffer.set(username, active);
      }
    }
  }

  /** 获取当前窗口中所有用户的消息统计 */
  getStats() {
    const stats = { users: 0, totalMessages: 0 };
    for (const [username, messages] of this._buffer) {
      const active = this._getActiveMessages(username);
      if (active.length > 0) {
        stats.users++;
        stats.totalMessages += active.length;
      }
    }
    return stats;
  }

  /** 清空所有缓存 */
  clear() {
    this._buffer.clear();
  }

  /** 销毁定时器 */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._buffer.clear();
  }
}
