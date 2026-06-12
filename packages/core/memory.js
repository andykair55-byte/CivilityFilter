/**
 * memory.js — 三级记忆管理系统
 *
 * 短期记忆（session）：同一会话内的上下文拼接
 * 中期记忆（recent）：近期话题偏好和常见绕过模式
 * 长期记忆（stable）：稳定偏好、系统规则库、多次命中的风险模式
 *
 * 记忆条目格式：
 * {
 *   id:        string,
 *   type:      'topic' | 'pattern' | 'rule' | 'preference',
 *   key:       string,        // 记忆键（如 topic id、pattern trigger）
 *   value:     any,           // 记忆值
 *   confidence: number,       // 0.0~1.0
 *   hitCount:  number,        // 命中次数
 *   lastHit:   number,        // 最后命中时间戳
 *   createdAt: number,        // 创建时间戳
 *   source:    string,        // 'ai_learned' | 'user_feedback' | 'system'
 * }
 */

const MEMORY_KEY = 'cs_memory';

// 记忆分层过期策略
const EXPIRY = {
  short:  2 * 60 * 60 * 1000,       // 2 小时（会话级）
  medium: 7 * 24 * 60 * 60 * 1000,  // 7 天
  long:   30 * 24 * 60 * 60 * 1000, // 30 天
};

// 置信度阈值
const CONFIDENCE = {
  AUTO_DELETE: 0.45,    // 低于此值自动删除
  HIT_BOOST: 0.02,      // 每次命中 +0.02
  CORRECTION_PENALTY: 0.1, // 用户纠正 -0.1
  MAX_CONFIDENCE: 0.95,
  FORCE_DELETE_HITS: 3,    // 累计反向标记次数达到此值强制删除
};

export class MemoryManager {
  constructor() {
    /** @type {Map<string, object>} id → memory entry */
    this._store = new Map();
    this._load();
  }

  // ─── 写入 ──────────────────────────────────────────────────────────────────

  /**
   * 写入一条记忆
   * @param {object} entry
   * @param {string} entry.type
   * @param {string} entry.key
   * @param {any}    entry.value
   * @param {number} [entry.confidence]
   * @param {string} [entry.source]
   * @returns {string} entry id
   */
  write(entry) {
    const id = `${entry.type}_${entry.key}_${Date.now()}`;
    this._store.set(id, {
      id,
      type: entry.type,
      key: entry.key,
      value: entry.value,
      confidence: entry.confidence || 0.5,
      hitCount: 0,
      reverseCount: 0,
      lastHit: 0,
      createdAt: Date.now(),
      source: entry.source || 'system',
    });
    this._save();
    return id;
  }

  // ─── 读取 ──────────────────────────────────────────────────────────────────

  /**
   * 按类型查询记忆
   * @param {string} type
   * @returns {object[]}
   */
  queryByType(type) {
    const results = [];
    for (const entry of this._store.values()) {
      if (entry.type === type) results.push({ ...entry });
    }
    return results;
  }

  /**
   * 按键查询记忆
   * @param {string} key
   * @returns {object|null}
   */
  queryByKey(key) {
    for (const entry of this._store.values()) {
      if (entry.key === key) return { ...entry };
    }
    return null;
  }

  /**
   * 获取短期记忆中指定用户的所有条目（用于会话上下文）
   * @param {string} username
   * @returns {object[]}
   */
  getSessionContext(username) {
    const cutoff = Date.now() - EXPIRY.short;
    const results = [];
    for (const entry of this._store.values()) {
      if (entry.type === 'session' && entry.key === username && entry.createdAt >= cutoff) {
        results.push({ ...entry });
      }
    }
    return results;
  }

  // ─── 命中更新 ────────────────────────────────────────────────────────────────

  /**
   * 记录一次命中，提升置信度
   * @param {string} id
   */
  recordHit(id) {
    const entry = this._store.get(id);
    if (!entry) return;
    entry.hitCount++;
    entry.lastHit = Date.now();
    entry.confidence = Math.min(
      entry.confidence + CONFIDENCE.HIT_BOOST,
      CONFIDENCE.MAX_CONFIDENCE
    );
    this._save();
  }

  /**
   * 记录一次用户反向标记（误判纠正），降低置信度
   * @param {string} id
   * @returns {boolean} 是否被强制删除
   */
  recordCorrection(id) {
    const entry = this._store.get(id);
    if (!entry) return false;

    entry.reverseCount = (entry.reverseCount || 0) + 1;
    entry.confidence = Math.max(entry.confidence - CONFIDENCE.CORRECTION_PENALTY, 0);

    // 累计反向标记达到阈值，强制删除
    if (entry.reverseCount >= CONFIDENCE.FORCE_DELETE_HITS) {
      this._store.delete(id);
      this._save();
      return true;
    }

    // 置信度低于阈值，自动删除
    if (entry.confidence < CONFIDENCE.AUTO_DELETE) {
      this._store.delete(id);
      this._save();
      return true;
    }

    this._save();
    return false;
  }

  // ─── 清理 ──────────────────────────────────────────────────────────────────

  /** 运行全量清理（建议每次启动时调用一次） */
  prune() {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of this._store) {
      let shouldDelete = false;

      // 置信度太低
      if (entry.confidence < CONFIDENCE.AUTO_DELETE) {
        shouldDelete = true;
      }

      // 按分层过期策略
      const maxAge = this._getExpiry(entry.type);
      if (now - entry.createdAt > maxAge) {
        // 从未命中过 + 超过 30 天 → 删除
        if (entry.hitCount === 0 && now - entry.createdAt > EXPIRY.long) {
          shouldDelete = true;
        }
        // 长期未命中 + 过期 → 删除
        if (entry.lastHit > 0 && now - entry.lastHit > maxAge) {
          shouldDelete = true;
        }
      }

      if (shouldDelete) {
        this._store.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this._save();
      console.debug(`[CyberShield] Memory: pruned ${cleaned} entries`);
    }

    return cleaned;
  }

  /** 根据记忆类型获取过期时间 */
  _getExpiry(type) {
    switch (type) {
      case 'session':    return EXPIRY.short;
      case 'topic':
      case 'pattern':    return EXPIRY.medium;
      case 'rule':
      case 'preference': return EXPIRY.long;
      default:           return EXPIRY.medium;
    }
  }

  // ─── 统计 ──────────────────────────────────────────────────────────────────

  getStats() {
    const stats = { total: 0, byType: {} };
    for (const entry of this._store.values()) {
      stats.total++;
      stats.byType[entry.type] = (stats.byType[entry.type] || 0) + 1;
    }
    return stats;
  }

  // ─── 持久化 ────────────────────────────────────────────────────────────────

  _load() {
    try {
      const data = JSON.parse(GM_getValue(MEMORY_KEY, '[]'));
      if (Array.isArray(data)) {
        for (const entry of data) {
          this._store.set(entry.id, entry);
        }
      }
    } catch (e) {
      this._store = new Map();
    }
  }

  _save() {
    try {
      const arr = [...this._store.values()];
      GM_setValue(MEMORY_KEY, JSON.stringify(arr));
    } catch (e) { /* silent */ }
  }
}
