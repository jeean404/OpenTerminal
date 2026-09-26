// pad 账目纯函数（node --test 可直测）。唯一权威是 xterm 缓冲：
// worker 的 padded 应答只当唤醒信号，不入账。
"use strict";

// 卡片像素高 → 行数（至少 1 行）；cellH 非法时兜底 1 行。
function rowsForPx(hPx, cellH) {
  if (!(cellH > 0)) return 1;
  if (!(hPx > 0)) return 1;
  return Math.max(1, Math.ceil(hPx / cellH));
}

// 从 startLine 起的**连续**空白行数，最多到 limit（不含）。translateToString(true)
// 去尾空白后为空即判空；越界/缺行视为空白（宁可少补，不可虚记）。
// 这段连续空白就是该卡的预留区：其后一旦出现真实输出，pad 只能追加在流底、
// 垫不进本区（该卡即「被盖帽」，长高只许截断）。旧实现按 [marker, 光标)
// 整段数空白——把卡下方的命令输出也算进区宽，于是「blank < 区宽」恒成立、
// 流底卡被误判成上游卡：一边夹紧钉高一边反复重贴（真机截断 + 闪）。
// 纯空白行必须 trim 后再判：translateToString(true) 只裁到「最后写入的单元格」，
// zsh 重画提示符时擦过的旧行留下整行空格、原样返回——不 trim 就把空格行当成
// 真实输出掐断空白 run，预留区永远数不满（真机流底卡出生即盖帽的来源之一）。
// 空格行上没有可见字形，卡盖上去不构成遮挡，判空白是安全的。
function blankRun(buf, startLine, limit) {
  if (!buf) return 0;
  const end = Math.max(startLine, limit | 0);
  let n = 0;
  while (startLine + n < end) {
    const line = buf.getLine(startLine + n);
    const s = line ? line.translateToString(true) : "";
    if (s && s.trim()) break;
    n++;
  }
  return n;
}

// 还缺多少：need 行（含 +1 保险）减去预留区里已有的连续空白 run。
// 只补真缺口，永不为负。
function padGap(need, blank) {
  return Math.max(0, need - blank);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { rowsForPx, blankRun, padGap };
}
