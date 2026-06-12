/**
 * MVP 集成测试
 * 验证核心流程：用户输入 → 意图识别 → 知识库匹配 → 推荐生成 → 确认 → 规则生成
 */

import { createEngine } from '../src/index';
import { IntentType } from '../src/types/protocol';

describe('AI Agent Engine MVP Integration', () => {
  const engine = createEngine({ enableMemoryPromotion: false });
  const sessionId = 'test-session-001';

  afterEach(() => {
    engine.clearSession();
  });

  test('完整流程：屏蔽王者荣耀', async () => {
    const resp1 = await engine.process({
      content: '不想看王者荣耀',
      sessionId,
      timestamp: Date.now()
    });

    expect(['ANALYZE', 'SUGGEST']).toContain(resp1.state);
    expect(resp1.confidence).toBeGreaterThan(0.8);
    expect(resp1.metadata?.resolvedTopic).toBeDefined();

    engine.processAiResponse(sessionId, resp1);

    if (resp1.state === 'SUGGEST') {
      expect(resp1.recommendations).toBeDefined();
      expect(resp1.recommendations!.length).toBeGreaterThan(0);
      expect(resp1.questions).toBeDefined();
      expect(resp1.questions!.length).toBeGreaterThan(0);
    }
  });

  test('知识库匹配：通过别名找到主题', async () => {
    const resp = await engine.process({
      content: '屏蔽吃鸡',
      sessionId,
      timestamp: Date.now()
    });

    expect(resp.metadata?.resolvedTopic).toBeDefined();
  });

  test('分类匹配：匹配到一级分类', async () => {
    const resp = await engine.process({
      content: '不想看游戏',
      sessionId,
      timestamp: Date.now()
    });

    expect(['CLARIFYING', 'ANALYZE']).toContain(resp.state);
  });

  test('模糊输入：无法识别时进入 CLARIFYING', async () => {
    const resp = await engine.process({
      content: '嗯...',
      sessionId,
      timestamp: Date.now()
    });

    expect(resp.state).toBe('CLARIFYING');
    expect(resp.options).toBeDefined();
    expect(resp.options!.length).toBeGreaterThan(0);
  });

  test('指令操作：确认全部', async () => {
    const resp1 = await engine.process({
      content: '不想看王者荣耀',
      sessionId,
      timestamp: Date.now()
    });
    engine.processAiResponse(sessionId, resp1);

    const resp2 = await engine.process({
      content: '全部都要',
      sessionId,
      timestamp: Date.now()
    });

    // "全部都要"匹配 INSTRUCTION_OPERATION，从 SUGGEST 状态进入 RECOMMENDING
    expect(['RECOMMENDING', 'EXECUTING', 'CLARIFYING']).toContain(resp2.state);
  });
});

describe('Knowledge Base', () => {
  const engine = createEngine();

  test('获取分类列表', () => {
    const categories = engine.getCategories();
    expect(categories.length).toBe(6);
    expect(categories.map(c => c.id)).toContain('game');
    expect(categories.map(c => c.id)).toContain('movie');
  });

  test('搜索主题', () => {
    const results = engine.searchTopics('王者');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('王者荣耀');
  });

  test('搜索不存在的主题', () => {
    const results = engine.searchTopics('不存在的主题xyz');
    expect(results.length).toBe(0);
  });
});
