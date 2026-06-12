/**
 * AI Agent Engine - Main Entry Point
 * MVP 版本：集成知识库 + LLM 适配器
 */

import { AgentState } from './types/state';
import {
  IntentType,
  ContextResolution,
  AgentResponse,
  UserInput,
  EngineConfig
} from './types/protocol';
import { classifyIntent, extractTopic, isNewIntent, IntentResult } from './core/intent';
import { analyzeContext } from './core/context';
import { createStateMachine } from './core/state-machine';
import {
  createMemoryManager,
  DEFAULT_MEMORY_CONFIG
} from './core/memory';
import { createKnowledgeManager } from './core/knowledge';
import { createOpenAIAdapter, createNoopAdapter } from './core/llm-adapter';
import { buildSystemPrompt } from './prompts/system-prompt';
import { ConversationTurn } from './types/memory';
import { validateResponse, sanitizeResponse } from './protocol/validator';
import { LLMAdapter } from './types/llm';

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  confidenceThreshold: 0.5,
  maxContextTurns: 10,
  clarificationLimit: 2,
  enableMemoryPromotion: true,
  useLlm: false
};

export class AIAgentEngine {
  private stateMachine: ReturnType<typeof createStateMachine>;
  private memoryManager: ReturnType<typeof createMemoryManager>;
  private knowledgeManager: ReturnType<typeof createKnowledgeManager>;
  private llmAdapter: LLMAdapter;
  private config: EngineConfig;

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.stateMachine = createStateMachine({
      clarificationLimit: this.config.clarificationLimit,
      confidenceThreshold: this.config.confidenceThreshold
    });
    this.memoryManager = createMemoryManager(DEFAULT_MEMORY_CONFIG);
    this.knowledgeManager = createKnowledgeManager();

    if (this.config.useLlm && this.config.llmEndpoint && this.config.llmApiKey) {
      this.llmAdapter = createOpenAIAdapter({
        endpoint: this.config.llmEndpoint,
        apiKey: this.config.llmApiKey,
        model: this.config.llmModel || 'gpt-3.5-turbo'
      });
    } else {
      this.llmAdapter = createNoopAdapter();
    }
  }

  /**
   * Process user input and return structured response
   */
  async process(input: UserInput): Promise<AgentResponse> {
    const { content, sessionId, timestamp } = input;

    const recentTurns = this.memoryManager.getRecentTurns(sessionId, this.config.maxContextTurns);
    const previousState = this.stateMachine.getState();

    // Layer 1: Intent Classification (with knowledge base)
    const intentResult = classifyIntent(content, (query) => {
      const topic = this.knowledgeManager.findTopic(query);
      const category = this.knowledgeManager.matchCategory(query);
      return { topic, category };
    });

    // Layer 2: Context Analysis
    const { resolution, confidence: contextConfidence, contextData } = analyzeContext(
      content,
      recentTurns
    );

    const finalConfidence = contextConfidence > 0.7
      ? contextConfidence
      : intentResult.confidence;

    // 设置状态机的当前主题
    this.stateMachine.setCurrentTopic(intentResult.matchedTopic, intentResult.matchedCategory);

    // 处理用户已选择的推荐项
    if (input.selectedItems && input.selectedItems.length > 0) {
      this.stateMachine.setSelectedRecommendations(input.selectedItems);
    }

    // 尝试 LLM 增强处理
    let llmEnhancedResponse: AgentResponse | null = null;
    if (this.llmAdapter.isAvailable() && this.config.useLlm) {
      llmEnhancedResponse = await this.tryLlmEnhancement(content, intentResult, recentTurns);
    }

    // Layer 3: State Machine Processing
    const { response, nextState } = this.stateMachine.process(
      intentResult.intent,
      finalConfidence,
      resolution,
      previousState,
      {
        resolvedIntent: intentResult.intent,
        resolvedTopic: intentResult.extractedTopic || intentResult.matchedTopic?.name,
        resolvedCategory: intentResult.matchedCategory?.id,
        contextResolution: resolution,
        previousState,
        turnCount: recentTurns.length,
        ...contextData
      }
    );

    // 如果 LLM 增强成功，合并结果
    const finalResponse = this.buildResponse(
      llmEnhancedResponse || response,
      intentResult,
      resolution,
      finalConfidence,
      nextState,
      previousState
    );

    // Add turn to memory
    const userTurn: ConversationTurn = {
      role: 'user',
      content,
      intent: intentResult.intent,
      resolvedTopic: intentResult.extractedTopic || intentResult.matchedTopic?.name,
      timestamp
    };
    this.memoryManager.addTurn(sessionId, userTurn);

    // Layer 5: Memory Promotion
    const resolvedTopic = intentResult.extractedTopic || intentResult.matchedTopic?.name;
    if (this.config.enableMemoryPromotion && resolvedTopic) {
      const promotion = this.memoryManager.recordTopicMention(resolvedTopic);
      if (promotion.promoted) {
        finalResponse.metadata = {
          ...finalResponse.metadata,
          memoryPromoted: true,
          promotedTopic: resolvedTopic
        };
      }
    }

    // Validate and sanitize
    const validation = validateResponse(finalResponse);
    if (!validation.valid) {
      return sanitizeResponse(finalResponse);
    }

    return finalResponse;
  }

  /**
   * 尝试 LLM 增强处理
   */
  private async tryLlmEnhancement(
    content: string,
    intentResult: IntentResult,
    recentTurns: ConversationTurn[]
  ): Promise<AgentResponse | null> {
    try {
      const categories = this.knowledgeManager.getCategories();
      const systemPrompt = buildSystemPrompt(categories, intentResult.matchedTopic);

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...recentTurns.slice(-4).map(turn => ({
          role: (turn.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: turn.content
        })),
        { role: 'user' as const, content }
      ];

      const llmResponse = await this.llmAdapter.chat({
        messages,
        responseFormat: { type: 'json_object' }
      });

      if (llmResponse.content) {
        try {
          const parsed = JSON.parse(llmResponse.content);
          return this.mapLlmOutputToResponse(parsed);
        } catch {
          return null;
        }
      }
    } catch {
      // LLM 调用失败，静默回退
    }
    return null;
  }

  /**
   * 将 LLM JSON 输出映射为 AgentResponse
   */
  private mapLlmOutputToResponse(llmOutput: Record<string, unknown>): AgentResponse {
    const stageToState: Record<string, string> = {
      'analyze': 'ANALYZE',
      'suggest': 'SUGGEST',
      'clarify': 'CLARIFYING',
      'confirm': 'RECOMMENDING',
      'finalize': 'EXECUTING'
    };

    const state = stageToState[llmOutput.stage as string] || 'IDLE';
    const intent = llmOutput.intent as Record<string, unknown>;
    const topic = llmOutput.topic as Record<string, unknown>;

    return {
      state,
      message: (intent?.summary as string) || '',
      confidence: (intent?.confidence as number) || 0.5,
      recommendations: (llmOutput.recommendations as AgentResponse['recommendations']) || [],
      questions: (llmOutput.questions as AgentResponse['questions']) || [],
      keywordGroups: (llmOutput.keyword_groups as AgentResponse['keywordGroups']) || [],
      uiActions: (llmOutput.ui_actions as AgentResponse['uiActions']) || [],
      warnings: (llmOutput.warnings as string[]) || [],
      metadata: {
        resolvedIntent: intent?.type as string,
        resolvedTopic: topic?.name as string,
        resolvedCategory: topic?.category as string,
        nextStep: llmOutput.next_step as string
      }
    };
  }

  private buildResponse(
    baseResponse: AgentResponse,
    intentResult: IntentResult,
    contextResolution: ContextResolution,
    confidence: number,
    nextState: AgentState,
    previousState: AgentState
  ): AgentResponse {
    return {
      ...baseResponse,
      state: nextState,
      confidence,
      metadata: {
        resolvedIntent: intentResult.intent,
        resolvedTopic: intentResult.extractedTopic || intentResult.matchedTopic?.name,
        resolvedCategory: intentResult.matchedCategory?.id,
        contextResolution,
        previousState,
        turnCount: this.memoryManager.getRecentTurns('', 0).length,
        ...baseResponse.metadata
      }
    };
  }

  /**
   * Process an AI response in the conversation (for state tracking)
   */
  processAiResponse(sessionId: string, response: AgentResponse): void {
    const aiTurn: ConversationTurn = {
      role: 'ai',
      content: response.message,
      state: response.state,
      suggestedKeywords: response.suggestions?.map(s => s.label),
      timestamp: Date.now()
    };
    this.memoryManager.addTurn(sessionId, aiTurn);
  }

  getRelevantMemory(currentTopic: string): string[] {
    const relevant = this.memoryManager.getRelevantTopics(currentTopic);
    return relevant.map(e => e.topic);
  }

  addManualMemory(topic: string): void {
    this.memoryManager.addManualTopic(topic);
  }

  removeMemory(topic: string): boolean {
    return this.memoryManager.removeTopic(topic);
  }

  getState(): AgentState {
    return this.stateMachine.getState();
  }

  reset(): void {
    this.stateMachine.reset();
  }

  getMemoryStats(): { shortTermTurns: number; longTermEntries: number } {
    return this.memoryManager.getStats();
  }

  clearSession(): void {
    this.memoryManager.clearShortTerm();
    this.stateMachine.reset();
  }

  getCategories() {
    return this.knowledgeManager.getCategories();
  }

  searchTopics(query: string) {
    return this.knowledgeManager.searchTopics(query);
  }
}

export function createEngine(config?: Partial<EngineConfig>): AIAgentEngine {
  return new AIAgentEngine(config);
}

export * from './types/state';
export * from './types/memory';
export * from './types/protocol';
export * from './types/knowledge';
export * from './types/llm';
