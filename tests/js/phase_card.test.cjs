// 阶段卡编排回归（Phase 1「定格一发入魂」）：ai_result 一次性成卡（handle
// 先于 mount——量高时内容已完整），空段不成卡，final/task_end 幂等收束。
// 把 _mountCard/_ensureFeed 等重机械打桩，只验 _onAiResult/_onFinal/
// _onTaskEnd/_onTaskFail 的编排与事件次序。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "app.js");

function loadSessionClass() {
  const src = fs.readFileSync(APP, "utf8");
  const fakeDoc = {
    createElement: () => ({style: {}, classList: {add() {}, remove() {}}}),
    addEventListener() {},
    getElementById: () => ({onclick: null, addEventListener() {}, value: ""}),
    querySelectorAll: () => [],
    head: {appendChild() {}},
    body: {classList: {toggle() {}}},
  };
  const factory = new Function(
    "window", "document", "sessionStorage", "fetch", "performance", "mdLite",
    src + "\n;return Session;");
  return factory(
    {addEventListener() {}}, fakeDoc,
    {getItem: () => null, setItem() {}, removeItem() {}},
    () => new Promise(() => {}),
    {now: () => 0},
    s => s);
}

// setTimeout(0) 宏任务：把此前所有（含嵌套 .then）微任务一次性冲净
const tick = () => new Promise(r => setTimeout(r, 0));

function makeSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._slots = new Map();
  s._toolCards = new Map();   // Phase 2：ai_tool id → 卡 id 映射（构造器字段）
  s._cardsText = new Map();
  s._cardSeq = 0;
  s._taskActive = false;
  s._taskClosed = false;
  s._cardReady = Promise.resolve();
  s._lastSummaryMd = null;
  s._lastByteAt = 0;
  s.log = [];   // 统一次序账：handle 与 mount 都记，验「handle 先于 mount」
  s.events = [];   // 假 feed.handle 收到的事件流
  // 打桩重机械：_ensureFeed 返回记录型 feed；_mountCard 造个假 slot 入账
  s._ensureFeed = () => Promise.resolve({
    handle: evt => { s.log.push("handle:" + evt.kind); s.events.push(evt); },
    mount() {}, unmount() {}, destroy() {},
  });
  s._mountCard = async (cardId, kind) => {
    s.log.push("mount:" + cardId);
    const slot = {id: cardId, marker: {}, reserved: 0, need: 2, rows: 2, kind};
    s._slots.set(cardId, slot);
    return slot;
  };
  s._scheduleReanchor = () => {};
  s._scheduleHeal = () => {};
  s._endSweepSoon = () => {};
  s._setStopVisible = () => {};
  s._startTimer = () => {};
  s._endTimer = () => {};
  s._refreshThink = () => {};
  s._followBottom = () => {};
  s._fitNeed = () => {};
  return s;
}

const kinds = s => s.events.map(e => e.kind);

test("ai_result 一次性成卡：handle 先于 mount（量高时内容已完整）", async () => {
  const s = makeSession();
  s._onTaskStart();
  await s._cardReady; await tick();
  assert.deepStrictEqual(kinds(s), ["task_start"], "task_start 只做代数/状态同步，不预开流式分析卡");
  s._onAiResult({text: "你好", think: "推理中"});
  await s._cardReady; await tick();
  assert.deepStrictEqual(kinds(s), ["task_start", "ai_result"]);
  assert.strictEqual(s.events[1].text, "你好");
  assert.strictEqual(s.events[1].reason, "推理中");
  assert.deepStrictEqual(s.log, ["handle:task_start", "handle:ai_result", "mount:1"],
    "先 handle 入 store 再挂卡——出生即完整，挂载后高度不再变化");
});

test("ai_result 空段不成卡：handle/mount 都不触发", async () => {
  const s = makeSession();
  s._onAiResult({text: "", think: ""});
  await s._cardReady; await tick();
  assert.deepStrictEqual(kinds(s), []);
  assert.strictEqual(s._cardSeq, 0, "空段不占 _cardSeq");
});

test("多段多卡：每段独立成卡、id 不同、failed 透传", async () => {
  const s = makeSession();
  s._onTaskStart();
  await s._cardReady; await tick();
  s._onAiResult({text: "阶段一"});
  s._onAiResult({text: "阶段二", think: "二", failed: true});
  await s._cardReady; await tick();
  assert.deepStrictEqual(kinds(s), ["task_start", "ai_result", "ai_result"]);
  assert.notStrictEqual(s.events[1].id, s.events[2].id, "两段两张卡");
  assert.strictEqual(s.events[2].failed, true);
  assert.deepStrictEqual(s.log, ["handle:task_start", "handle:ai_result", "mount:1",
    "handle:ai_result", "mount:2"], "两段挂载串行（_cardReady 链）");
});

test("final 一次性挂总结卡并收束（teardown 幂等）；task_end 复用收束", async () => {
  const s = makeSession();
  s._onTaskStart();
  await s._cardReady; await tick();
  s._onAiResult({text: "分析"});
  await s._cardReady; await tick();
  s._onFinal("# 总结");
  await s._cardReady; await tick();
  assert.deepStrictEqual(kinds(s), ["task_start", "ai_result", "ai_card"],
    "final 只出一张总结卡（ai_card），无换装/裁尾事件");
  assert.strictEqual(s._taskActive, false);
  assert.strictEqual(s._taskClosed, true);
  // task_end 幂等：不再出事件、不再挂卡
  const seq = s._cardSeq;
  s._onTaskEnd();
  await s._cardReady; await tick();
  assert.strictEqual(s._cardSeq, seq, "task_end 不新开卡");
  assert.deepStrictEqual(kinds(s), ["task_start", "ai_result", "ai_card"]);
});

test("final 同文去重：ai_card 与 final 双发只挂一张总结卡", async () => {
  const s = makeSession();
  s._onAiCard("# 总结");
  await s._cardReady; await tick();
  s._onFinal("# 总结");
  await s._cardReady; await tick();
  assert.deepStrictEqual(kinds(s), ["ai_card"], "同文去重（_lastSummaryMd）");
});

test("task_fail 收束：task_fail 事件入 store，teardown 归位", async () => {
  const s = makeSession();
  s._onTaskStart();
  await s._cardReady; await tick();
  s._onAiResult({text: "半截", failed: true});
  await s._cardReady; await tick();
  s._onTaskFail("interrupt", "已中断");
  await tick();
  assert.deepStrictEqual(kinds(s), ["task_start", "ai_result", "task_fail"]);
  assert.strictEqual(s._taskActive, false);
  assert.strictEqual(s._taskClosed, true);
});
