import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 读取构建模式：env 变量优先；CLI 次之；默认 user
//   npm run build:dev  → CS_BUILD_MODE=dev
//   npm run build:user → CS_BUILD_MODE=user
//   npm run build      → user
const BUILD_MODE = (process.env.CS_BUILD_MODE || process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'user').toLowerCase();
if (BUILD_MODE !== 'dev' && BUILD_MODE !== 'user') {
  throw new Error(`[rollup] Unknown CS_BUILD_MODE: ${BUILD_MODE} (expected 'dev' or 'user')`);
}
const isDev = BUILD_MODE === 'dev';
const VERSION = isDev ? '0.7.0-dev' : '0.7.0';
const SUFFIX = isDev ? '-dev' : '';
const FILE_NAME = `dist/cyber-shield-user${SUFFIX}.user.js`;

/**
 * 简单的字符串替换插件（无需安装 @rollup/plugin-replace）
 * 在打包时把源码里的 __CS_*_ 占位符替换为实际值
 * 跳过 // 和 /* ... *\/ 注释，避免误替换注释里的占位符
 * 用 JSON.stringify 转义：保证换行/引号/反斜杠在源码任意位置都是合法的 JS 字符串字面量
 */
function csReplace(values) {
  // 预计算每个 key 的替换字面量：
  //   - 字符串值（包含换行/引号/反斜杠的内容）→ JSON.stringify 转义，保证源码任意位置合法
  //   - 布尔值 → 直接以 true / false 字面量替换（不带引号），用于 typeof 检查 / 条件分支
  const escaped = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      typeof v === 'boolean' ? String(v) : JSON.stringify(String(v)),
    ])
  );
  return {
    name: 'cs-replace',
    transform(code, id) {
      if (!/\.(js|mjs)$/.test(id)) return null;
      // 去掉单行注释和多行注释，保留行号位置（用空格填充）
      const codeNoComment = code
        .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))   // /* ... */
        .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));         // // ...
      let out = code;
      let changed = false;
      for (const [k, v] of Object.entries(escaped)) {
        const token = `__CS_${k}__`;
        // 仅在非注释位置替换
        const parts = [];
        let last = 0;
        let idx = codeNoComment.indexOf(token);
        while (idx !== -1) {
          parts.push(out.slice(last, idx));
          parts.push(v);
          last = idx + token.length;
          idx = codeNoComment.indexOf(token, last);
        }
        if (parts.length > 0) {
          parts.push(out.slice(last));
          out = parts.join('');
          changed = true;
        }
      }
      return changed ? { code: out, map: null } : null;
    },
  };
}

// UserScript header：dev/user 区别
//   dev: 标记为 "Dev Build" + 描述提醒 + 输出文件名带 -dev
//   user: 默认
const USERSCRIPT_HEADER = `// ==UserScript==
// @name         CyberShield${isDev ? ' [DEV]' : ''}
// @name:zh-CN   CyberShield 网暴保护${isDev ? ' [开发版]' : ''}
// @namespace    https://github.com/andykair55-byte/CivilityFilter.git
// @version      ${VERSION}
// @description  ${isDev ? '🛠️ DEV BUILD — includes test panel and extra diagnostics. NOT FOR END USERS.' : 'Protect yourself from online harassment. Detects, blurs, and logs toxic content.'}
// @description:zh-CN ${isDev ? '🛠️ 开发版 — 包含调试面板与诊断工具，仅供开发者使用。' : '保护你免受网络暴力。自动检测、屏蔽并记录骚扰内容。'}
// @author       CyberShield Contributors
// @license      MIT
//
// @match        *://twitter.com/*
// @match        *://x.com/*
// @match        *://www.reddit.com/*
// @match        *://www.youtube.com/*
// @match        *://weibo.com/*
// @match        *://www.weibo.com/*
// @match        *://*.bilibili.com/*
// @match        *://www.zhihu.com/*
// @match        *://tieba.baidu.com/*
//
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_notification
// @connect      api.anthropic.com
// @connect      api.bilibili.com
// @connect      bilibili.com
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      open.bigmodel.cn
// @connect      api.moonshot.cn
// @connect      generativelanguage.googleapis.com
// @connect      openrouter.ai
// @connect      xiaomimimo.com
// @connect      *
//
// @run-at       document-idle
// ==/UserScript==
`;

console.log(`[rollup] Build mode: ${BUILD_MODE.toUpperCase()}`);
console.log(`[rollup] Version:    ${VERSION}`);
console.log(`[rollup] Output:     ${FILE_NAME}`);

export default {
  input: 'packages/user/index.user.js',
  output: {
    file: FILE_NAME,
    format: 'iife',
    banner: USERSCRIPT_HEADER,
    // dev 模式开启 sourcemap，便于调试（位置必须在 output.sourcemap，而非顶层）
    sourcemap: isDev,
  },
  plugins: [
    json(),
    resolve(),
    // 把源码里的占位符替换为实际值：
    //   DEV_MODE_BUILDFLAG        → 布尔字面量 true / false（用于 typeof 检查）
    //   DEV_MODE                  → "true" / "false" 字符串
    //   BUILD_VERSION             → 版本号字符串
    //   DEBUG_PANEL_CSS_PLACEHOLDER → 整段 debug 面板 CSS（仅 dev 构建注入；user 为空）
    csReplace({
      DEV_MODE_BUILDFLAG: isDev,
      DEV_MODE: String(isDev),
      BUILD_VERSION: VERSION,
      DEBUG_PANEL_CSS_PLACEHOLDER: isDev
        ? readFileSync(pathResolve(__dirname, 'scripts/debug-panel.css'), 'utf8').trim()
        : '',
    }),
  ],
};
