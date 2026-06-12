/**
 * task-state-machine.js — 任务级状态机（10 状态）
 *
 * 与原 state-machine.js（对话级，7 状态）的区别：
 *   - 原 state-machine 描述"对话流"，本文件描述"任务生命周期"
 *   - 任务状态机是顶层；对话级状态机可作为子模块嵌入
 *   - 所有副作用必须先经过任务状态机才能执行
 *
 * 状态说明：
 *   IDLE                 - 空闲
 *   ANALYZING            - 正在分析用户意图
 *   CLARIFYING           - 等待用户回答澄清问题
 *   PLANNING             - 正在生成执行计划
 *   RECOMMENDING         - 展示推荐方案（轻量操作无需确认）
 *   WAITING_CONFIRMATION - 等待用户对高风险操作的确认
 *   EXECUTING            - 正在执行业务模块调用
 *   DONE                 - 成功完成
 *   FAILED               - 失败（可重试/回滚）
 *   ROLLED_BACK          - 已回滚
 *
 * 转换规则：
 *   - 任何状态可被 cancel() 强制回到 IDLE（rollback 决策点）
 *   - FAILED 可由用户选择 rollback 回到 ROLLED_BACK
 *   - 用户重试时由 FAILED → ANALYZING
 */

import { TASK_STATUS, makeId } from './types.js';

const VALID_TRANSITIONS = {
  [TASK_STATUS.IDLE]: [
    TASK_STATUS.ANALYZING,
  ],
  [TASK_STATUS.ANALYZING]: [
    TASK_STATUS.CLARIFYING,
    TASK_STATUS.PLANNING,
    TASK_STATUS.RECOMMENDING,
    TASK_STATUS.DONE,        // 纯说明（query）
    TASK_STATUS.FAILED,
    TASK_STATUS.IDLE,
  ],
  [TASK_STATUS.CLARIFYING]: [
    TASK_STATUS.ANALYZING,
    TASK_STATUS.PLANNING,
    TASK_STATUS.IDLE,
    TASK_STATUS.FAILED,
  ],
  [TASK_STATUS.PLANNING]: [
    TASK_STATUS.RECOMMENDING,
    TASK_STATUS.WAITING_CONFIRMATION,
    TASK_STATUS.EXECUTING,   // L0/L1 直通
    TASK_STATUS.FAILED,
    TASK_STATUS.IDLE,
  ],
  [TASK_STATUS.RECOMMENDING]: [
    TASK_STATUS.WAITING_CONFIRMATION,
    TASK_STATUS.EXECUTING,   // 用户点确认
    TASK_STATUS.IDLE,
    TASK_STATUS.FAILED,
  ],
  [TASK_STATUS.WAITING_CONFIRMATION]: [
    TASK_STATUS.EXECUTING,
    TASK_STATUS.CLARIFYING,  // 用户修改计划
    TASK_STATUS.IDLE,        // 取消
    TASK_STATUS.FAILED,
  ],
  [TASK_STATUS.EXECUTING]: [
    TASK_STATUS.DONE,
    TASK_STATUS.FAILED,
  ],
  [TASK_STATUS.DONE]: [
    TASK_STATUS.ROLLED_BACK,
    TASK_STATUS.IDLE,
  ],
  [TASK_STATUS.FAILED]: [
    TASK_STATUS.ROLLED_BACK,
    TASK_STATUS.ANALYZING,   // 重试
    TASK_STATUS.IDLE,
  ],
  [TASK_STATUS.ROLLED_BACK]: [
    TASK_STATUS.IDLE,
  ],
};

/**
 * 创建任务状态机实例（闭包风格，状态私有）
 * @param {object} [opts]
 * @param {AuditLog} [opts.auditLog]  日志组件（可选）；状态变化会写入
 * @returns {object}
 */
export function createTaskStateMachine(opts = {}) {
  const auditLog = opts.auditLog || null;

  let status = TASK_STATUS.IDLE;
  let history = []; // [{ from, to, at, reason }]
  let currentTaskId = null;

  function _transition(to, reason = '') {
    const from = status;
    if (from === to) return true;
    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      // 非法转换：忽略并记录
      history.push({ from, to, at: Date.now(), reason: 'invalid' });
      if (auditLog) auditLog.error(currentTaskId, `非法状态转换 ${from}→${to}`);
      return false;
    }
    status = to;
    history.push({ from, to, at: Date.now(), reason });
    if (auditLog && to !== TASK_STATUS.ANALYZING) {
      // 状态切换写入日志（避免 ANALYZING 噪音过大）
      auditLog.log({
        taskId: currentTaskId,
        type: 'state_change',
        actor: 'system',
        payload: { from, to, reason },
        summary: `${from} → ${to}`,
      });
    }
    return true;
  }

  return {
    getStatus() { return status; },
    getHistory() { return [...history]; },
    getCurrentTaskId() { return currentTaskId; },

    /** 绑定当前 taskId（仅日志用途） */
    bindTaskId(taskId) { currentTaskId = taskId; },

    // ── 标准转换入口 ──
    startAnalyzing(taskId) {
      currentTaskId = taskId;
      return _transition(TASK_STATUS.ANALYZING, 'start');
    },
    moveToClarifying() { return _transition(TASK_STATUS.CLARIFYING, 'need_more_info'); },
    moveToPlanning() { return _transition(TASK_STATUS.PLANNING, 'plan_ready'); },
    moveToRecommending() { return _transition(TASK_STATUS.RECOMMENDING, 'recommendations_ready'); },
    moveToWaitingConfirmation() { return _transition(TASK_STATUS.WAITING_CONFIRMATION, 'await_user'); },
    moveToExecuting() { return _transition(TASK_STATUS.EXECUTING, 'user_confirmed'); },
    complete(result) {
      const ok = _transition(TASK_STATUS.DONE, 'success');
      return { ok, status, result };
    },
    fail(error) {
      const ok = _transition(TASK_STATUS.FAILED, 'error');
      return { ok, status, error };
    },
    rollback() {
      return _transition(TASK_STATUS.ROLLED_BACK, 'user_undo');
    },
    cancel(reason = 'user_cancel') {
      return _transition(TASK_STATUS.IDLE, reason);
    },
    reset() {
      status = TASK_STATUS.IDLE;
      currentTaskId = null;
      history = [];
    },

    /**
     * 检查给定状态是否可达（用于 UI 守卫）
     */
    canTransition(to) {
      return VALID_TRANSITIONS[status]?.includes(to) || false;
    },

    /**
     * 当前可执行的动作（供 UI 启用/禁用按钮）
     */
    availableActions() {
      return VALID_TRANSITIONS[status] || [];
    },
  };
}
