/**
 * LLM 适配器 - OpenAI 兼容 API 调用
 * 支持任何兼容 OpenAI Chat Completions API 的模型服务
 */

import { LLMConfig, LLMAdapter, LLMRequest, LLMResponse } from '../types/llm';

/**
 * 创建 OpenAI 兼容的 LLM 适配器
 */
export function createOpenAIAdapter(config: LLMConfig): LLMAdapter {
  const temperature = config.temperature ?? 0.3;
  const maxTokens = config.maxTokens ?? 2048;
  const timeout = config.timeout ?? 30000;

  return {
    async chat(request: LLMRequest): Promise<LLMResponse> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(`${config.endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.model,
            messages: request.messages,
            temperature: request.temperature ?? temperature,
            max_tokens: request.maxTokens ?? maxTokens,
            response_format: request.responseFormat
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`LLM API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const choice = data.choices?.[0];

        return {
          content: choice?.message?.content || '',
          usage: data.usage ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens
          } : undefined,
          finishReason: choice?.finish_reason
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },

    isAvailable(): boolean {
      return !!(config.endpoint && config.apiKey && config.model);
    }
  };
}

/**
 * 创建空适配器（LLM 不可用时的兜底）
 */
export function createNoopAdapter(): LLMAdapter {
  return {
    async chat(): Promise<LLMResponse> {
      return {
        content: '',
        usage: undefined,
        finishReason: 'noop'
      };
    },
    isAvailable(): boolean {
      return false;
    }
  };
}
