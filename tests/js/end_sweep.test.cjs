// 收束不变量回归（Phase 4 后语义）。
//
// 演进：用户诉求 2026-10-09「要么不显示，要么显示完整」曾落地为「垫不满就
// 整卡丢弃」——但贴纸拆了、pad 空行（append-only）回收不了，原位留洞（真机
// 图二「消失留白」）。Phase 4 定格一发入魂后，卡**内容完整才挂载**，「半截
// 尸块」在内容层已不可能；布局层收束改为「保留夹紧」：
//   ① store 扫迟到补挂的未完毕内容卡（sweep——中断/异常残留，内容级）；
//   ② 逐槽结账一次给「垫得进去」的卡补齐机会；
//   ③ 仍不完整的卡**保留夹紧**（钉死到已垫高度 + 揭示放出），不丢弃、不留洞；
//   ④ 仅「从未挂载成功」的槽（无 host、没写过 pad 行）走 _fallbackPlain 纯文本
//      降级后拆除——不占预留行，拆了也不留洞，内容不丢。
// 审批卡豁免——按钮行底线夹紧是功能（可点性优先）。
// 这里把 store/pad/装饰重机械打桩，只验 _onTaskFail/_onFinal/_endSweep 的
// 编排与收束判定。
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
  s._toolCards = new Map();   // Phase 2：ai_tool id → 卡 id 映射（构造器字段）
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
  s.fallbacks = [];   // _fallbackPlain 降级记录
  s.clampedIds = [];
  s._ensureFeed = () => Promise.resolve({
    handle: evt => s.events.push(evt),
    mount() {}, unmount() {}, destroy() {},
  });
  s._settleCard = slot => { s.settled.push(slot.id); return Promise.resolve(); };
  s._revealSlot = slot => { s.revealed.push(slot.id); slot.revealed = true; };
  s._clampCard = slot => { s.clampedIds.push(slot.id); slot.clamped = true; };
  s._applyDecoration = () => {};
  s._fallbackPlain = slot => { s.fallbacks.push(slot.id); };
  s._scheduleDrift = () => {};
  s._scheduleHeal = () => {};
  s._setStopVisible = () => {};
  s._startTimer = () => {};
  s._endTimer = () => {};
  s._refreshThink = () => {};
  s.setStatus = () => {};
  s._progress = {chars: 0, tokensIn: 0, tokensOut: 0};
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

test("interrupt 收束：未完毕内容卡整卡移除（store sweep），布局层保留夹紧、降级 pending", async () => {
  const s = makeSession();
  const full = addSlot(s, 1, {});
  const half = addSlot(s, 2, {pinnedRows: 1, clamped: true, reserved: 1, rows: 3,
                              revealed: false});
  const pend = addSlot(s, 3, {mounted: false, pendingMount: true, reserved: 0, rows: 2});
  const ap = addSlot(s, 4, {pinnedRows: 2, clamped: true, reserved: 2, rows: 6}, "approval");
  s._taskCardId = 1;
  s._onTaskFail("interrupt", "已停止");
  await s._sweepQ; await tick();
  assert.ok(kinds(s).includes("task_fail"), "store 应收到 task_fail");
  assert.strictEqual(s.events.find(e => e.kind === "task_fail").reason, "interrupt");
  assert.ok(kinds(s).includes("sweep"), "收束应过 sweep 扫尾");
  // Phase 4：垫不满的卡**保留夹紧**，不再整卡丢弃（拆贴纸留洞＝真机图二）
  assert.ok(s._slots.has(2), "垫不满的卡保留（夹紧钉死），不丢弃");
  assert.ok(s._slots.has(1), "完整卡保留");
  assert.ok(s._slots.has(4), "审批卡豁免（按钮行底线夹紧是功能）");
  assert.ok(!s._slots.has(3), "从未上屏的槽拆除（没占预留行，不留洞）");
  const drop = s.events.find(e => e.kind === "drop");
  assert.deepStrictEqual(drop && [...drop.ids], [3],
    "drop 只发给从未挂载成功的槽");
  assert.deepStrictEqual(s.fallbacks, [3],
    "pendingMount 槽走纯文本降级，内容不丢");
  assert.ok(s.revealed.includes(2), "保留的夹紧卡放出（不留隐形卡）");
  assert.strictEqual(full.frozen, undefined, "interrupt 不做失败定格（整卡移除语义）");
  assert.deepStrictEqual([...s.settled].sort(), [1, 2, 3],
    "扫尾给每个非审批卡一次结账机会（垫得进去的补齐）");
});

test("error/limit 收束：失败态由 store failed 承担，垫不满的卡保留夹紧", async () => {
  const s = makeSession();
  const live = addSlot(s, 10, {});
  const half = addSlot(s, 11, {pinnedRows: 1, clamped: true, reserved: 1, rows: 4});
  s._onTaskFail("limit", "预算用尽");
  await s._sweepQ; await tick();
  assert.ok(kinds(s).includes("task_fail"), "store 应收到 task_fail");
  assert.ok(s._slots.has(11), "垫不满的卡保留（不丢弃、不留洞）");
  assert.ok(s.clampedIds.includes(11), "夹紧钉死到已垫高度");
  assert.ok(s._slots.has(10), "完整卡保留（出生即冻结，无事后定格语义）");
});

test("final 收束：扫尾等总结挂载落定，垫不满的总结卡保留夹紧", async () => {
  const s = makeSession();
  let mountDone = false;
  s._mountSummary = () => new Promise(r => setTimeout(() => {
    mountDone = true;
    addSlot(s, 20, {pinnedRows: 1, clamped: true, reserved: 1, rows: 5,
                    revealed: false}, "summary");
    r();
  }, 5));
  s._onFinal("# 总结");
  await s._sweepQ; await tick();
  assert.ok(mountDone, "扫尾必须等总结卡挂载完");
  assert.ok(s._slots.has(20), "垫不满的总结卡保留夹紧（要么完整显示要么被裁，绝不消失留洞）");
  assert.ok(s.clampedIds.includes(20));
  assert.ok(s.revealed.includes(20), "收束不留隐形卡");
});

test("收束后迟到的工具宣告不再挂卡（残留只减不增）", async () => {
  const s = makeSession();
  let mounts = 0;
  s._mountCard = async id => { mounts++; addSlot(s, id, {}); return s._slots.get(id); };
  s._taskClosed = true;
  s._onAiTool({phase: "start", id: 9, name: "execute", args: "ls"});
  await s._cardReady; await tick();
  assert.strictEqual(mounts, 0, "任务收束后 tool_start 不再挂卡");
  assert.ok(!kinds(s).includes("tool_start"));
});
