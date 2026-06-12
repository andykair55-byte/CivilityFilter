/**
 * LLM 适配器类型定义
 */

/**
 * LLM 配置
 */
export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

/**
 * LLM 消息角色
 */
export type LLMMessageRole = 'system' | 'user' | 'assistant';

/**
 * LLM 消息
 */
export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
}

/**
 * LLM 请求
 */
export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' } | { type: 'text' };
}

/**
 * LLM 响应
 */
export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

/**
 * LLM 适配器接口
 */
export interface LLMAdapter {
  chat(request: LLMRequest): Promise<LLMResponse>;
  isAvailable(): boolean;
}
