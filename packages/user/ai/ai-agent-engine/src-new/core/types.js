/**
 * types.js — AI 任务核心数据契约（JSDoc 定义）
 *
 * 集中定义 AITask、OperationRecord、AIAction、RollbackSnapshot 的形状，
 * 以及状态机使用的事件类型。所有运行时数据均按此契约流通。
 *
 * 遵循原则：
 *   1. 与现有 topicFilter / ruleLearner / memory 数据结构保持兼容
 *   2. 不引入强制依赖，可被纯函数或 class 消费
 *   3. 所有时间戳统一为 Date.now() 数字
 */

/**
 * @typedef {'idle'|'analyzing'|'clarifying'|'planning'|'recommending'|'waiting_confirmation'|'executing'|'done'|'failed'|'rolled_back'} TaskStatus
 */

/**
 * @typedef {'L0'|'L1'|'L2'|'L3'|'L4'} RiskLevel
 */

/**
 * 意图类型 — 复用并扩展 ai-agent-engine/core/intent.js
 * @typedef {'TOPIC_CREATE'|'DIAGNOSE'|'INFORMATION_QUERY'|'INSTRUCTION_OPERATION'|'AMBIGUOUS'|'UNDO'|'STATUS_QUERY'|'GENERAL_CHAT'} AIAgentIntent
 */

/**
 * @typedef {object} AITaskSlot
 * @property {string}   name
 * @property {any}      value
 * @property {number}   confidence     0.0-1.0
 * @property {string}   source         'user'|'ai'|'default'|'inferred'
 * @property {boolean}  required
 * @property {string}   [description]
 */

/**
 * 计划步骤（由 AI 生成、可执行）
 * @typedef {object} AITaskPlanStep
 * @property {string}   id
 * @property {string}   label            自然语言描述
 * @property {string}   module           'topicFilter'|'ruleLearner'|'scanner'|'storage'|'aiAnalyzer'
 * @property {string}   action           业务模块方法名
 * @property {object}   args             透传给业务模块的参数
 * @property {RiskLevel} riskLevel        本步骤的风险等级
 * @property {boolean}  [rollbackable]   是否可回滚
 * @property {string}   [rollbackPlan]   回滚描述
 */

/**
 * AI 任务对象 — 对话流的核心载体
 * @typedef {object} AITask
 * @property {string}          id
 * @property {string}          userInput
 * @property {AIAgentIntent}   intent
 * @property {AITaskSlot[]}    slots
 * @property {AITaskPlanStep[]} plan
 * @property {RiskLevel}       riskLevel
 * @property {TaskStatus}      status
 * @property {number}          createdAt
 * @property {number}          updatedAt
 * @property {OperationRecord[]} operations
 * @property {string|null}     rollbackToken     关联的 RollbackSnapshot opId
 * @property {boolean}         confirmationRequired
 * @property {string|null}     confirmationMessage
 * @property {object|null}     result
 * @property {object|null}     error
 * @property {object}          meta              附加元数据（平台、UI标签等）
 * ── 以下为 Business Service Agent 重构新增字段 ──────────
 * @property {'in_scope'|'out_of_scope'} domain             决策链第 1 层结果
 * @property {string}                     action             决策链第 2 层结果
 * @property {{
 *   topic?: string,
 *   scope?: string[],
 *   keywords?: string[],
 *   signal?: string
 * }}                                     entities          决策链第 3 层结果
 * @property {number}                     currentTurn       多轮对话第 N 轮
 * @property {number}                     slotFillingRounds 已澄清轮次
 */

/**
 * 操作记录 — 一次具体的副作用
 * @typedef {object} OperationRecord
 * @property {string}        opId
 * @property {string}        taskId
 * @property {string}        type               'add_keyword'|'enable_topic'|'create_topic'|'remove_keyword'|'disable_topic'|'update_rule'|...
 * @property {object|null}   before             操作前快照（业务模块相关数据）
 * @property {object|null}   after              操作后快照
 * @property {number}        timestamp
 * @property {boolean}       success
 * @property {boolean}       rollbackable
 * @property {string|null}   error
 */

/**
 * 结构性 AI 输出 — 给前端消费的格式
 * @typedef {object} AIAction
 * @property {AIAgentIntent}   intent
 * @property {number}          confidence         0.0-1.0
 * @property {object}          entities           提取出的实体 { topic?, keyword?, scope?, action? }
 * @property {boolean}         needClarification
 * @property {Array<{id:string,text:string,options:Array<{label:string,value:string}>}>} clarificationQuestions
 * @property {Array<{id:string,label:string,type?:string,reason?:string,selected?:boolean,pre?:string}>} recommendedOptions
 * @property {AITaskPlanStep[]} plan
 * @property {RiskLevel}        riskLevel
 * @property {Array<{module:string, action:string, args:object, label:string, riskLevel:RiskLevel, rollbackable:boolean}>} toolCalls
 * @property {string}          summaryForUser      给用户的自然语言回复
 * @property {boolean}         requiresConfirmation
 * @property {string|null}     [confirmationHint]
 * @property {boolean}         [canUndo]
 * @property {string|null}     [undoHint]
 */

/**
 * 回滚快照
 * @typedef {object} RollbackSnapshot
 * @property {string}      opId
 * @property {string}      taskId
 * @property {string}      type
 * @property {object}      beforeState
 * @property {object}      afterState
 * @property {string[]}    affectedKeys   涉及的存储键
 * @property {() => Promise<{success:boolean,error?:string}>} restore
 */

/**
 * 审计日志条目
 * @typedef {object} AuditLogEntry
 * @property {string}        id
 * @property {number}        timestamp
 * @property {string}        taskId
 * @property {string}        type             'user_input'|'ai_understanding'|'ai_plan'|'clarification'|'user_confirmation'|'execution'|'result'|'rollback'|'error'
 * @property {string}        [actor]          'user'|'ai'|'system'
 * @property {RiskLevel}     [riskLevel]
 * @property {object}        [payload]
 * @property {string}        [summary]
 */

/**
 * 主动模式
 * @typedef {'manual'|'auto'} AgentMode
 */

export const TASK_STATUS = Object.freeze({
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  CLARIFYING: 'clarifying',
  PLANNING: 'planning',
  RECOMMENDING: 'recommending',
  WAITING_CONFIRMATION: 'waiting_confirmation',
  EXECUTING: 'executing',
  DONE: 'done',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
});

export const RISK_LEVEL = Object.freeze({
  L0: 0,   // 只读
  L1: 1,   // 低风险（增量、自动可执行）
  L2: 2,   // 中等风险（默认需确认，auto 可跳过）
  L3: 3,   // 高风险（必须确认）
  L4: 4,   // 极高风险（必须二次确认）
});

/** 风险等级的可读名（用于 UI 展示） */
export const RISK_LEVEL_NAME = Object.freeze({
  [RISK_LEVEL.L0]: { zh: '只读',     en: 'read-only' },
  [RISK_LEVEL.L1]: { zh: '低风险',   en: 'low risk' },
  [RISK_LEVEL.L2]: { zh: '中等风险', en: 'medium risk' },
  [RISK_LEVEL.L3]: { zh: '高风险',   en: 'high risk' },
  [RISK_LEVEL.L4]: { zh: '极高风险', en: 'critical risk' },
});

export const AGENT_INTENT = Object.freeze({
  TOPIC_CREATE: 'TOPIC_CREATE',
  DIAGNOSE: 'DIAGNOSE',
  INFORMATION_QUERY: 'INFORMATION_QUERY',
  INSTRUCTION_OPERATION: 'INSTRUCTION_OPERATION',
  AMBIGUOUS: 'AMBIGUOUS',
  UNDO: 'UNDO',
  STATUS_QUERY: 'STATUS_QUERY',
  GENERAL_CHAT: 'GENERAL_CHAT',
});

export const AGENT_MODE = Object.freeze({
  MANUAL: 'manual',
  AUTO: 'auto',
});

/**
 * 业务域（决策链第 1 层）
 */
export const AGENT_DOMAIN = Object.freeze({
  IN_SCOPE: 'in_scope',
  OUT_OF_SCOPE: 'out_of_scope',
});

/**
 * 动作类型（决策链第 2 层）
 */
export const AGENT_ACTION = Object.freeze({
  CREATE: 'CREATE',
  MODIFY: 'MODIFY',
  QUERY: 'QUERY',
  DIAGNOSE: 'DIAGNOSE',
  LEARN: 'LEARN',
  ROLLBACK: 'ROLLBACK',
  CONFIRM: 'CONFIRM',
  CANCEL: 'CANCEL',
  CAPABILITY_LIST: 'CAPABILITY_LIST',   // 用户询问「你能做什么」
  NONE: 'NONE',
});

/**
 * 生成短 ID — 避免依赖 uuid/外部包
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeId(prefix = '') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${prefix ? '_' : ''}${ts}${rand}`;
}
