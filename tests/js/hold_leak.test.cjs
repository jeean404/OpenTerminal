// 扣流漏还 + 扣流窗无界 回归（真机 2026-10-11「总结卡渲染后打字不回显」）。
//
// 现象：总结卡渲染完毕后命令行卡顿几秒——打不进字，或打进去几秒后才回显。
// 真机仪表（tools/verify-web/diag-post-final-freeze.cjs）定位到两处：
//   ① 漏还：批量窗被 _settleCard/_discardSlot 取消/丢弃时，其记账的扣流未
//      同步归还 → _holdActive() 永久为真，PTY 字节只进 _holdBuf 不落 xterm；
//      且字节不进 _writeTerm 就不唤醒 _scheduleHeal，自愈也救不回（实测
//      hold depth 卡在 1，之后回显全部 TIMEOUT）。
//   ② 无界：批量窗原来是防抖（每次长高都 clearTimeout 重排），连续长高期间
//      永远不触发——实测 3.5s 内叠到 43 层 card-grow 未归还，整段回显被扣住。
//
// Phase 4 起长高机械已拆除（_scheduleReanchor / growHolds / _releaseGrow 全删，
// 见 app.js _scheduleDrift）——但「扣流 depth 归零」不变量本身是真机
// 「打字不回显」事故的守卫，**不得随机械一起删**。本文件把它重写到新路径上：
//   _scheduleDrift（高度漂移批量窗 + card-drift 扣流）/ _settleCard / _discardSlot。
// 新纪律：批量窗 pending 期**不扣流**（只有真正 pad 发送的 card-drift 窗扣），
// 所以「无界叠层」在结构上不可能再现；漏还配平仍靠本文件守死。
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
    "blankRun", "rowsForPx", "padGap",
    src + "\n;return Session;");
  const ledger = require(path.join(__dirname, "..", "..", "src", "openterminal",
    "web", "frontend", "static", "pad_ledger.js"));
  return factory(
    {addEventListener() {}}, fakeDoc,
    {getItem: () => null, setItem() {}, removeItem() {}},
    () => new Promise(() => {}),
    {now: () => Date.now()},
    s => s,
    ledger.blankRun, ledger.rowsForPx, ledger.padGap);
}

function makeFakeEl(height) {
  const el = {
    style: {},
    className: "xterm-decoration",
    isConnected: true,
    scrollHeight: height,
    firstElementChild: null,
    querySelector: () => null,
    classList: {
      add(c) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        set.add(c);
        el.className = [...set].join(" ");
      },
    },
  };
  return el;
}

// 只够 _scheduleDrift/_settleCard/_discardSlot 跑的会话。
// 关键：_holdBytes/_releaseBytes 用**真**实现——被测的就是记账是否配平，
// 打桩就等于把断言对象换掉了。
function makeDriftSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._slots = new Map();
  s._toolCards = new Map();   // Phase 2：ai_tool id → 卡 id 映射（构造器字段）
  s._lastByteAt = 0;
  s._padFused = false;
  s._holdDepth = 0;
  s._holdBuf = [];
  s._holdTags = [];
  s._holdSince = 0;

  const marker = {line: 3, onDispose() {}, dispose() {}};
  const lines = new Array(24).fill("");   // 全空白缓冲：预留区数得满、不盖帽
  s.term = {
    rows: 24, cols: 80, element: null,
    registerMarker: () => marker,
    registerDecoration: () => ({onRender() {}, dispose() {}}),
    refresh() {},
    buffer: {active: {
      baseY: 0, cursorY: 20, viewportY: 0,
      getLine: i => ({translateToString: () => lines[i] || ""}),
    }},
  };
  s.term.buffer.normal = s.term.buffer.active;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = cb => setTimeout(() => cb(), 0);

  s._settle = async () => {};
  s._ensureFeed = () => Promise.resolve(null);
  s._drainHeld = async () => {};
  s._ensurePad = async () => {};
  s._reanchor = () => {};
  s._followBottom = () => {};
  s._applyDecoration = () => {};
  s._styleHost = () => {};
  s._refreshThink = () => {};
  s._revealSlot = () => {};

  // 一张「已露出、内容高 6 行 > 预留 0」的卡：触发高度漂移路径
  const host = makeFakeEl(90);   // 90px / 15px 行高 = 6 行
  const slot = {
    id: "c1", marker, decoration: null, host,
    reserved: 0, need: 2, rows: 2, clamped: false, ro: null,
    reanchorT: null, mounted: true, pendingMount: false,
    pinnedRows: null, forceReapply: false,
    kind: "phase", revealed: true, frozen: true, frozenAt: 0,
    padOut: 0, padP: null,
  };
  s._slots.set("c1", slot);
  return {s, slot};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("漂移批量窗 pending 期不扣流（打字回显不得被批量窗扣住）", async () => {
  const {s, slot} = makeDriftSession();
  s._scheduleDrift(slot);
  assert.ok(slot.reanchorT, "应有在途批量窗");
  // 旧长高机械在「感知长高」当刻就扣流、150ms 后才放行——连续长高期回显
  // 全程被扣住。新纪律：批量窗只负责节流，扣流只在真正 pad 发送的窗口里。
  assert.strictEqual(s._holdDepth, 0,
    "批量窗 pending 期不得扣流——扣了就是「总结卡后打不进字」的体感来源");
  await sleep(250);   // 让批量窗落地
  assert.strictEqual(s._holdDepth, 0);
});

test("高度漂移批量窗落地后，扣流必须归零（holdDepth 回 0）", async () => {
  const {s, slot} = makeDriftSession();
  s._scheduleDrift(slot);
  await sleep(250);
  assert.strictEqual(s._holdDepth, 0,
    "扣流必须配平——漏一笔就让 _holdActive() 永久为真，回显全被扣住");
  assert.strictEqual(s._holdBuf.length, 0);
});

test("定格结账取消批量窗后不得残留扣流", async () => {
  const {s, slot} = makeDriftSession();
  s._scheduleDrift(slot);
  // 真机路径：下层卡挂载前的 _settleCard 接管结账 → clearTimeout 批量窗
  s._settleCard(slot);
  await slot.settling;
  await sleep(250);

  assert.strictEqual(s._holdDepth, 0,
    "扣流必须配平——漏一笔就让 _holdActive() 永久为真，回显全被扣住");
  assert.strictEqual(s._holdBuf.length, 0);
});

test("丢槽（收束扫尾/同 id 顶替）取消批量窗后不得残留扣流", async () => {
  const {s, slot} = makeDriftSession();
  s._scheduleDrift(slot);
  s._discardSlot(slot);
  await sleep(250);
  assert.strictEqual(s._holdDepth, 0, "丢槽不得漏还扣流");
});

test("批量窗在途 pad 期间丢槽，扣流也必须归零（finally 配平）", async () => {
  const {s, slot} = makeDriftSession();
  s._ensurePad = () => sleep(80);   // pad 往返慢：扣流窗被拉长
  s._scheduleDrift(slot);
  await sleep(160);   // 批量窗已触发、card-drift 扣流窗进行中
  assert.strictEqual(s._holdDepth, 1, "pad 发送窗应有一层扣流");
  s._discardSlot(slot);
  await sleep(150);   // 在途 pad 落地，finally 归还
  assert.strictEqual(s._holdDepth, 0, "在途扣流窗收尾必须归还（finally 配平）");
});

test("持续漂移连发下扣流不得无界累积（旧 43 层叠层回归）", async () => {
  const {s, slot} = makeDriftSession();
  let maxDepth = 0;
  const origHold = s._holdBytes.bind(s);
  s._holdBytes = tag => {
    origHold(tag);
    maxDepth = Math.max(maxDepth, s._holdDepth);
  };
  // 模拟 RO 连发：每 25ms 一次，持续 750ms
  for (let t = 0; t < 750; t += 25) {
    s._scheduleDrift(slot);
    await sleep(25);
  }
  await sleep(300);   // 收尾，让最后一窗落地

  assert.ok(maxDepth <= 2,
    `扣流深度不得无界累积（实测峰值 ${maxDepth}）——` +
    "旧防抖批量窗叠过 43 层，整个流式期回显全被扣住");
  assert.strictEqual(s._holdDepth, 0,
    `批量窗结束后不得残留扣流（实测深度 ${s._holdDepth}）`);
});
