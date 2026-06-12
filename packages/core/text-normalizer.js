/**
 * text-normalizer.js — 文本归一化流水线
 *
 * 按顺序执行以下标准化步骤（仅作用于检测副本，不影响原文）：
 * 1. 去除零宽字符（U+200B 等不可见插入字符）
 * 2. 折叠连续空格与标点
 * 3. 大小写统一（全部转小写）
 * 4. 全角转半角
 * 5. 常见 leet speak 还原
 * 6. 重复字符压缩
 */

// Leet speak 映射表
const LEET_MAP = {
  '@': 'a',
  '4': 'a',
  '3': 'e',
  '1': 'i',
  '!': 'i',
  '0': 'o',
  '$': 's',
  '5': 's',
  '7': 't',
  '+': 't',
  '2': 'z',
};

// 零宽字符正则
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\uFEFF]/g;

// 全角字符范围
const FULLWIDTH_RE = /[\uFF01-\uFF5E]/g;
const FULLWIDTH_SPACE = /\u3000/g;

/**
 * 文本归一化主入口
 * @param {string} text 原始文本
 * @param {object} options 可选配置
 * @param {boolean} options.preserveNumbers 是否保留数字（避免影响"转账2000元"等场景）
 * @returns {string} 归一化后的文本
 */
export function normalizeText(text, options = {}) {
  if (!text) return '';

  let result = text;

  // 1. 去除零宽字符
  result = removeZeroWidth(result);

  // 2. 全角转半角
  result = fullwidthToHalfwidth(result);

  // 3. 大小写统一
  result = result.toLowerCase();

  // 4. 折叠连续空格
  result = collapseSpaces(result);

  // 5. Leet speak 还原（可选保留数字）
  result = restoreLeetSpeak(result, options.preserveNumbers);

  // 6. 重复字符压缩
  result = compressRepeats(result);

  return result.trim();
}

/**
 * 去除零宽字符
 */
function removeZeroWidth(text) {
  return text.replace(ZERO_WIDTH_RE, '');
}

/**
 * 全角转半角
 */
function fullwidthToHalfwidth(text) {
  let result = text.replace(FULLWIDTH_RE, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  result = result.replace(FULLWIDTH_SPACE, ' ');
  return result;
}

/**
 * 折叠连续空格为单个空格
 */
function collapseSpaces(text) {
  return text.replace(/\s+/g, ' ');
}

/**
 * Leet speak 还原
 * @param {string} text
 * @param {boolean} preserveNumbers 是否保留数字（避免误替换"转账2000元"中的数字）
 */
function restoreLeetSpeak(text, preserveNumbers = false) {
  if (preserveNumbers) {
    // 只在明确的 leet 模式下替换（如 @、!、$ 等符号）
    return text.replace(/[@!$+]/g, c => LEET_MAP[c] || c);
  }

  // 完整替换（包括数字）
  return text.replace(/[@431!0$57+2]/g, c => LEET_MAP[c] || c);
}

/**
 * 重复字符压缩（如 "傻aaaa逼" → "傻a逼"）
 * 只压缩连续 3 个以上相同字符
 */
function compressRepeats(text) {
  return text.replace(/(.)\1{2,}/g, '$1');
}

/**
 * 深度归一化（用于变体检测）
 * 在基础归一化之上，额外去除所有空格和特殊符号
 */
export function normalizeDeep(text, options = {}) {
  let result = normalizeText(text, options);

  // 去除所有空格（用于检测拆分绕过）
  result = result.replace(/\s+/g, '');

  // 去除常见分隔符号
  result = result.replace(/[.*\-_~`|\\/^<>{}()\[\]#!$%&+=;:'",?]/g, '');

  return result;
}
