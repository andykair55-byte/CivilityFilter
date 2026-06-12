/**
 * domain-classifier.js — 第 1 层决策：业务域判定
 *
 * 决定输入是否属于 CyberShield 业务范围。
 * 命中 OUT_OF_SCOPE → 编排器走专属回拒路径，不再进入任务层。
 *
 * 设计原则：
 *   - 规则优先：明确的 OUT_OF_SCOPE 信号词（写代码/翻译/写诗/聊天/百科）直接判定
 *   - 业务优先：业务信号（屏蔽/过滤/诊断/撤销）即使夹杂其他内容也按业务处理
 *   - 短确认默认 IN_SCOPE：让编排器结合上下文判断是确认还是新任务
 *   - 兜底 IN_SCOPE：避免误杀，让编排器走完整意图识别
 */

import { AGENT_DOMAIN } from './types.js';

// ── OUT_OF_SCOPE 词典（命中任一即视为越界）───────────────────
// 注意：JS 的 \b 只在 [a-zA-Z0-9_] 之间生效，对中文无效。
// 因此用「中文字符视为边界」(?:^|[\\s\\u3000，。.!?;:；：]|[\\u4e00-\\u9fa5]) 替代。
const OUT_OF_SCOPE_PATTERNS = [
  // 编程（"写一段代码"、"帮我写代码"、"写个程序"等）
  new RegExp('(?:^|[\\s\\u3000，。.!?;:；：\\u4e00-\\u9fa5])写[一]?[个段篇]?[\\s\\u3000]*(代码|程序|脚本|函数|算法|正则|sql|html|css|js|java|python|ts|jsx|tsx)', 'i'),
  new RegExp('(?:^|[\\s\\u3000，。.!?;:；：\\u4e00-\\u9fa5])(code|coding|program|debug)', 'i'),
  // 翻译
  new RegExp('(?:^|[\\s\\u3000，。.!?;:；：\\u4e00-\\u9fa5])(翻译|译成|translate|translation)', 'i'),
  // 写作（与配置/过滤/规则无关的纯写作）
  // 必须同时出现「写」+「写作目标词」且在 8 字符内（避免误伤 "帮我写一首过滤的诗" 这类）
  new RegExp('(?:^|[\\s\\u3000，。.!?;:；：\\u4e00-\\u9fa5])写.{0,8}(诗|词|歌词|小说|故事|文章|文案|读后感|影评|书评|日记)'),
  // 通用聊天
  new RegExp('^\\s*(讲[个]?笑话|说[个]?笑话|聊天|闲聊|陪我|你好|hello|hi|hey)[\\s\\u3000,。.！!]*$', 'i'),
  // 百科
  new RegExp('什么是.{0,8}[？?]?\\s*$'),
  new RegExp('(what|who)\\s+is\\b', 'i'),
  new RegExp('how\\s+(do|does|did|can|to)\\b', 'i'),
  // 数学/计算
  new RegExp('^\\s*\\d+[\\s\\u3000]*[\\+\\-\\*\\/×x÷][\\s\\u3000]*\\d+'),
  new RegExp('(?:^|[\\s\\u3000，。.!?;:；：\\u4e00-\\u9fa5])(计算|算[一]?[下个]?|求[值和]?)[\\s\\u3000]*\\d'),
];

// ── 业务信号（任一命中 → 强制 IN_SCOPE）────────────────────
const IN_SCOPE_SIGNALS = [
  // 屏蔽/过滤/拦截/隐藏 类动词
  new RegExp('(屏蔽|过滤|拦截|隐藏|不想看|不要|拉黑|讨厌|屏蔽掉|看烦|不想见|不想浏览|不想读|不想听|不想再看到)'),
  // 开关配置类
  new RegExp('(开启|启用|关闭|禁用|打开|关掉|调整|设置|修改|改)[\\s\\u3000,。.]{0,6}(过滤|话题|规则|关键词|语义|检测|识别|敏感度|阈值|scope)'),
  new RegExp('(过滤|话题|规则|关键词|语义|检测|识别|scope)[\\s\\u3000,。.]{0,4}(开启|启用|关闭|禁用|打开|关掉|列表|哪些|什么)'),
  // 诊断/排查
  new RegExp('(为什么|怎么|咋)[\\s\\u3000,。.]{0,6}(没|不)(过滤|拦截|屏蔽|屏蔽掉|命中|识别|拦)'),
  new RegExp('(诊断|排查|分析下|分析一下|看下|看一下)[\\s\\u3000,。.]{0,6}(这条|这个|该|那|这|帖子|评论|回复|内容|文本)'),
  // 撤销/回滚
  new RegExp('(撤销|回滚|undo|恢复上一|恢复之前|回到之前|撤销刚才|撤销最近)'),
  // 询问当前状态
  new RegExp('^(现在|当前|目前)[\\s\\u3000]*(过滤|话题|规则|配置|状态|开了啥|有什么)'),
  new RegExp('过滤了[\\s\\u3000]*(什么|哪些|啥|几个|多少)'),
  // 学习/规则相关
  new RegExp('(学习|记住|以后都|这种都|下次也|都给我(过滤|屏蔽|拦))'),
];

/**
 * 判定业务域
 * @param {string} input
 * @returns {{ domain: 'in_scope' | 'out_of_scope', reason: string, confidence: number }}
 */
export function classifyDomain(input) {
  const text = String(input || '').trim();
  if (!text) {
    return { domain: AGENT_DOMAIN.OUT_OF_SCOPE, reason: 'empty', confidence: 0 };
  }

  // 1) 强业务信号优先（业务永远优于越界判定）
  for (const re of IN_SCOPE_SIGNALS) {
    if (re.test(text)) {
      return { domain: AGENT_DOMAIN.IN_SCOPE, reason: 'in_scope_signal', confidence: 0.9 };
    }
  }

  // 2) 越界信号
  for (const re of OUT_OF_SCOPE_PATTERNS) {
    if (re.test(text)) {
      return { domain: AGENT_DOMAIN.OUT_OF_SCOPE, reason: 'out_of_scope_match', confidence: 0.85 };
    }
  }

  // 3) 极短确认/取消 → 视为上下文相关（默认 in_scope，让编排器结合 active task 判断）
  if (/^(好|是|对|行|可以|继续|确认|ok|yes|y|sure|嗯|哦|好的|对的|没错|好的吧|不要|算了|取消|no|n|nope)\s*[。.！!]?\s*$/i.test(text)) {
    return { domain: AGENT_DOMAIN.IN_SCOPE, reason: 'short_ack', confidence: 0.6 };
  }

  // 4) 兜底：默认 in_scope（让编排器走意图识别）
  return { domain: AGENT_DOMAIN.IN_SCOPE, reason: 'default_in_scope', confidence: 0.5 };
}
