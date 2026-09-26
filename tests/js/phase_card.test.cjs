// 阶段卡编排回归（P1-4）：ai_collapse 定格当前卡后，同一任务里再来的 token
// 必须新开一张卡（task_start 先于 ai_token 落地），否则 token 被丢——旧实现
// 定格后 _taskCardId 归空却不再开卡，_ensureFeed().handle(ai_token) 找不到活卡
// 直接 return，阶段二文本凭空消失。这里把 _mountCard/_ensureFeed 等重机械打桩，
// 只验 _openPhaseCard/_onAiToken/_onAiCollapse 的编排与事件次序。
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
  s._cardSeq = 0;
  s._taskActive = false;
  s._taskCardId = null;
  s._cardReady = Promise.resolve();
  s._lastByteAt = 0;
  s.events = [];   // 假 feed.handle 收到的事件流
  // 打桩重机械：_ensureFeed 返回记录型 feed；_mountCard 造个假 slot 入账
  s._ensureFeed = () => Promise.resolve({
    handle: evt => s.events.push(evt),
    mount() {}, unmount() {}, destroy() {},
  });
  s._mountCard = async cardId => {
    const slot = {id: cardId, marker: {}, reserved: 0, need: 2, rows: 2};
    s._slots.set(cardId, slot);
    return slot;
  };
  s._trackText = () => {};
  s._scheduleReanchor = () => {};
  // 定格结账（rAF + 扣流 + pad）属重机械，这里只记调用
  s.settled = [];
  s._settleCard = slot => { s.settled.push(slot.id); return Promise.resolve(); };
  s._scheduleHeal = () => {};
  s._setStopVisible = () => {};
  s._startTimer = () => {};
  s._endTimer = () => {};
  s._fitNeed = () => {};
  return s;
}

const kinds = s => s.events.map(e => e.kind);

test("任务启动：task_start 先于 ai_token（_cardReady 链串行化，spec §3.1）", async () => {
  const s = makeSession();
  s._onTaskStart();
  await s._cardReady; await tick();
  s._onAiToken("你好");
  await s._cardReady; await tick();
  assert.deepStrictEqual(kinds(s).slice(0, 2), ["task_start", "ai_token"]);
  assert.strictEqual(s.events[1].text, "你好");
});

test("P1-4：ai_collapse 定格后再来 token → 先开新卡（task_start）再落 token，不丢", async () => {
  const s = makeSession();
  s._onTaskStart();
  await s._cardReady; await tick();
  s._onAiToken("阶段一");
  await s._cardReady; await tick();
  // 阶段边界：定格当前卡，_taskCardId 归空但任务仍活
  s._onAiCollapse();
  await tick();
  assert.strictEqual(s._taskCardId, null, "collapse 后 taskCardId 应清空");
  // 定格即结账：卡还在流底时把最终高度垫满，否则下层卡一锚定就永久截断
  assert.deepStrictEqual(s.settled, [s.events[0].id], "定格的卡应立即结账补差");
  const seqBefore = s._cardSeq;
  // 定格后同一任务里的新 token：必须开新卡承接
  s._onAiToken("阶段二");
  await s._cardReady; await tick();
  assert.ok(s._cardSeq > seqBefore, "应新开一张卡（_cardSeq 递增）");
  assert.deepStrictEqual(kinds(s),
    ["task_start", "ai_token", "ai_collapse", "task_start", "ai_token"],
    "次序：起始卡→token→定格→新卡→token");
  assert.strictEqual(s.events[4].text, "阶段二", "阶段二 token 不得丢失");
  assert.notStrictEqual(s.events[0].id, s.events[3].id, "新卡 id 与旧卡不同");
});

test("P1-4：ai_think 同样在定格后开新卡承接思考文本", async () => {
  const s = makeSession();
  s._onTaskStart();
  await s._cardReady; await tick();
  s._onAiCollapse();
  await tick();
  s._onAiThink("思考中");
  await s._cardReady; await tick();
  assert.deepStrictEqual(kinds(s),
    ["task_start", "ai_collapse", "task_start", "ai_think"]);
  assert.strictEqual(s.events[3].text, "思考中");
});
