export interface RecommendationItem {
  id: string;
  label: string;
  type: 'scope' | 'keyword' | 'category';
  reason: string;
  selected: boolean;
}

export interface ClarificationOption {
  id: string;
  label: string;
}

export interface ClarificationQuestion {
  id: string;
  text: string;
  options: ClarificationOption[];
  required: boolean;
}

export interface KeywordGroup {
  category: string;
  keywords: string[];
}

export interface UIAction {
  type: string;
  payload: Record<string, unknown>;
}

export interface ActionButton {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'ghost' | 'danger';
}

export interface AgentResponse {
  state: string;
  message: string;
  suggestions?: { id: string; label: string; selected: boolean }[];
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
    nextStep?: string;
    [key: string]: unknown;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  response?: AgentResponse;
  timestamp: number;
}
