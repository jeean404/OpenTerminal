// 决策放行次序回归（真机「审批卡只剩两行」根因之二）：worker 一收到 decision
// 就把命令注入 PTY，输出随即从审批卡底下流走——预留区被真实输出断开即永久
// 盖帽，卡再长高只能截断。所以放行前必须先给这张卡结账垫高（此刻 shell 阻塞
// 等审批、字节静默，是最后一块垫得进去的窗口）；但结账卡住不许拖死审批，
// 600ms 兜底放行。
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

function makeSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._padFused = false;
  s._slots = new Map();
  s.seq = [];
  s.sent = [];
  s.sendJson = msg => { s.sent.push(msg); s.seq.push("send"); };
  return s;
}

const tick = () => new Promise(r => setTimeout(r, 0));
const DEC = {type: "approve"};

test("先结账再放行：decision 必须在 _settleCard 之后发出", async () => {
  const s = makeSession();
  const slot = {id: 3, marker: {line: 13, onDispose() {}}};
  s._slots.set(3, slot);
  s._settleCard = async got => {
    assert.strictEqual(got, slot, "结账的应是这张审批卡");
    s.seq.push("settle");
    await tick();
  };
  s._releaseDecision(DEC, 3);
  assert.deepStrictEqual(s.sent, [], "结账未完成不得放行（输出会盖帽预留区）");
  await tick(); await tick();
  assert.deepStrictEqual(s.seq, ["settle", "send"], "次序：结账 → 放行");
  assert.deepStrictEqual(s.sent, [{type: "decision", decision: DEC}]);
});

test("没有对应卡/已熔断：立即放行，不等结账", async () => {
  const s = makeSession();
  let settled = 0;
  s._settleCard = () => { settled++; return Promise.resolve(); };
  s._releaseDecision(DEC, 99);          // 卡号对不上（island 自建卡）
  assert.deepStrictEqual(s.sent, [{type: "decision", decision: DEC}]);
  s.sent.length = 0;
  s._slots.set(4, {id: 4, marker: {line: 5, onDispose() {}}});
  s._padFused = true;                    // 熔断：垫不进也就不必等
  s._releaseDecision(DEC, 4);
  assert.deepStrictEqual(s.sent, [{type: "decision", decision: DEC}]);
  assert.strictEqual(settled, 0, "两种情况都不该走结账");
});

test("结账卡住也要放行：600ms 兜底（审批响应优先于占位美观）", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const s = makeSession();
  s._slots.set(5, {id: 5, marker: {line: 7, onDispose() {}}});
  s._settleCard = () => new Promise(() => {});   // pad 永不落地
  s._releaseDecision(DEC, 5);
  assert.deepStrictEqual(s.sent, [], "兜底前不放行");
  await t.mock.timers.tick(599);
  assert.deepStrictEqual(s.sent, [], "599ms 仍未到兜底");
  await t.mock.timers.tick(1);
  assert.deepStrictEqual(s.sent, [{type: "decision", decision: DEC}],
    "600ms 到点必须放行，不许把审批拖死");
});

test("结账与兜底同时到位只发一次 decision（不得重复放行）", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const s = makeSession();
  s._slots.set(6, {id: 6, marker: {line: 7, onDispose() {}}});
  let release;
  s._settleCard = () => new Promise(r => { release = r; });
  s._releaseDecision(DEC, 6);
  await t.mock.timers.tick(600);      // 兜底先发
  release();                          // 结账随后完成
  // 计时器已被 mock：冲微任务只能用 tick(0)（真 setTimeout 不再触发）
  await t.mock.timers.tick(0);
  await t.mock.timers.tick(0);
  assert.strictEqual(s.sent.length, 1, "decision 只能发一次");
});
