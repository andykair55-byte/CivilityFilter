/**
 * ai.js — Layer 3: Claude AI 检测模块
 *
 * 职责：封装 Claude API 调用，提供统一的 async analyze() 接口。
 * 后续扩展：批处理队列、每日调用上限、规则晋升触发。
 */

import { getLang } from './i18n.js';

// ─── 默认 Prompt 模板 ──────────────────────────────────────────────────────────

function buildSystemPrompt(lang) {
  const langName = lang === 'zh' ? '中文' : lang === 'ja' ? '日本語' : 'English';
  return `You are detecting toxicity in online content. CRITICAL: You MUST write your "reason" and "topic_label" in ${langName} (${lang}). The rest of the JSON structure must remain in English.

Key techniques users use to bypass filters:
1. Homophone character substitution
2. Pinyin abbreviations (e.g., sb, nmsl)
3. Number homophones
4. Intentional typos
5. Semantic pollution (normal words given derogatory meaning)

Judge based on the speaker's intent, not literal word choice.
The same word may have completely different judgments in different contexts.

You need to perform two independent analyses, outputting a single JSON object with both judgments:

First (topic): Whether the content involves topics the user doesn't want to see (gender对立, regional discrimination, personal attacks, trolling/fishing, PUA/manipulation techniques)
Second (attack): Whether the content is a malicious attack, harassment, derogation, or threat targeting a specific individual

Output strict JSON format:
{
  "topic": {
    "verdict": "toxic" | "safe",
    "confidence": 0.0-1.0,
    "reason": "short explanation in ${langName}",
    "topic_label": "topic category in ${langName}"
  },
  "attack": {
    "verdict": "toxic" | "safe",
    "confidence": 0.0-1.0,
    "reason": "short explanation in ${langName}"
  },
  "patterns": ["trigger patterns extracted for local rule learning"]
}`;
  }

// ─── 批处理参数 ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 10;
const BATCH_TIMEOUT = 5000; // 5s

export class AIAnalyzer {
  constructor(config) {
    this.config = config;
    this.dailyCount = 0;
    this.lastResetDate = null;
    this._loadDailyCount();

    // 批处理队列
    this._queue = [];
    this._queueTimer = null;
    this._queueResolvers = new Map();
    this._queueIdCounter = 0;

    // Token 统计
    this._totalTokens = 0;
    this._sessionTokens = 0;
    this._loadTokenStats();

    // 连接状态
    this._connected = false;
  }

  /**
   * AI 分析入口 — 支持批处理合并
   * @param {string} text
   * @param {object} context  { platform, isReply, mentionsUser, username }
   * @returns {Promise<object|null>}  { verdict, confidence, layer:3, reason, patterns }
   */
  async analyze(text, context = {}) {
    if (!this.config.apiKey) return null;
    if (!this._checkDailyLimit()) return null;

    // 通过 Promise 入队，攒够批量或超时后统一发送
    return new Promise((resolve) => {
      const id = ++this._queueIdCounter;
      this._queueResolvers.set(id, resolve);
      this._queue.push({ id, text, context });

      if (this._queue.length >= BATCH_SIZE) {
        this._flushBatch();
      } else if (!this._queueTimer) {
        this._queueTimer = setTimeout(() => this._flushBatch(), BATCH_TIMEOUT);
      }
    });
  }

  /** 获取今日已用次数 */
  getTodayUsage() {
    return this.dailyCount;
  }

  /** 获取每日上限 */
  getDailyLimit() {
    // 优先使用用户自定义的限额；无自定义时：完整模式 200，其他模式 30
    if (this.config.aiDailyLimit !== undefined && this.config.aiDailyLimit > 0) {
      return this.config.aiDailyLimit;
    }
    const mode = this.config.aiMode || 'eco';
    return mode === 'full' ? 200 : 30;
  }

  /** 检查是否达到每日上限 */
  _checkDailyLimit() {
    const today = new Date().toDateString();
    if (this.lastResetDate !== today) {
      this.dailyCount = 0;
      this.lastResetDate = today;
      this._saveDailyCount();
    }
    return this.dailyCount < this.getDailyLimit();
  }

  _loadDailyCount() {
    try {
      this.dailyCount = parseInt(GM_getValue('cs_ai_daily_count', '0'), 10);
      this.lastResetDate = GM_getValue('cs_ai_last_reset', '');
    } catch (e) {
      this.dailyCount = 0;
      this.lastResetDate = '';
    }
  }

  _saveDailyCount() {
    try {
      GM_setValue('cs_ai_daily_count', String(this.dailyCount));
      GM_setValue('cs_ai_last_reset', new Date().toDateString());
    } catch (e) { /* silent */ }
  }

  _loadTokenStats() {
    try {
      this._totalTokens = parseInt(GM_getValue('cs_ai_total_tokens', '0'), 10);
    } catch (e) { this._totalTokens = 0; }
  }

  _saveTokenStats() {
    try {
      GM_setValue('cs_ai_total_tokens', String(this._totalTokens));
    } catch (e) { /* silent */ }
  }

  /** 记录 token 消耗（从 API 响应中提取） */
  _recordTokenUsage(responseData, format) {
    let tokens = 0;
    if (format === 'openai') {
      tokens = responseData.usage?.total_tokens || 0;
    } else {
      // Claude 格式
      tokens = (responseData.usage?.input_tokens || 0) + (responseData.usage?.output_tokens || 0);
    }
    if (tokens > 0) {
      this._totalTokens += tokens;
      this._sessionTokens += tokens;
      this._saveTokenStats();
    }
    return tokens;
  }

  /** 获取 AI 状态信息（供面板展示） */
  getStatus() {
    const apiConfig = this._getAPIConfig();
    return {
      provider: this.config.aiProvider || 'claude',
      model: apiConfig.model || '',
      dailyUsed: this.dailyCount,
      dailyLimit: this.getDailyLimit(),
      isLimitReached: !this._checkDailyLimit(),
      connected: this._connected,
      totalTokens: this._totalTokens,
      sessionTokens: this._sessionTokens,
    };
  }

  /**
   * 检查是否应该进行 AI 分析（用于前置判断，避免无效调用）
   */
  shouldAnalyze() {
    return !!(this.config.apiKey && this._checkDailyLimit());
  }

  /** 刷新批处理队列，攒够一批后发送 */
  _flushBatch() {
    if (this._queueTimer) {
      clearTimeout(this._queueTimer);
      this._queueTimer = null;
    }

    const batch = this._queue.splice(0, BATCH_SIZE);
    if (batch.length === 0) return;

    this._callBatchAPI(batch).then(results => {
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const resolve = this._queueResolvers.get(item.id);
        if (resolve) {
          resolve(results[i] || null);
          this._queueResolvers.delete(item.id);
        }
      }
    }).catch(err => {
      console.warn('[CyberShield] Batch AI failed, falling back to single:', err);
      for (const item of batch) {
        const resolve = this._queueResolvers.get(item.id);
        if (resolve) {
          this._singleFallback(item, resolve);
        }
      }
    });
  }

  /** 批量 API 调用 */
  async _callBatchAPI(batch) {
    const batchText = batch.map((item, i) =>
      `[${i + 1}] """${item.text}""" (platform: ${item.context.platform || 'unknown'})`
    ).join('\n\n');

    const lang = getLang();
    const langName = lang === 'zh' ? '中文' : lang === 'ja' ? '日本語' : 'English';
    const prompt = `Analyze each of the following ${batch.length} messages for toxicity. IMPORTANT: Write the "reason" field in ${langName} (${lang}). Respond with a JSON array where each element corresponds to the message at the same index.

Messages:
${batchText}

Respond with ONLY valid JSON array:
[
  { "verdict": "toxic"|"suspicious"|"safe", "confidence": 0.0-1.0, "reason": "...", "patterns": ["..."] }
]`;

    const apiConfig = this._getAPIConfig();

    if (apiConfig.format === 'gemini') {
      const rawData = await this._gmFetch(apiConfig.url, {
        method: 'POST',
        headers: apiConfig.headers,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 200 * batch.length },
          systemInstruction: { parts: [{ text: buildSystemPrompt(getLang()) }] },
        }),
      });
      const raw = rawData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      const results = JSON.parse(raw.replace(/```json|```/g, '').trim());
      this._recordTokenUsage(rawData, 'gemini');
      this._connected = true;
      if (!Array.isArray(results)) return batch.map(() => null);
      return results.map(r => {
        if (!r) return null;
        this.dailyCount++;
        this._saveDailyCount();
        return {
          verdict:    r.verdict     || 'safe',
          confidence: r.confidence  || 0.5,
          layer:      3,
          reason:     r.reason      || 'AI analysis',
          patterns:   r.patterns    || [],
        };
      });
    }

    if (apiConfig.format === 'openai') {
      const rawData = await this._gmFetch(apiConfig.url, {
        method: 'POST',
        headers: apiConfig.headers,
        body: JSON.stringify({
          model: apiConfig.model,
          max_tokens: 200 * batch.length,
          messages: [
            { role: 'system', content: buildSystemPrompt(getLang()) },
            { role: 'user', content: prompt },
          ],
        }),
      });
      const raw = rawData.choices?.[0]?.message?.content || '[]';
      const results = JSON.parse(raw.replace(/```json|```/g, '').trim());
      this._recordTokenUsage(rawData, 'openai');
      this._connected = true;
      if (!Array.isArray(results)) return batch.map(() => null);
      return results.map(r => {
        if (!r) return null;
        this.dailyCount++;
        this._saveDailyCount();
        return {
          verdict:    r.verdict     || 'safe',
          confidence: r.confidence  || 0.5,
          layer:      3,
          reason:     r.reason      || 'AI analysis',
          patterns:   r.patterns    || [],
        };
      });
    }

    // Claude 格式
    const rawData = await this._gmFetch(apiConfig.url, {
      method: 'POST',
      headers: apiConfig.headers,
      body: JSON.stringify({
        model: apiConfig.model,
        system: buildSystemPrompt(getLang()),
        max_tokens: 200 * batch.length,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const raw = rawData.content?.[0]?.text || '[]';
    const results = JSON.parse(raw.replace(/```json|```/g, '').trim());
    this._recordTokenUsage(rawData, 'claude');
    this._connected = true;

    if (!Array.isArray(results)) return batch.map(() => null);

    return results.map(r => {
      if (!r) return null;
      this.dailyCount++;
      this._saveDailyCount();
      return {
        verdict:    r.verdict     || 'safe',
        confidence: r.confidence  || 0.5,
        layer:      3,
        reason:     r.reason      || 'AI analysis',
        patterns:   r.patterns    || [],
      };
    });
  }

  /** 单条回退（批量失败时降级） */
  async _singleFallback(item, resolve) {
    const prompt = this._buildPrompt(item.text, item.context);
    try {
      const apiConfig = this._getAPIConfig();

      if (apiConfig.format === 'openai') {
        const rawData = await this._gmFetch(apiConfig.url, {
          method: 'POST',
          headers: apiConfig.headers,
          body: JSON.stringify({
            model: apiConfig.model,
            max_tokens: 200,
            messages: [
              { role: 'system', content: buildSystemPrompt(getLang()) },
              { role: 'user', content: prompt },
            ],
          }),
        });
        const raw = rawData.choices?.[0]?.message?.content || '{}';
        const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
        this.dailyCount++;
        this._saveDailyCount();
        resolve({
          verdict:    result.verdict     || 'safe',
          confidence: result.confidence  || 0.5,
          layer:      3,
          reason:     result.reason      || 'AI analysis',
          patterns:   result.patterns    || [],
        });
      } else {
        const rawData = await this._gmFetch(apiConfig.url, {
          method: 'POST',
          headers: apiConfig.headers,
          body: JSON.stringify({
            model: apiConfig.model,
            system: buildSystemPrompt(getLang()),
            max_tokens: 200,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const raw = rawData.content?.[0]?.text || '{}';
        const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
        this.dailyCount++;
        this._saveDailyCount();
        resolve({
          verdict:    result.verdict     || 'safe',
          confidence: result.confidence  || 0.5,
          layer:      3,
          reason:     result.reason      || 'AI analysis',
          patterns:   result.patterns    || [],
        });
      }
    } catch (err) {
      resolve(null);
    }
  }

  _buildPrompt(text, context) {
    const lang = getLang();
    const langName = lang === 'zh' ? '中文' : lang === 'ja' ? '日本語' : 'English';
    return `Text: """${text}"""
Context: Platform=${context.platform || 'unknown'}, Is a direct reply=${!!context.isReply}

IMPORTANT: Write the "reason" and "topic_label" fields in ${langName} (${lang}).

Respond with ONLY valid JSON:
{
  "topic": {
    "verdict": "toxic" | "safe",
    "confidence": 0.0-1.0,
    "reason": "one sentence explanation",
    "topic_label": "topic category"
  },
  "attack": {
    "verdict": "toxic" | "safe",
    "confidence": 0.0-1.0,
    "reason": "one sentence explanation"
  },
  "patterns": ["list of trigger patterns"]
}`;
  }

  /** 合并双轨结果为单条输出（兼容下游消费代码） */
  _combineDualTrack(parsed) {
    const topic = parsed.topic || {};
    const attack = parsed.attack || {};
    const patterns = parsed.patterns || [];

    const topicToxic = topic.verdict === 'toxic';
    const attackToxic = attack.verdict === 'toxic';

    if (!topicToxic && !attackToxic) {
      return { verdict: 'safe', confidence: 0.2, layer: 3, reason: 'No issues detected', patterns: [] };
    }

    // 两轨取置信度最高的
    const higher = topic.confidence > attack.confidence ? topic : attack;
    const reasons = [];
    if (topicToxic) reasons.push(`[话题] ${topic.reason}`);
    if (attackToxic) reasons.push(`[攻击] ${attack.reason}`);

    return {
      verdict: 'toxic',
      confidence: higher.confidence || 0.85,
      layer: 3,
      reason: reasons.join('；'),
      patterns,
      // ★ 附加字段：供 auto-learn / topicFilter 使用
      intent: topicToxic ? (topic.topic_label || null) : null,
      _dualTopic: topicToxic ? topic : null,
      _dualAttack: attackToxic ? attack : null,
    };
  }

  async _callAPI(prompt) {
    const apiConfig = this._getAPIConfig();

    if (apiConfig.format === 'openai') {
      const data = await this._gmFetch(apiConfig.url, {
        method: 'POST',
        headers: apiConfig.headers,
        body: JSON.stringify({
          model: apiConfig.model,
          max_tokens: 200,
          messages: [
            { role: 'system', content: buildSystemPrompt(getLang()) },
            { role: 'user', content: prompt },
          ],
        }),
      });
      const raw = data.choices?.[0]?.message?.content || '{}';
      const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
      return this._combineDualTrack(result);
    }

    // Claude 格式
    const data = await this._gmFetch(apiConfig.url, {
      method: 'POST',
      headers: apiConfig.headers,
      body: JSON.stringify({
        model: apiConfig.model,
        system: buildSystemPrompt(getLang()),
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const raw = data.content?.[0]?.text || '{}';
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());

    return this._combineDualTrack(result);
  }

  _gmFetch(url, options = {}) {
    const TIMEOUT = options.timeout || 15000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleOnce = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        fn(val);
      };

      // ★ 安全兜底：某些管理器的跨域权限拒绝会静默吞掉请求（onload/onerror/ontimeout 都不触发）
      // 这个 top-level 超时确保 Promise 一定在 TIMEOUT + 2s 内 settle，不会永久挂起
      const safetyTimer = setTimeout(() => {
        settleOnce(reject, new Error(`Request failed (no response after ${TIMEOUT + 2000}ms — possible cross-origin permission denied)`));
      }, TIMEOUT + 2000);

      try {
        GM_xmlhttpRequest({
          url,
          method: options.method || 'GET',
          headers: options.headers || {},
          data: options.body,
          timeout: TIMEOUT,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              let data = res.response;
              if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (e) { /* 不是 JSON，保持原样 */ }
              }
              settleOnce(resolve, data);
            } else {
              const detail = res.responseText?.slice(0, 300) || res.statusText || '';
              settleOnce(reject, new Error(`HTTP ${res.status}: ${detail}`));
            }
          },
          onerror: () => settleOnce(reject, new Error('Network error')),
          ontimeout: () => settleOnce(reject, new Error(`Request timed out (${TIMEOUT}ms)`)),
        });
      } catch (e) {
        settleOnce(reject, e);
      }
    });
  }

  /** 更新配置（面板修改后调用） */
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
    // 如果更新了每日限额，重置计数（仅在变更时）
    if (newConfig.aiDailyLimit && this.dailyCount >= newConfig.aiDailyLimit) {
      console.log('[CyberShield] AI daily limit updated, daily count may exceed new limit');
    }
  }

  /**
   * 通用聊天接口，不附带 toxicity system prompt，供 Agent 等场景使用
   * @param {string} message  - 用户消息
   * @param {object} [opts]   - { maxTokens, system }
   * @returns {Promise<string>}  AI 回复文本
   */
  async chat(message, opts = {}) {
    if (!this.shouldAnalyze()) throw new Error('AI not available (no key or daily limit)');
    const apiConfig = this._getAPIConfig();
    const maxTokens = opts.maxTokens || 500;
    const systemMsg = opts.system || 'You are a helpful assistant. Respond concisely.';

    let rawData, raw;

    if (apiConfig.format === 'gemini') {
      rawData = await this._gmFetch(apiConfig.url, {
        method: 'POST',
        headers: apiConfig.headers,
        body: JSON.stringify({
          contents: [{ parts: [{ text: message }] }],
          generationConfig: { maxOutputTokens: maxTokens },
          systemInstruction: { parts: [{ text: systemMsg }] },
        }),
      });
      raw = rawData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (apiConfig.format === 'openai') {
      rawData = await this._gmFetch(apiConfig.url, {
        method: 'POST',
        headers: apiConfig.headers,
        body: JSON.stringify({
          model: apiConfig.model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user', content: message },
          ],
        }),
      });
      raw = rawData.choices?.[0]?.message?.content || '';
    } else {
      // Claude 格式
      rawData = await this._gmFetch(apiConfig.url, {
        method: 'POST',
        headers: apiConfig.headers,
        body: JSON.stringify({
          model: apiConfig.model,
          system: systemMsg,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: message }],
        }),
      });
      raw = rawData.content?.[0]?.text || '';
    }

    this._recordTokenUsage(rawData, apiConfig.format);
    this._connected = true;
    this.dailyCount++;
    this._saveDailyCount();
    return raw.trim();
  }

  /**
   * 获取当前 API 端点、headers、默认模型
   * 根据 aiProvider 返回不同的请求参数
   */
  _getAPIConfig() {
    const provider = this.config.aiProvider || 'claude';
    const customModel = this.config.aiModel || '';

    switch (provider) {
      case 'deepseek': {
        const endpoint = this.config.aiEndpoint || 'https://api.deepseek.com/chat/completions';
        const model = customModel || 'deepseek-chat';
        return {
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          model,
          format: 'openai',
        };
      }
      case 'mimo': {
        const endpoint = this.config.aiEndpoint || 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions';
        const model = customModel || 'mimo-v2-flash';
        return {
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          model,
          format: 'openai',
        };
      }
      case 'glm': {
        const endpoint = this.config.aiEndpoint || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
        const model = customModel || 'glm-4-flash';
        return {
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          model,
          format: 'openai',
        };
      }
      case 'kimi': {
        const endpoint = this.config.aiEndpoint || 'https://api.moonshot.cn/v1/chat/completions';
        const model = customModel || 'moonshot-v1-8k';
        return {
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          model,
          format: 'openai',
        };
      }
      case 'gemini': {
        const endpoint = this.config.aiEndpoint || `https://generativelanguage.googleapis.com/v1beta/models/${customModel || 'gemini-2.0-flash'}:generateContent`;
        const model = customModel || 'gemini-2.0-flash';
        return {
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.config.apiKey,
          },
          model,
          format: 'gemini',
        };
      }
      case 'openrouter': {
        const endpoint = this.config.aiEndpoint || 'https://openrouter.ai/api/v1/chat/completions';
        const model = customModel || 'openai/gpt-4o-mini';
        return {
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'HTTP-Referer': typeof location !== 'undefined' ? location.origin : '',
          },
          model,
          format: 'openai',
        };
      }
      case 'openai': {
        const endpoint = this.config.aiEndpoint || 'https://api.openai.com/v1/chat/completions';
        const model = customModel || 'gpt-4o-mini';
        return {
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          model,
          format: 'openai',
        };
      }
      case 'custom': {
        const endpoint = this.config.aiEndpoint || '';
        const model = customModel || '';
        // 自定义端点默认用 OpenAI 兼容格式
        return {
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          model,
          format: 'openai',
        };
      }
      case 'claude':
      default: {
        return {
          url: 'https://api.anthropic.com/v1/messages',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          model: customModel || 'claude-sonnet-4-20250514',
          format: 'claude',
        };
      }
    }
  }

  /**
   * 验证 API 密钥是否有效
   * 发送一个最小请求来测试连通性
   */
  async validateKey() {
    if (!this.config.apiKey) return { ok: false, error: 'No API key' };

    try {
      const apiConfig = this._getAPIConfig();
      if (!apiConfig.url) return { ok: false, error: 'No endpoint configured' };

      let ok = false;

      if (apiConfig.format === 'gemini') {
        const data = await this._gmFetch(apiConfig.url, {
          method: 'POST',
          headers: apiConfig.headers,
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Hi' }] }],
            generationConfig: { maxOutputTokens: 5 },
          }),
        });
        ok = !!(data.candidates || data.promptFeedback);
      } else if (apiConfig.format === 'openai') {
        const data = await this._gmFetch(apiConfig.url, {
          method: 'POST',
          headers: apiConfig.headers,
          body: JSON.stringify({
            model: apiConfig.model,
            max_tokens: 5,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
        ok = !!(data.choices || data.id || data.content);
      } else {
        const data = await this._gmFetch(apiConfig.url, {
          method: 'POST',
          headers: apiConfig.headers,
          body: JSON.stringify({
            model: apiConfig.model,
            max_tokens: 5,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
        ok = !!(data.content || data.id);
      }

      this._connected = ok;
      return { ok, error: ok ? null : 'Unexpected response format' };
    } catch (err) {
      console.warn('[CyberShield] API key validation failed:', err.message);
      this._connected = false;
      return { ok: false, error: err.message };
    }
  }
}