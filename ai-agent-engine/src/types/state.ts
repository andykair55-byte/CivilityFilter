/**
 * State machine states for the agent engine
 */
export enum AgentState {
  IDLE = 'IDLE',
  ANALYZE = 'ANALYZE',
  UNDERSTANDING = 'UNDERSTANDING',
  SUGGEST = 'SUGGEST',
  CLARIFYING = 'CLARIFYING',
  RECOMMENDING = 'RECOMMENDING',
  EXECUTING = 'EXECUTING',
  DONE = 'DONE'
}

/**
 * State transition rules for the agent state machine
 */
export const STATE_TRANSITIONS: Record<AgentState, AgentState[]> = {
  [AgentState.IDLE]: [AgentState.ANALYZE],
  [AgentState.ANALYZE]: [AgentState.SUGGEST, AgentState.CLARIFYING],
  [AgentState.UNDERSTANDING]: [AgentState.CLARIFYING, AgentState.SUGGEST, AgentState.EXECUTING],
  [AgentState.SUGGEST]: [AgentState.CLARIFYING, AgentState.RECOMMENDING],
  [AgentState.CLARIFYING]: [AgentState.ANALYZE, AgentState.SUGGEST],
  [AgentState.RECOMMENDING]: [AgentState.EXECUTING, AgentState.RECOMMENDING, AgentState.CLARIFYING],
  [AgentState.EXECUTING]: [AgentState.DONE],
  [AgentState.DONE]: [AgentState.IDLE]
};

/**
 * Check if a state transition is valid
 */
export function canTransition(from: AgentState, to: AgentState): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}
