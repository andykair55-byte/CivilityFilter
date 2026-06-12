#!/usr/bin/env node
/**
 * 跨平台 build 脚本：替代 cross-env
 *   - 设置 CS_BUILD_MODE 环境变量
 *   - 透传其余参数到 rollup
 *
 * 用法：
 *   node scripts/build.mjs dev
 *   node scripts/build.mjs user --watch
 *   node scripts/build.mjs            （默认 user）
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const mode = (process.argv[2] || 'user').toLowerCase();
if (mode !== 'dev' && mode !== 'user') {
  console.error(`[build] Unknown mode: ${mode} (expected 'dev' or 'user')`);
  process.exit(1);
}
const watchFlag = process.argv.includes('--watch') || process.argv.includes('-w');
const remaining = process.argv.slice(3).filter(a => a !== '--watch' && a !== '-w');

// 透传到 rollup CLI
const rollupArgs = ['rollup', '-c', 'rollup.config.js'];
if (watchFlag) rollupArgs.push('--watch');
rollupArgs.push(...remaining);

const env = { ...process.env, CS_BUILD_MODE: mode };
console.log(`[build] mode=${mode}${watchFlag ? ' (watch)' : ''}`);

const child = spawn('npx', rollupArgs, {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32', // Windows: npx 需 shell
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`[build] Failed to start rollup: ${err.message}`);
  process.exit(1);
});
