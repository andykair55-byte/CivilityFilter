/**
 * Layer 3 - State Machine
 * 重构版：支持 ANALYZE/SUGGEST 状态，集成知识库推荐
 */

import { AgentState, canTransition } from '../types/state';
import {
  AgentResponse,
  IntentType,
  ContextResolution,
  RecommendationItem,
  ClarificationQuestion,
  KeywordGroup
} from '../types/protocol';
import { TopicEntry, CategoryDefinition } from '../types/knowledge';

export interface StateResponse {
  response: AgentResponse;
  nextState: AgentState;
}

export interface StateMachineConfig {
  clarificationLimit: number;
  confidenceThreshold: number;
}

/**
 * 创建状态机实例
 */
export function createStateMachine(config: StateMachineConfig) {
  let currentState = AgentState.IDLE;
  let clarificationCount = 0;
  let lastState: AgentState = AgentState.IDLE;
  let currentTopic: TopicEntry | undefined;
  let currentCategory: CategoryDefinition | undefined;
  let selectedRecommendations: string[] = [];

  return {
    getState(): AgentState {
      return currentState;
    },

    setCurrentTopic(topic: TopicEntry | undefined, category: CategoryDefinition | undefined): void {
      currentTopic = topic;
      currentCategory = category;
    },

    setSelectedRecommendations(ids: string[]): void {
      selectedRecommendations = ids;
    },

    process(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      previousState: AgentState,
      metadata?: Record<string, unknown>
    ): StateResponse {
      lastState = currentState;

      // Force CLARIFYING if confidence is too low
      if (confidence < config.confidenceThreshold && currentState === AgentState.IDLE) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: '我不太确定你的意思，你能再说清楚一些吗？',
          confidence
        });
      }

      switch (currentState) {
        case AgentState.IDLE:
        case AgentState.DONE:
          return this.handleNewInput(intent, confidence, metadata);

        case AgentState.ANALYZE:
          return this.handleAnalyze(intent, confidence, contextResolution, metadata);

        case AgentState.UNDERSTANDING:
          return this.handleUnderstanding(intent, confidence, contextResolution, metadata);

        case AgentState.SUGGEST:
          return this.handleSuggest(intent, confidence, contextResolution, metadata);

        case AgentState.CLARIFYING:
          return this.handleClarifying(intent, confidence, contextResolution, metadata);

        case AgentState.RECOMMENDING:
          return this.handleRecommending(intent, confidence, contextResolution, metadata);

        case AgentState.EXECUTING:
          return this.transitionTo(AgentState.DONE, {
            message: '规则已生成！',
            confidence: 1.0
          });

        default:
          return this.transitionTo(AgentState.IDLE, {
            message: '状态异常，已重置',
            confidence: 0
          });
      }
    },

    handleNewInput(
      intent: IntentType,
      confidence: number,
      metadata?: Record<string, unknown>
    ): StateResponse {
      switch (intent) {
        case IntentType.TOPIC_CREATE:
          return this.transitionTo(AgentState.ANALYZE, {
            message: '正在分析你的需求...',
            confidence,
            metadata: { resolvedIntent: intent, ...metadata }
          });

        case IntentType.INSTRUCTION_OPERATION:
          return this.transitionTo(AgentState.EXECUTING, {
            message: '正在执行指令...',
            confidence,
            metadata: { resolvedIntent: intent }
          });

        case IntentType.INFORMATION_QUERY:
          return this.transitionTo(AgentState.UNDERSTANDING, {
            message: '让我查一下...',
            confidence,
            metadata: { resolvedIntent: intent }
          });

        case IntentType.AMBIGUOUS:
        default:
          clarificationCount = 0;
          return this.transitionTo(AgentState.CLARIFYING, {
            message: '我需要确认一下你的意思：你想做什么？',
            confidence: 0.4,
            options: [
              { id: 'topic_create', label: '屏蔽某个话题' },
              { id: 'query', label: '查询信息' },
              { id: 'operation', label: '执行操作' }
            ]
          });
      }
    },

    handleAnalyze(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      if (currentTopic) {
        const recommendations = this.generateRecommendations(currentTopic);
        const keywordGroups = this.generateKeywordGroups(currentTopic);
        const questions = this.generateQuestions(currentTopic);

        return this.transitionTo(AgentState.SUGGEST, {
          message: `我理解你想减少与「${currentTopic.name}」相关的内容。请选择你想屏蔽的范围：`,
          confidence,
          recommendations,
          keywordGroups,
          questions,
          uiActions: [
            { type: 'render_cards', payload: {} },
            { type: 'wait_user_choice', payload: {} }
          ],
          metadata: {
            resolvedIntent: intent,
            resolvedTopic: currentTopic.name,
            resolvedCategory: currentTopic.category,
            ...metadata
          }
        });
      }

      if (currentCategory) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: `你提到了「${currentCategory.label}」相关的内容，能说得更具体一些吗？比如具体是哪个游戏、哪部电影？`,
          confidence: 0.7,
          options: [
            { id: 'specify', label: '我来具体说明' },
            { id: 'block_all', label: `屏蔽整个${currentCategory.label}分类` }
          ],
          metadata
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '我没有找到匹配的话题，你能说得更具体一些吗？比如"不想看王者荣耀"或"屏蔽科技类内容"。',
        confidence: 0.5,
        options: [
          { id: 'specify', label: '我来具体说明' },
          { id: 'list_topics', label: '查看可选话题' }
        ],
        metadata
      });
    },

    handleSuggest(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      if (contextResolution === ContextResolution.CONFIRM_ALL) {
        return this.transitionTo(AgentState.RECOMMENDING, {
          message: '好的，已选择全部范围。确认生成过滤规则？',
          confidence: 0.95,
          recommendations: currentTopic?.scopes.map(s => ({
            id: s.id,
            label: s.label,
            type: 'scope' as const,
            reason: s.reason,
            selected: true
          })),
          actions: [
            { id: 'confirm', label: '确认生成', style: 'primary' },
            { id: 'modify', label: '修改选择', style: 'ghost' }
          ],
          metadata
        });
      }

      if (contextResolution === ContextResolution.REJECT_SUGGESTIONS) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: '好的，你想要什么样的调整？',
          confidence: 0.8,
          options: [
            { id: 'narrow', label: '缩小范围' },
            { id: 'expand', label: '扩大范围' },
            { id: 'new_topic', label: '换个话题' }
          ]
        });
      }

      if (intent === IntentType.INSTRUCTION_OPERATION) {
        return this.transitionTo(AgentState.RECOMMENDING, {
          message: '好的，已记录你的选择。确认生成过滤规则？',
          confidence: 0.9,
          actions: [
            { id: 'confirm', label: '确认生成', style: 'primary' },
            { id: 'modify', label: '修改选择', style: 'ghost' }
          ]
        });
      }

      if (selectedRecommendations.length > 0) {
        return this.transitionTo(AgentState.RECOMMENDING, {
          message: `已选择 ${selectedRecommendations.length} 个过滤范围。确认生成过滤规则？`,
          confidence: 0.9,
          actions: [
            { id: 'confirm', label: '确认生成', style: 'primary' },
            { id: 'modify', label: '修改选择', style: 'ghost' }
          ],
          metadata
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '你对这些建议有什么意见？',
        confidence: 0.5,
        options: [
          { id: 'confirm_all', label: '全部添加' },
          { id: 'modify', label: '部分修改' }
        ]
      });
    },

    handleUnderstanding(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      if (intent === IntentType.AMBIGUOUS || confidence < config.confidenceThreshold) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: '我需要更多信息来理解你的需求',
          confidence,
          options: [
            { id: 'specify_topic', label: '指定具体话题' },
            { id: 'ask_question', label: '回答问题' }
          ]
        });
      }

      if (intent === IntentType.TOPIC_CREATE) {
        return this.transitionTo(AgentState.ANALYZE, {
          message: '明白了，让我为你分析',
          confidence,
          metadata
        });
      }

      if (intent === IntentType.INFORMATION_QUERY) {
        return this.transitionTo(AgentState.EXECUTING, {
          message: '正在查询...',
          confidence
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '请告诉我你想做什么',
        confidence: 0.5
      });
    },

    handleClarifying(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      clarificationCount++;

      if (clarificationCount > config.clarificationLimit) {
        clarificationCount = 0;
        return this.transitionTo(AgentState.IDLE, {
          message: '抱歉，我们无法达成共识。请尝试重新描述你的需求。',
          confidence: 0,
          metadata
        });
      }

      if (contextResolution === ContextResolution.CLARIFICATION_RESPONSE) {
        return this.transitionTo(AgentState.ANALYZE, {
          message: '好的，我明白了',
          confidence: 0.8,
          metadata
        });
      }

      if (intent !== IntentType.AMBIGUOUS && confidence >= config.confidenceThreshold) {
        return this.transitionTo(AgentState.ANALYZE, {
          message: '谢谢说明，让我重新分析',
          confidence,
          metadata
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '抱歉，我还是不太理解。你能换个方式说吗？',
        confidence: 0.3,
        options: [
          { id: 'topic_create', label: '屏蔽某个话题' },
          { id: 'query', label: '查询信息' }
        ]
      });
    },

    handleRecommending(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      if (contextResolution === ContextResolution.CONFIRM_ALL || intent === IntentType.INSTRUCTION_OPERATION) {
        return this.transitionTo(AgentState.EXECUTING, {
          message: '好的，正在生成过滤规则...',
          confidence: 0.95,
          metadata
        });
      }

      if (contextResolution === ContextResolution.REJECT_SUGGESTIONS) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: '好的，你想要什么样的调整？',
          confidence: 0.8,
          options: [
            { id: 'narrow', label: '缩小范围' },
            { id: 'expand', label: '扩大范围' },
            { id: 'new_topic', label: '换个话题' }
          ]
        });
      }

      if (intent === IntentType.TOPIC_CREATE) {
        return this.transitionTo(AgentState.ANALYZE, {
          message: '好的，让我重新分析',
          confidence: 0.85,
          metadata
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '你对这些建议有什么意见？',
        confidence: 0.5,
        options: [
          { id: 'confirm_all', label: '全部添加' },
          { id: 'modify', label: '部分修改' }
        ]
      });
    },

    generateRecommendations(topic: TopicEntry): RecommendationItem[] {
      return topic.scopes.map(scope => ({
        id: scope.id,
        label: scope.label,
        type: 'scope' as const,
        reason: scope.reason,
        selected: false
      }));
    },

    generateKeywordGroups(topic: TopicEntry): KeywordGroup[] {
      return [
        {
          category: topic.name,
          keywords: topic.keywords
        }
      ];
    },

    generateQuestions(topic: TopicEntry): ClarificationQuestion[] {
      return [
        {
          id: 'q_scope',
          text: `你想屏蔽「${topic.name}」到什么程度？`,
          options: [
            { id: 'all', label: '全部相关内容' },
            { id: 'core', label: `只屏蔽${topic.name}本体` },
            { id: 'custom', label: '自定义选择' }
          ],
          required: true
        }
      ];
    },

    transitionTo(newState: AgentState, partialResponse: Partial<AgentResponse>): StateResponse {
      currentState = newState;

      const response: AgentResponse = {
        state: newState,
        message: partialResponse.message || '',
        confidence: partialResponse.confidence ?? 0.5,
        ...partialResponse
      };

      return {
        response,
        nextState: newState
      };
    },

    reset(): void {
      currentState = AgentState.IDLE;
      clarificationCount = 0;
      lastState = AgentState.IDLE;
      currentTopic = undefined;
      currentCategory = undefined;
      selectedRecommendations = [];
    },

    getLastState(): AgentState {
      return lastState;
    }
  };
}
