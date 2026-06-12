/**
 * Layer 4 - Output Protocol: structured JSON contract for frontend rendering
 */

/**
 * Supported intent types for user input classification
 */
export enum IntentType {
  TOPIC_CREATE = 'topic_create',
  INSTRUCTION_OPERATION = 'instruction_operation',
  INFORMATION_QUERY = 'information_query',
  AMBIGUOUS = 'ambiguous',
  NEW_INTENT = 'new_intent'
}

/**
 * Context resolution for ambiguous inputs
 */
export enum ContextResolution {
  CONFIRM_ALL = 'confirm_all',
  REJECT_SUGGESTIONS = 'reject_suggestions',
  CLARIFICATION_RESPONSE = 'clarification_response',
  UNKNOWN = 'unknown'
}

/**
 * 推荐项 - 可点击的过滤范围选项
 */
export interface RecommendationItem {
  id: string;
  label: string;
  type: 'scope' | 'keyword' | 'category';
  reason: string;
  selected: boolean;
}

/**
 * 澄清问题
 */
export interface ClarificationQuestion {
  id: string;
  text: string;
  options: ClarificationOption[];
  required: boolean;
}

/**
 * 关键词组
 */
export interface KeywordGroup {
  category: string;
  keywords: string[];
}

/**
 * UI 动作指令
 */
export interface UIAction {
  type: 'render_cards' | 'wait_user_choice' | 'show_preview' | 'show_loading';
  payload: Record<string, unknown>;
}

/**
 * A single suggestion item (e.g., keyword card)
 */
export interface SuggestionItem {
  id: string;
  label: string;
  selected: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * A single action button
 */
export interface ActionButton {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'ghost' | 'danger';
}

/**
 * A single clarification option
 */
export interface ClarificationOption {
  id: string;
  label: string;
}

/**
 * The complete agent response contract
 * 扩展版：支持推荐卡片、澄清问题、关键词组、UI动作
 */
export interface AgentResponse {
  state: string;
  message: string;
  suggestions?: SuggestionItem[];
  actions?: ActionButton[];
  options?: ClarificationOption[];
  recommendations?: RecommendationItem[];
  questions?: ClarificationQuestion[];
  keywordGroups?: KeywordGroup[];
  uiActions?: UIAction[];
  warnings?: string[];
  confidence: number;
  metadata?: {
    resolvedIntent?: string;
    resolvedTopic?: string;
    resolvedCategory?: string;
    contextResolution?: string;
    previousState?: string;
    turnCount?: number;
    [key: string]: unknown;
  };
}

/**
 * User input with context
 */
export interface UserInput {
  content: string;
  sessionId: string;
  timestamp: number;
  selectedItems?: string[];
}

/**
 * Engine configuration
 */
export interface EngineConfig {
  confidenceThreshold: number;
  maxContextTurns: number;
  clarificationLimit: number;
  enableMemoryPromotion: boolean;
  llmEndpoint?: string;
  llmApiKey?: string;
  llmModel?: string;
  useLlm?: boolean;
}

/**
 * Validation result for protocol checking
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
