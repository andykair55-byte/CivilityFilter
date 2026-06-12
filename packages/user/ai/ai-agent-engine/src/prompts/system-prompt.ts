/**
 * System Prompt 模板
 * 定义 LLM 的角色、行为规则和输出格式
 */

import { TopicEntry, CategoryDefinition } from '../types/knowledge';

/**
 * 构建 System Prompt
 */
export function buildSystemPrompt(
  categories?: CategoryDefinition[],
  matchedTopic?: TopicEntry
): string {
  let prompt = `你是一个"话题过滤"智能助手，其任务是将用户的自然语言需求转成结构化的过滤规则和建议。请遵守以下规则：

1. **不直接回答问题**，而是分析用户意图，主动提出可选的过滤范围和关联话题。
2. 输出**严格的JSON**，包含以下字段：
   - stage: 当前阶段（"analyze" | "suggest" | "clarify" | "confirm" | "finalize"）
   - intent: { type: string, summary: string, confidence: number }
   - topic: { name: string, category: string, aliases: string[], related: string[] }（仅在识别到具体话题时）
   - recommendations: [{ id: string, label: string, type: "scope"|"keyword"|"category", reason: string, selected: boolean }]（推荐项列表）
   - questions: [{ id: string, text: string, options: [{ id: string, label: string }], required: boolean }]（澄清问题）
   - keyword_groups: [{ category: string, keywords: string[] }]（关键词分组）
   - ui_actions: [{ type: string, payload: object }]（UI 动作指令）
   - warnings: string[]（警告信息）
   - next_step: "ask_user" | "generate_rules" | "wait"（下一步动作）

3. 在信息不完整时，提出 1~3 个澄清问题（questions）。
4. 在信息完整时，提供可点击的建议项（recommendations）并等待用户选择。
5. 推荐项应包含简短理由（reason），帮助用户理解其含义。
6. 只输出 JSON，不要输出任何其他文字。`;

  if (categories && categories.length > 0) {
    prompt += `\n\n可用的主题分类：\n`;
    categories.forEach(c => {
      prompt += `- ${c.label}（${c.id}）：${c.description}，关键词：${c.keywords.join('、')}\n`;
    });
  }

  if (matchedTopic) {
    prompt += `\n\n当前匹配到的主题信息：\n`;
    prompt += `- 名称：${matchedTopic.name}\n`;
    prompt += `- 分类：${matchedTopic.category}\n`;
    prompt += `- 别名：${matchedTopic.aliases.join('、')}\n`;
    prompt += `- 关联主题：${matchedTopic.related.join('、')}\n`;
    prompt += `- 内容维度：${matchedTopic.scopes.map(s => s.label).join('、')}\n`;
  }

  prompt += `\n\n输出格式示例：
{
  "stage": "suggest",
  "intent": { "type": "block_topic", "summary": "用户希望减少与XX相关内容", "confidence": 0.96 },
  "topic": { "name": "XX", "category": "游戏", "aliases": [], "related": [] },
  "recommendations": [
    { "id": "scope_game", "label": "游戏本体", "type": "scope", "reason": "直接相关", "selected": false }
  ],
  "questions": [],
  "keyword_groups": [],
  "ui_actions": [{ "type": "render_cards", "payload": {} }],
  "warnings": [],
  "next_step": "ask_user"
}`;

  return prompt;
}
