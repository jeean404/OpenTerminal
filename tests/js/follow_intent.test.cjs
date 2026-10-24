"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  atStreamTail, cursorNudge,
} = require("../../src/openterminal/web/frontend/static/follow_intent.js");

// 真机几何（1400×900、31 行、行高约 25.5px）：舞台 clientHeight=793，
// 块流高 B、活动终端高 792（fit 给一屏），内容底 = B + 792。
const CH = 793;                 // stage.clientHeight
const STAGE_TOP = 77, STAGE_BOTTOM = 870;
const BLOCKS_H = 5808;

const stage = () => ({ top: STAGE_TOP, bottom: STAGE_BOTTOM });

// 光标在活动终端第 row 行：活动终端顶 = 块流底 = 内容坐标 BLOCKS_H
const cursorAt = (scrollTop, row, lh = 25.5) => {
  const y = BLOCKS_H + row * lh - scrollTop;   // 视口坐标
  return { top: STAGE_TOP + y, bottom: STAGE_TOP + y + lh, height: lh };
};

test("图一现场：光标在视口内 → 仍算流底，但**不需要**任何滚动", () => {
  // 用户翻到下方空白边缘（scrollTop = 块流底 - 100）：卡尾 + 提示符 + 大片空白
  const scrollTop = BLOCKS_H - 100;
  const g = {
    cursor: cursorAt(scrollTop, 10), stage: stage(),
    scrollTop, scrollHeight: BLOCKS_H + 792, clientHeight: CH,
  };
  assert.equal(atStreamTail(g), true, "用户仍看着活尾巴，跟流意愿在");
  assert.equal(cursorNudge(g.stage, g.cursor), 0,
    "光标在视口内——重排（状态栏 2px 翻动/卡片长高）不得移动视图");
});

test("图二回归：跟流落点是「光标可见」，不是「块流底边贴视口底」", () => {
  // 旧 _stageFollowTop = BLOCKS_H - clientHeight：可见区正好是块流最后一屏，
  // 活动终端整块落在视口下方（图二：只剩总结卡底、命令行整块消失）。
  const scrollTop = BLOCKS_H - CH;
  const lh = 25.5, row = 10;
  const g = {
    cursor: cursorAt(scrollTop, row, lh), stage: stage(),
    scrollTop, scrollHeight: BLOCKS_H + 792, clientHeight: CH,
  };
  const nudge = cursorNudge(g.stage, g.cursor);
  assert.ok(nudge > 0, "旧落点上光标在视口下方，需要往下补");
  // 补完的落点必须是「光标底贴视口底」（图一的取景：卡尾 + 提示符在屏上）
  const after = scrollTop + nudge;
  assert.equal(Math.round(after), Math.round(BLOCKS_H + row * lh + lh - CH));
  const c = cursorAt(after, row, lh);
  assert.ok(Math.abs(c.bottom - STAGE_BOTTOM) < 1, "补完后光标底贴视口底");
  assert.ok(after > scrollTop, "落点在旧落点之下：活动终端回到视口里");
});

test("继续下滚进空白：光标滚出视口上方 → 不跟", () => {
  const scrollTop = BLOCKS_H + 300;          // 已越过提示符行
  const g = {
    cursor: cursorAt(scrollTop, 10), stage: stage(),
    scrollTop, scrollHeight: BLOCKS_H + 792, clientHeight: CH,
  };
  assert.equal(atStreamTail(g), false);
});

test("上翻历史：光标落到视口下方很远 → 不跟", () => {
  const scrollTop = BLOCKS_H - 2000;
  const g = {
    cursor: cursorAt(scrollTop, 10), stage: stage(),
    scrollTop, scrollHeight: BLOCKS_H + 792, clientHeight: CH,
  };
  assert.equal(atStreamTail(g), false);
});

test("补滚动稳态：光标底贴视口底 → 仍在流底", () => {
  const lh = 25.5, row = 10;
  const scrollTop = BLOCKS_H + row * lh + lh - CH;   // 光标底 = 视口底
  const g = {
    cursor: cursorAt(scrollTop, row, lh), stage: stage(),
    scrollTop, scrollHeight: BLOCKS_H + 792, clientHeight: CH,
  };
  assert.equal(cursorNudge(g.stage, g.cursor), 0);
  assert.equal(atStreamTail(g), true);
});

test("一往上翻就停住：光标离开视口即判「翻走」", () => {
  const lh = 25.5, row = 10;
  const base = BLOCKS_H + row * lh + lh - CH;   // 光标底贴视口底
  const mk = (delta) => {
    const scrollTop = base + delta;
    return {
      cursor: cursorAt(scrollTop, row, lh), stage: stage(),
      scrollTop, scrollHeight: BLOCKS_H + 792, clientHeight: CH,
    };
  };
  // 光标是一整行（约 25px）：翻走不足一行时仍算看着活尾巴
  assert.equal(atStreamTail(mk(-20)), true, "上翻 20px 光标仍有一截在视口里");
  assert.equal(atStreamTail(mk(-40)), false, "上翻 40px 光标整行滚出 → 停跟");
  assert.equal(atStreamTail(mk(40)), true, "下翻 40px 光标仍在视口里");
  assert.equal(atStreamTail(mk(-200)), false, "上翻 200px = 翻走，停跟");
});

test("cursorNudge：光标在视口下方补正值、上方补负值、在内为 0", () => {
  const s = { top: 100, bottom: 900 };
  assert.equal(cursorNudge(s, { top: 880, bottom: 905, height: 25 }), 5);
  assert.equal(cursorNudge(s, { top: 60, bottom: 85, height: 25 }), -40);
  assert.equal(cursorNudge(s, { top: 400, bottom: 425, height: 25 }), 0);
});

test("光标不可量（alt 屏/未渲染）：退回贴内容底判定", () => {
  const g = {
    cursor: null, stage: stage(),
    scrollTop: BLOCKS_H + 792 - CH, scrollHeight: BLOCKS_H + 792, clientHeight: CH,
  };
  assert.equal(atStreamTail(g), true, "贴底");
  assert.equal(atStreamTail({ ...g, scrollTop: g.scrollTop - 500 }), false, "离底远");
  // height=0 的光标矩形同样走兜底
  assert.equal(atStreamTail({
    ...g, cursor: { top: 0, bottom: 0, height: 0 },
    scrollTop: g.scrollTop - 500,
  }), false);
});
