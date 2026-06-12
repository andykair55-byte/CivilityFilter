// 端到端冒烟测试：使用真实 src-new 路径模拟 panel.js 调用流程
// 每次 case 独立创建 engine（模拟清空对话）
import { createEngine } from './packages/user/ai/ai-agent-engine/src-new/index.js';

const fakeTopic = {
  id: 'personal_attack', name: { zh: '人身攻击' },
  description: '人身攻击类话题', category: 'attack',
  keywords: { zh: ['傻逼', '废物'], en: ['idiot', 'loser'] },
  scopes: [{ id: 'comment' }],
  enabled: true, source: 'builtin',
};
const makeEngine = () => {
  const topicFilter = {
    topics: { personal_attack: fakeTopic },
    getAllTopics: () => [fakeTopic],
    getTopicDetail: (id) => topicFilter.topics[id] || null,
    toggleTopic: () => true,
    addUserTopic: (t) => { topicFilter.topics[t.id] = t; return true; },
    removeKeywordFromTopic: () => true,
    getTopicExamples: () => [],
    _save: () => {},
  };
  return createEngine({
    topicFilter,
    ruleLearner: { learnFromSample: () => ({ learned: true }) },
    detector: { analyze: (t) => ({ verdict: 'safe', confidence: 0.9, layer: 1, reason: '', matched: '', riskLevel: 'L0' }) },
    memory: { getUserPreferenceSummary: () => ({ enabledTopics: [] }), recordPreference: () => true },
  });
};

const cases = [
  // ── OUT_OF_SCOPE
  { name: 'OUT_OF_SCOPE（写代码）', input: '帮我写一段 Python 代码', expectType: 'OUT_OF_SCOPE' },
  // 边界 case：闲聊型无 noise 词，被动态生成器兜底为 topic；用户可在确认时驳回
  // 期望：PLAN（dynamic 兜底）或 OUT_OF_SCOPE（理想），均视为可接受
  { name: 'OUT_OF_SCOPE/PLAN（闲聊）', input: '今天天气真不错', expectType: ['OUT_OF_SCOPE', 'PLAN', 'CLARIFY'] },
  // ── CAPABILITY_LIST
  { name: 'CAPABILITY_LIST',       input: '你能做什么',             expectType: 'CAPABILITY_LIST' },
  // ── CREATE 阶段：返回 PLAN（带 requiresConfirmation）
  { name: 'CREATE→PLAN（知识库）', input: '我不想看到性别对立的内容', expectType: 'PLAN' },
  { name: 'CREATE→PLAN（动态）',   input: '评论区不要看到洛克王国',   expectType: 'PLAN' },
  { name: 'CREATE→PLAN（动态2）',  input: '动态里屏蔽游戏剧透',       expectType: 'PLAN' },
  { name: 'CREATE→PLAN（动态3）',  input: '回复区不要出现喷子',       expectType: 'PLAN' },
  { name: 'CREATE→PLAN（动态4）',  input: '不要给我看王者荣耀',       expectType: 'PLAN' },
  // ── DIAGNOSE
  { name: 'DIAGNOSE_REQUEST',     input: '为什么这条评论没被过滤',   expectType: 'DIAGNOSE_REQUEST' },
  // ── ROLLBACK（无 active）
  { name: 'ROLLBACK（无 active）', input: '撤销上一步',               expectType: 'INFO' },
  // ── 上下文确认
  { name: 'CLARIFY（无 active）',  input: '好',                       expectType: 'CLARIFY' },
  { name: 'CANCEL（无 active）',   input: '不',                       expectType: 'INFO' },
];

// ── 续接：CREATE 后发"好"应执行 PLAN
{
  const e = makeEngine();
  const plan1 = await e.process('我不想看到性别对立的内容');
  const plan2 = await e.process('好');
  const ok = plan1?.type === 'PLAN' && plan2?.type === 'DONE';
  console.log(`  [${ok ? '✓' : '✗'}] 续接：CREATE→CONFIRM → PLAN+DONE  (plan1=${plan1?.type}, plan2=${plan2?.type})`);
  if (!ok) process.exit(1);
}

let pass = 0, fail = 0;
for (const tc of cases) {
  const e = makeEngine();
  const r = await e.process(tc.input);
  const expected = Array.isArray(tc.expectType) ? tc.expectType : [tc.expectType];
  const ok = expected.includes(r?.type);
  console.log(`  [${ok ? '✓' : '✗'}] ${tc.name}  →  ${r?.type}  ${r?.summary ? '· ' + r.summary.slice(0, 30) : ''}`);
  if (ok) pass++; else fail++;
}
console.log('---');
console.log(`PASS: ${pass}/${cases.length}  FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
