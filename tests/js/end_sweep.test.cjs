// 收束不变量回归（用户诉求 2026-10-09：「任何卡片都不应该中断或者结束后
// 出现中间状态，显示一半。要么不显示，要么显示完整」）。
// interrupt（Ctrl+C/⏹）收束：流式未完毕的卡整卡移除（store 撤内容 + onDrop
// 丢槽），活流卡不做失败定格；任何收束：挂载链落定后逐槽结账，垫不满的
// （盖帽/夹紧/pendingMount）整卡丢弃。审批卡豁免——按钮行底线夹紧是功能。
// 这里把 store/pad/装饰重机械打桩，只验 _onTaskFail/_onFinal/_endSweep 的
// 编排与「半截卡丢弃、完整卡保留」的收束判定。
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
    "requestAnimationFrame",
    src + "\n;return Session;");
  return factory(
    {addEventListener() {}}, fakeDoc,
    {getItem: () => null, setItem() {}, removeItem() {}},
    () => new Promise(() => {}),
    {now: () => 0},
    s => s,
    cb => setTimeout(cb, 0));
}

const tick = () => new Promise(r => setTimeout(r, 0));

function makeSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._slots = new Map();
  s._cardSeq = 0;
  s._taskActive = true;
  s._taskCardId = null;
  s._cardReady = Promise.resolve();
  s._mountQ = Promise.resolve();
  s._lastByteAt = 0;
  s._cardsText = new Map();
  s.events = [];   // 假 feed.handle 收到的事件流
  s.settled = [];  // 结账调用记录
  s.revealed = [];
  s._ensureFeed = () => Promise.resolve({
    handle: evt => s.events.push(evt),
    mount() {}, unmount() {}, destroy() {},
  });
  s._settleCard = slot => { s.settled.push(slot.id); return Promise.resolve(); };
  s._revealSlot = slot => { s.revealed.push(slot.id); slot.revealed = true; };
  s._scheduleReanchor = () => {};
  s._scheduleHeal = () => {};
  s._setStopVisible = () => {};
  s._startTimer = () => {};
  s._endTimer = () => {};
  s._refreshThink = () => {};
  s.setStatus = () => {};
  return s;
}

// 造布局槽：full=已垫满未钉死；half=盖帽夹紧；pending=从未上屏
function addSlot(s, id, shape, kind = "phase") {
  const base = {
    id, marker: {dispose() {}}, kind,
    mounted: true, pendingMount: false, revealed: true,
    pinnedRows: null, clamped: false, reserved: 5, rows: 5,
    reanchorT: null, ro: null, decoration: null,
  };
  const slot = Object.assign(base, shape);
  s._slots.set(id, slot);
  return slot;
}

const kinds = s => s.events.map(e => e.kind);

test("interrupt 收束：活流卡不定格失败，扫尾丢半截、留完整、豁免审批卡", async () => {
  const s = makeSession();
  const full = addSlot(s, 1, {});
  const half = addSlot(s, 2, {pinnedRows: 1, clamped: true, reserved: 1, rows: 3});
  const pend = addSlot(s, 3, {mounted: false, pendingMount: true, reserved: 0, rows: 2});
  const ap = addSlot(s, 4, {pinnedRows: 2, clamped: true, reserved: 2, rows: 6}, "approval");
  s._taskCardId = 1;
  s._onTaskFail("interrupt", "已停止");
  await s._sweepQ; await tick();
  assert.ok(kinds(s).includes("task_fail"), "store 应收到 task_fail");
  assert.strictEqual(s.events.find(e => e.kind === "task_fail").reason, "interrupt");
  assert.ok(kinds(s).includes("sweep"), "收束应过 sweep 扫尾");
  const drop = s.events.find(e => e.kind === "drop");
  assert.deepStrictEqual([...drop.ids].sort(), [2, 3], "半截卡与从未上屏的卡应整卡丢弃");
  assert.ok(s._slots.has(1), "完整卡保留");
  assert.ok(s._slots.has(4), "审批卡豁免（按钮行底线夹紧是功能）");
  assert.ok(!s._slots.has(2) && !s._slots.has(3));
  assert.strictEqual(full.frozen, undefined, "interrupt 不做失败定格（整卡移除语义）");
  assert.deepStrictEqual(s.settled.sort(), [1, 2, 3],
    "扫尾给每个非审批卡一次结账机会（垫得进去的补齐）");
});

test("error/limit 收束：活卡仍定格失败态（既有语义不变），扫尾照丢半截", async () => {
  const s = makeSession();
  const live = addSlot(s, 10, {});
  const half = addSlot(s, 11, {pinnedRows: 1, clamped: true, reserved: 1, rows: 4});
  s._taskCardId = 10;
  s._onTaskFail("limit", "预算用尽");
  await s._sweepQ; await tick();
  assert.strictEqual(live.frozen, true, "非 interrupt 收束仍定格失败态");
  assert.ok(!s._slots.has(11), "半截卡照丢");
  assert.ok(s._slots.has(10), "定格卡完整显示则保留");
});

test("final 收束：扫尾等总结挂载落定（半截总结不许挂着）", async () => {
  const s = makeSession();
  let mountDone = false;
  s._mountSummary = () => new Promise(r => setTimeout(() => {
    mountDone = true;
    addSlot(s, 20, {pinnedRows: 1, clamped: true, reserved: 1, rows: 5}, "summary");
    r();
  }, 5));
  s._onFinal("# 总结");
  await s._sweepQ; await tick();
  assert.ok(mountDone, "扫尾必须等总结卡挂载完");
  assert.ok(!s._slots.has(20), "垫不满的总结卡也整卡消失（要么不显示要么显示完整）");
  const drop = s.events.find(e => e.kind === "drop");
  assert.deepStrictEqual(drop.ids, [20]);
});

test("收束后迟到的工具宣告不再挂卡（半截卡只减不增）", async () => {
  const s = makeSession();
  let mounts = 0;
  s._mountCard = async id => { mounts++; addSlot(s, id, {}); return s._slots.get(id); };
  s._taskClosed = true;
  s._onAiTool({phase: "start", id: 9, name: "execute", args: "ls"});
  await s._cardReady; await tick();
  assert.strictEqual(mounts, 0, "任务收束后 tool_start 不再挂卡");
  assert.ok(!kinds(s).includes("tool_start"));
});
