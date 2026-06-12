/**
 * API 路由定义
 */

import { Router, Request, Response } from 'express';
import { AIAgentEngine } from '../index';
import { AgentResponse, UserInput } from '../types/protocol';

export function createRouter(engine: AIAgentEngine): Router {
  const router = Router();

  /**
   * POST /api/chat
   * 处理用户输入，返回结构化响应
   */
  router.post('/api/chat', async (req: Request, res: Response) => {
    try {
      const { content, sessionId, selectedItems } = req.body;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content is required and must be a string' });
      }

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required and must be a string' });
      }

      const input: UserInput = {
        content,
        sessionId,
        timestamp: Date.now(),
        selectedItems
      };

      const response: AgentResponse = await engine.process(input);

      // 记录 AI 响应到记忆
      engine.processAiResponse(sessionId, response);

      return res.json(response);
    } catch (error) {
      console.error('Chat processing error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/reset
   * 重置会话
   */
  router.post('/api/reset', (req: Request, res: Response) => {
    engine.clearSession();
    return res.json({ success: true });
  });

  /**
   * GET /api/categories
   * 获取所有分类
   */
  router.get('/api/categories', (_req: Request, res: Response) => {
    return res.json(engine.getCategories());
  });

  /**
   * GET /api/topics?q=xxx
   * 搜索主题
   */
  router.get('/api/topics', (req: Request, res: Response) => {
    const q = req.query.q as string;
    if (!q) {
      return res.status(400).json({ error: 'q parameter is required' });
    }
    return res.json(engine.searchTopics(q));
  });

  /**
   * GET /api/state
   * 获取当前引擎状态
   */
  router.get('/api/state', (_req: Request, res: Response) => {
    return res.json({
      state: engine.getState(),
      memoryStats: engine.getMemoryStats()
    });
  });

  return router;
}
