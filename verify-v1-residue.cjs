const fs = require('fs');
const s = fs.readFileSync('dist/cyber-shield-user.user.js', 'utf8');
const patterns = [
  'AI请告诉我',
  '能再具体一点',
  '我不太确定你的意思',
  'agentV2UseV2',
  '使用智能模式',
  '经典对话模式',
  'cs-v2-toggle-input',
  'stateMachine',
  'ruleGenerator',
  'memorySync',
];
let total = 0;
for (const p of patterns) {
  const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const n = (s.match(re) || []).length;
  total += n;
  console.log(`  ${p}: ${n}`);
}
console.log('---');
console.log(`TOTAL v1-residue: ${total}`);
process.exit(total > 0 ? 1 : 0);
