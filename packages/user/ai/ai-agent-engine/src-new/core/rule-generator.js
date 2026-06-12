/**
 * rule-generator.js — 规则生成器（重定义版新增模块）
 *
 * 核心职责：将对话结论转化为结构化规则，写入下游模块。
 *
 * 输出目标：
 *   1. topicFilter — 启用话题 / 追加关键词 / 创建自定义话题
 *   2. detector — 重载关键词缓存
 *   3. memory — 记录用户偏好
 *   4. ruleLearner — 同步升级建议
 *
 * 设计原则：
 *   - 所有写入操作都通过 bridge 接口，不直接持有下游模块引用
 *   - 生成规则前必须经过用户确认（EXECUTING 状态）
 *   - 返回 rulePreview 供 UI 渲染
 */

// ─── 规则输出类型 ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} RuleOutput
 * @property {string} type - 'enable_topic' | 'add_keywords' | 'create_topic' | 'adjust_sensitivity'
 * @property {string} topicId
 * @property {string} topicLabel
 * @property {string[]} addedKeywords
 * @property {string[]} enabledScopes
 * @property {string} suggestedSensitivity - 'low' | 'medium' | 'high'
 * @property {string} estimatedCoverage - 定性描述: '较广' | '中等' | '精确'（不给具体数字，避免承诺）
 */

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

/**
 * 创建规则生成器
 * @param {object} bridges - 下游模块桥接接口
 * @param {object} bridges.topicFilter  - TopicFilterBridge + TopicFilterWriter
 * @param {object} bridges.detector     - DetectorBridge
 * @param {object} bridges.memory       - MemoryBridge
 * @param {object} bridges.knowledge    - KnowledgeManager
 * @returns {object}
 */
export function createRuleGenerator(bridges) {
  const { topicFilter, detector, memory, knowledge } = bridges;

  return {
    /**
     * 根据对话上下文生成规则预览（不实际写入）
     * 用于 EXECUTING 前的预览展示
     *
     * @param {object} context - 状态机上下文
     * @param {object} context.currentTopic - 知识库条目
     * @param {string[]} context.selectedScopes - 用户选择的 scope ID
     * @returns {RuleOutput}
     */
    preview(context) {
      const { currentTopic, selectedScopes } = context;
      if (!currentTopic) return null;

      const topicName = currentTopic.name?.zh || currentTopic.name || currentTopic.id;
      const topicLabel = topicName;

      // 确定要添加的关键词
      const existingTopic = topicFilter?.getTopicDetail?.(currentTopic.topicFilterId || currentTopic.id);
      const existingKeywords = new Set([
        ...(existingTopic?.keywords?.zh || []),
        ...(existingTopic?.keywords?.en || []),
      ]);

      const newKeywords = (currentTopic.keywords || []).filter(
        kw => !existingKeywords.has(kw.toLowerCase())
      );

      // 确定推荐灵敏度
      let suggestedSensitivity = 'medium';
      if (selectedScopes.includes('scope_all')) {
        suggestedSensitivity = 'medium';
      }
      if (selectedScopes.includes('scope_attack') || selectedScopes.includes('scope_severe')) {
        suggestedSensitivity = 'low';
      }
      if (selectedScopes.includes('scope_implicit')) {
        suggestedSensitivity = 'high';
      }
      // 从知识库获取推荐
      const kbSensitivity = knowledge?.getScopeSensitivity?.(currentTopic.id, selectedScopes[0]);
      if (kbSensitivity) suggestedSensitivity = kbSensitivity;

      // 估算覆盖范围（定性描述，避免给出具体数字造成承诺偏差）
      const estimatedCoverage = _estimateCoverage(newKeywords.length, selectedScopes);

      return {
        type: _determineRuleType(currentTopic, existingTopic),
        topicId: currentTopic.topicFilterId || currentTopic.id,
        topicLabel,
        addedKeywords: newKeywords,
        enabledScopes: [...selectedScopes],
        suggestedSensitivity,
        estimatedCoverage,
      };
    },

    /**
     * 执行规则写入
     * @param {RuleOutput} rulePreview - preview() 的输出
     * @returns {{ success: boolean, appliedActions: string[] }}
     */
    execute(rulePreview) {
      if (!rulePreview) return { success: false, appliedActions: [] };

      const applied = [];

      try {
        const topicId = rulePreview.topicId;

        // ── 1. 启用/创建话题 ──────────────────────────────
        if (rulePreview.type === 'enable_topic') {
          topicFilter.toggleTopic(topicId, true);
          applied.push(`启用话题: ${rulePreview.topicLabel}`);
        } else if (rulePreview.type === 'create_topic') {
          topicFilter.addUserTopic({
            label: rulePreview.topicLabel,
            keywords: rulePreview.addedKeywords,
          });
          applied.push(`创建自定义话题: ${rulePreview.topicLabel}`);
        }

        // ── 2. 追加关键词 ──────────────────────────────────
        if (rulePreview.addedKeywords.length > 0) {
          const targetId = rulePreview.type === 'create_topic'
            ? topicFilter.getAllTopics().find(t => t.label?.zh === rulePreview.topicLabel)?.id
            : topicId;

          if (targetId) {
            topicFilter.addKeywordsToTopic(targetId, rulePreview.addedKeywords, 'zh');
            applied.push(`新增 ${rulePreview.addedKeywords.length} 个关键词`);
          }
        }

        // ── 3. 重载 detector 缓存 ──────────────────────────
        if (detector) {
          detector.reloadCustomKeywords();
          detector.reloadAutoLearnedKeywords();
          applied.push('检测器缓存已更新');
        }

        // ── 4. 写入记忆 ──────────────────────────────────
        if (memory) {
          memory.write({
            type: 'preference',
            key: `filter_${topicId}`,
            value: {
              topicLabel: rulePreview.topicLabel,
              scopes: rulePreview.enabledScopes,
              sensitivity: rulePreview.suggestedSensitivity,
              keywordsCount: rulePreview.addedKeywords.length,
            },
            confidence: 0.9,
            source: 'agent_configured',
          });
          applied.push('偏好已记录');
        }

        return { success: true, appliedActions: applied };

      } catch (err) {
        console.warn('[AgentEngine] Rule execution failed:', err);
        return { success: false, appliedActions: applied, error: err.message };
      }
    },

    /**
     * 快速规则：不经过对话流程，直接生成并应用
     * 用于"一键启用推荐配置"场景
     *
     * @param {string} topicId - 知识库 topic ID
     * @param {string} scopeId - 默认 scope
     * @returns {{ success: boolean, rulePreview: RuleOutput }}
     */
    quickApply(topicId, scopeId = 'scope_all') {
      const topic = knowledge.getTopic(topicId);
      if (!topic) return { success: false, rulePreview: null };

      const preview = this.preview({
        currentTopic: topic,
        selectedScopes: [scopeId],
      });

      const result = this.execute(preview);
      return { ...result, rulePreview: preview };
    },
  };
}

// ─── 内部工具函数 ──────────────────────────────────────────────────────────────

function _determineRuleType(topic, existingTopic) {
  // 有 topicFilterId 且已存在 → 启用
  if (topic.topicFilterId && existingTopic) return 'enable_topic';
  // 有 topicFilterId 但不存在（可能被删除了） → 启用
  if (topic.topicFilterId) return 'enable_topic';
  // 无 topicFilterId → 创建自定义话题
  return 'create_topic';
}

function _estimateCoverage(newKeywordsCount, selectedScopes) {
  const isAll = selectedScopes.includes('scope_all');
  const isAttackOnly = selectedScopes.some(s => s.includes('attack') || s.includes('severe'));

  if (newKeywordsCount === 0) return '当前关键词已覆盖';
  if (isAll && newKeywordsCount >= 5) return '较广';
  if (isAll) return '中等';
  if (isAttackOnly) return '精确（仅攻击性内容）';
  return '中等';
}
