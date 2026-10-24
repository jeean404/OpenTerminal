// 跟流意图判定（纯函数，node --test 直测）。
//
// 唯一滚动面是 .ot-stage：上半是冻结块流（.ot-blocks），下半是活动终端，
// 而活动终端恰好一屏高（fit 按舞台高度给）。所以「流底」是**活动终端光标**
// （活尾巴），不是块流底边。
//
// 真机现场（2026-10-24，腾讯云主机总结卡）：旧 _stageFollowTop 把 scrollTop
// 贴到块流底边，于是活动终端被整块挤出视口（图二：只剩总结卡底、命令行整块
// 消失）；而用户翻到下方空白（图一）后，任何一次重排——状态栏 2px 高度翻动
// （⏹ 停止钮/思考徽标显隐）、卡片打字机长高——都会触发 stage/块区 RO 把视口
// 拽回去。用户感知就是「选中文字时界面突然跳到卡片底部」：选中只是碰巧同帧，
// 真正的扳机是重排。
//
// 两条口径配套使用：
//   atStreamTail(g)            用户是否仍在看活尾巴（跟流意愿）
//   cursorNudge(stage, cursor) 把光标拉回视口要补多少像素（0 = 不用动）
// 只有意愿在才允许补滚动；用户一翻走就再不动滚动条，回到流底自动再跟。
"use strict";

// g = {
//   cursor: {top, bottom, height} | null   光标矩形；height<=0 或缺省视作不可量
//   stage:  {top, bottom}                  舞台可视区矩形
//   scrollTop, scrollHeight, clientHeight  舞台滚动几何（光标不可量时的兜底判定）
//   slack                                  视口底边之下多少像素内仍算「看着活尾巴」
// }
// slack 取 0（默认）＝「光标在视口内」才算看着活尾巴。已定决策是「用户一往上翻
// 就停住」——留大容差会把「刚翻走一点点」也算作继续跟流，随后又被拽回来，正是
// 要根治的那种体感。光标是一整行（约 25px），行高本身已给出自然容差。
function atStreamTail(g) {
  const slack = (g && g.slack != null) ? Number(g.slack) : 0;
  const c = g && g.cursor;
  const s = g && g.stage;
  if (c && s && Number(c.height) > 0) {
    return Number(c.bottom) > Number(s.top) && Number(c.top) < Number(s.bottom) + slack;
  }
  // 光标不可量（alt 屏 / 未渲染）：退回「贴内容底」判定
  const n = g
    ? Number(g.scrollHeight) - Number(g.scrollTop) - Number(g.clientHeight)
    : Infinity;
  return n <= 32;
}

// 把光标拉回视口要补的滚动量（px，正=往下滚，负=往上滚）。0 = 光标已在视口内。
// 与旧 _ensureTerminalCursorVisible 的几何等价，只是提出来可直测。
function cursorNudge(stageRect, cursorRect) {
  if (!stageRect || !cursorRect) return 0;
  if (!(Number(cursorRect.height) > 0)) return 0;
  if (Number(cursorRect.bottom) > Number(stageRect.bottom)) {
    return Number(cursorRect.bottom) - Number(stageRect.bottom);
  }
  if (Number(cursorRect.top) < Number(stageRect.top)) {
    return Number(cursorRect.top) - Number(stageRect.top);
  }
  return 0;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { atStreamTail, cursorNudge };
}
