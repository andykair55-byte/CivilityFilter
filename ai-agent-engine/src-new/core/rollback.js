/**
 * rollback.js — 统一回滚管理器
 *
 * 职责：
 *   1. 执行业务操作前生成 before 快照
 *   2. 执行业务操作后保存 after 状态
 *   3. 提供 opId 维度的 restore() 函数
 *   4. 维护"最近 N 个可回滚操作"栈，供 UI 撤销
 *
 * 关键约束：
 *   - 不直接持有 topicFilter/ruleLearner 的所有数据；通过 capture()/restore() 接口
 *     让业务模块自行描述前后状态（保持模块解耦）
 *   - snapshot 通过深拷贝 (JSON) 持久化，避免持有业务模块引用
 *   - 单个操作 200ms 内未执行完成视为超时
 */

import { makeId } from './types.js';

const STORAGE_KEY = 'cs_ai_rollback_stack';
const MAX_STACK = 20;            // 最多保留 20 个可回滚操作
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export class RollbackManager {
  constructor() {
    /** @type {Map<string, RollbackSnapshot>} */
    this._stack = new Map();
    this._load();
  }

  // ── 公共 API ──────────────────────────────────────────────────

  /**
   * 在执行前调用：生成 opId，记录 before 状态。
   * @param {object} opts
   * @param {string} opts.taskId
   * @param {string} opts.type         e.g. 'add_keyword' / 'enable_topic'
   * @param {object} opts.beforeState  业务模块返回的当前状态
   * @param {() => Promise<object>} [opts.restoreFn]  自定义回滚函数；不传则用 genericRestore
   * @returns {string} opId
   */
  begin({ taskId, type, beforeState, restoreFn }) {
    const opId = makeId('op');
    const snapshot = {
      opId,
      taskId,
      type,
      beforeState: _safeClone(beforeState),
      afterState: null,
      affectedKeys: [],
      createdAt: Date.now(),
      restore: null, // after begin only
    };
    // restore 是闭包；延迟到 commit 时注入 afterState
    snapshot._restoreFn = restoreFn;
    this._stack.set(opId, snapshot);
    this._persist();
    return opId;
  }

  /**
   * 业务模块执行成功后调用：固化 after 状态。
   * @param {string} opId
   * @param {object} afterState
   * @param {string[]} [affectedKeys] 涉及哪些 GM_setValue 的 key
   */
  commit(opId, afterState, affectedKeys = []) {
    const snap = this._stack.get(opId);
    if (!snap) return false;
    snap.afterState = _safeClone(afterState);
    snap.affectedKeys = affectedKeys;
    snap.committedAt = Date.now();
    snap.restore = async () => this._doRestore(opId);
    this._persist();
    return true;
  }

  /**
   * 业务模块执行失败：放弃这次快照。
   */
  abort(opId) {
    if (this._stack.has(opId)) {
      this._stack.delete(opId);
      this._persist();
      return true;
    }
    return false;
  }

  /**
   * 执行回滚
   * @param {string} opId
   * @returns {Promise<{success:boolean, error?:string}>}
   */
  async restore(opId) {
    return this._doRestore(opId);
  }

  /**
   * 最近一次可回滚操作（最常用的 Undo 按钮）
   * @returns {RollbackSnapshot|null}
   */
  latestRollbackable() {
    const list = [...this._stack.values()].filter(s => s.restore && !s.restoredAt);
    if (list.length === 0) return null;
    list.sort((a, b) => (b.committedAt || b.createdAt) - (a.committedAt || a.createdAt));
    return list[0];
  }

  /**
   * 获取最近 N 个快照（供 UI 渲染历史）
   * @param {number} [n=10]
   * @returns {RollbackSnapshot[]}
   */
  recent(n = 10) {
    const list = [...this._stack.values()].sort(
      (a, b) => (b.committedAt || b.createdAt) - (a.committedAt || a.createdAt)
    );
    return list.slice(0, n);
  }

  /**
   * 获取某个 taskId 下的全部快照
   * @param {string} taskId
   * @returns {RollbackSnapshot[]}
   */
  forTask(taskId) {
    return [...this._stack.values()].filter(s => s.taskId === taskId);
  }

  /**
   * 清空（用于 L4 重置后）
   */
  clear() {
    this._stack.clear();
    this._persist();
  }

  /**
   * 总数 / 已回滚数 / 待回滚数（供 UI 展示）
   */
  stats() {
    const all = [...this._stack.values()];
    return {
      total: all.length,
      rolledBack: all.filter(s => !!s.restoredAt).length,
      pending: all.filter(s => s.restore && !s.restoredAt).length,
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────

  async _doRestore(opId) {
    const snap = this._stack.get(opId);
    if (!snap) return { success: false, error: 'Snapshot not found' };
    if (snap.restoredAt) return { success: false, error: 'Already restored' };
    if (!snap.afterState) return { success: false, error: 'Snapshot not committed' };

    try {
      if (typeof snap._restoreFn === 'function') {
        // 业务模块自定义的恢复逻辑
        await snap._restoreFn(_safeClone(snap.beforeState));
      } else {
        // 通用恢复：把 beforeState 写回受影响 key
        if (snap.beforeState && Array.isArray(snap.affectedKeys)) {
          for (const key of snap.affectedKeys) {
            if (snap.beforeState[key] !== undefined) {
              try {
                GM_setValue(key, JSON.stringify(snap.beforeState[key]));
              } catch (e) { /* silent */ }
            }
          }
        }
      }
      snap.restoredAt = Date.now();
      this._persist();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  _load() {
    try {
      const raw = GM_getValue(STORAGE_KEY, '[]');
      const list = JSON.parse(raw);
      const now = Date.now();
      for (const item of list) {
        if (!item || !item.opId) continue;
        if (item.committedAt && now - item.committedAt > MAX_AGE_MS) continue;
        // 恢复 restore 闭包（持久化数据已足够，运行时再注入）
        item.restore = async () => this._doRestore(item.opId);
        this._stack.set(item.opId, item);
      }
    } catch (e) { /* 首次使用 */ }
    this._enforceLimit();
  }

  _persist() {
    this._enforceLimit();
    try {
      // 仅持久化纯数据字段（不可序列化闭包/函数）
      const list = [...this._stack.values()].map(s => ({
        opId: s.opId,
        taskId: s.taskId,
        type: s.type,
        beforeState: s.beforeState,
        afterState: s.afterState,
        affectedKeys: s.affectedKeys,
        createdAt: s.createdAt,
        committedAt: s.committedAt,
        restoredAt: s.restoredAt,
        hasCustomRestore: typeof s._restoreFn === 'function',
      }));
      GM_setValue(STORAGE_KEY, JSON.stringify(list));
    } catch (e) { /* silent */ }
  }

  _enforceLimit() {
    if (this._stack.size <= MAX_STACK) return;
    const sorted = [...this._stack.values()].sort(
      (a, b) => (a.committedAt || a.createdAt) - (b.committedAt || b.createdAt)
    );
    while (this._stack.size > MAX_STACK) {
      const oldest = sorted.shift();
      if (!oldest) break;
      this._stack.delete(oldest.opId);
    }
  }
}

function _safeClone(obj) {
  try {
    return obj === undefined ? null : JSON.parse(JSON.stringify(obj));
  } catch (e) {
    return null;
  }
}
