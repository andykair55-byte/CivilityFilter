import { createEngine } from './packages/user/ai/ai-agent-engine/src-new/index.js';
import { classifyTask } from './packages/user/ai/ai-agent-engine/src-new/core/intent.js';

const fakeTopic = { id: 'personal_attack', name: { zh: '人身攻击' }, description: '', category: 'attack', keywords: { zh: ['傻逼', '废物'] }, scopes: [{ id: 'comment' }], enabled: true, source: 'builtin' };
const topicFilter = { topics: { personal_attack: fakeTopic }, getAllTopics: () => [fakeTopic], getTopicDetail: (id) => topicFilter.topics[id] || null, toggleTopic: () => true, addUserTopic: (t) => { topicFilter.topics[t.id] = t; return true; }, removeKeywordFromTopic: () => true, getTopicExamples: () => [], _save: () => {} };

const e = createEngine({
  topicFilter, ruleLearner: { learnFromSample: () => ({ learned: true }) },
  detector: { analyze: () => ({ verdict: 'safe', confidence: 0.9, layer: 1 }) },
  memory: { getUserPreferenceSummary: () => ({ enabledTopics: [] }), recordPreference: () => true },
});

const decision = classifyTask('今天天气真不错', (q) => {
  try {
    const t = topicFilter.topics.personal_attack;
    if (q && t && t.keywords.zh.some(k => q.includes(k))) return { topic: t, category: null };
  } catch {}
  return { topic: null, category: null };
});
console.log('classifyTask decision:', JSON.stringify({
  domain: decision.domain,
  action: decision.action,
  entities: decision.entities,
  domainReason: decision.domainReason,
}, null, 2));

const r = await e.process('今天天气真不错');
console.log('process result type:', r?.type, 'summary:', r?.summary?.slice(0, 60));
console.log('active task:', e.getStatus()?.activeTask);
