// 宁藏不盖（spec §13.1 待办 B 落地）：流式 phase 卡 fund 之前（reserved ≥ rows）
// 整卡 visibility:hidden、思考徽标接班——出生 pad 往返窗口（真机实测 0.3~0.8s）
// 不再露出「只有一条头」的细条。用 visibility 而非 display：display 下无布局、
// _fitNeed 的 scrollHeight 恒 0、RO 静默，need 冻结在出生值，解锁瞬间 auto 高度
// 会盖住下方文本一轮批处理（破 coveredTextRows 硬线）。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "app.js");

// fakeDoc 带 getElementById 注册表：_refreshThink 往 #think-<tabId> 写 hidden，
// 徽标联动断言需要持久元素。
function loadSessionClass() {
  const src = fs.readFileSync(APP, "utf8");
  // app.js 里 blankRun/rowsForPx/padGap 是浏览器全局（pad_ledger.js 先载）；
  // 工厂作用域注入真实现——零空白盖帽守卫按缓冲真值判，缺注入会恒 0 误藏
  const ledger = require("../../src/openterminal/web/frontend/static/pad_ledger.js");
  const regs = {};
  const fakeDoc = {
    _regs: regs,
    createElement: () => ({style: {}, classList: {add() {}, remove() {}}}),
    addEventListener() {},
    getElementById: id => (regs[id] ||= {hidden: true, onclick: null,
                                         addEventListener() {}, value: ""}),
    querySelectorAll: () => [],
    head: {appendChild() {}},
    body: {classList: {toggle() {}}},
  };
  const factory = new Function(
    "window", "document", "sessionStorage", "fetch", "performance", "mdLite",
    "blankRun", "rowsForPx", "padGap",
    src + "\n;return Session;");
  const Session = factory(
    {addEventListener() {}}, fakeDoc,
    {getItem: () => null, setItem() {}, removeItem() {}},
    () => new Promise(() => {}),
    {now: () => 0},
    s => s,
    ledger.blankRun, ledger.rowsForPx, ledger.padGap);
  return {Session, regs};
}

function makeFakeEl() {
  const el = {
    style: {},
    className: "xterm-decoration",
    isConnected: true,
    querySelector: () => null,   // _clampCard/_fitNeed 查 .edopen 用
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

// 造会话：term 桩同 card_mount（marker 在 line5、buffer 主屏）；pad/量高全打桩，
// 由用例自己决定账目走向。
function makeSession({tabId = "t1", blank = true} = {}) {
  const {Session, regs} = loadSessionClass();
  const s = Object.create(Session.prototype);
  s.tabId = tabId;
  s._regs = regs;
  s._dead = false;
  s._padFused = false;
  s._slots = new Map();
  s._holdDepth = 0;
  s._holdBuf = [];
  s._lastByteAt = 0;
  s._taskActive = false;
  s._taskCardId = null;
  s._phaseLive = false;
  s._summaryShown = false;
  s._approvalOpen = false;
  const marker = {line: 5, onDispose() {}};
  s._onRenderCb = null;   // _applyDecoration 登记的 onRender
  s.term = {
    rows: 24, cols: 80,
    registerMarker: () => marker,
    registerDecoration: () => ({
      onRender: cb => { s._onRenderCb = cb; },
      dispose() {},
    }),
    // 模拟「重贴后强制刷新即渲染」：同步回调 onRender 交出新 host
    refresh() { if (s._onRenderCb) s._onRenderCb(makeFakeEl()); },
    buffer: {active: {baseY: 0, cursorY: 20, viewportY: 0,
                      // 默认空白主屏：零空白盖帽守卫（_blankSpan）按缓冲真值放行；
                      // blank:false 造非空白屏（span=0），供夹紧放出路径用例
                      getLine: () => ({translateToString: () => (blank ? "" : "x")})}},
  };
  s.term.buffer.normal = s.term.buffer.active;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = cb => setTimeout(() => cb(), 0);
  s._ensureFeed = () => Promise.resolve({handle() {}, mount() {}, unmount() {},
                                         destroy() {}});
  s._holdBytes = () => {};
  s._releaseBytes = () => {};
  s._fitNeed = () => {};
  s._ensurePad = async () => {};
  s._scheduleReanchor = () => {};
  s._scheduleHeal = () => {};
  return s;
}

// 造一个 fund 之前的 phase slot：kind/revealed/host 与 _mountCard 字面量一致
function makeSlot(s, id, over = {}) {
  const slot = {
    id, marker: {line: 5, onDispose() {}}, decoration: null,
    host: makeFakeEl(), reserved: 0, need: 3, rows: 2, clamped: false,
    pinnedRows: null, forceReapply: false, mounted: true,
    kind: "phase", revealed: false, frozen: false, frozenAt: 0,
    ...over,
  };
  s._slots.set(id, slot);
  return slot;
}

test("fund 之前 phase 卡隐藏（visibility:hidden），display 通道不动", () => {
  const s = makeSession();
  const slot = makeSlot(s, 1);
  s._fixHostVisibility(slot, slot.host);
  assert.strictEqual(slot.host.style.visibility, "hidden",
    "reserved(0) < rows(2) 的流式 phase 卡应整卡隐身");
  assert.strictEqual(slot.host.style.display, undefined,
    "display 留给 vendored xterm 自己写，两通道正交");
});

test("fund 之后放行：reserved ≥ rows → visibility 恢复，revealed 锁存不复隐", () => {
  const s = makeSession();
  const slot = makeSlot(s, 1);
  s._fixHostVisibility(slot, slot.host);
  assert.strictEqual(slot.host.style.visibility, "hidden");
  slot.reserved = 5;                          // pad 落地，fund 到位
  s._revealSlot(slot);
  s._fixHostVisibility(slot, slot.host);
  assert.strictEqual(slot.host.style.visibility, "visible");
  assert.strictEqual(slot.revealed, true);
  // 锁存：即使后来夹紧（reserved 回落）也不复隐——后续长高由夹紧钉死路径兜住
  slot.reserved = 0;
  s._fixHostVisibility(slot, slot.host);
  assert.strictEqual(slot.host.style.visibility, "visible",
    "revealed 锁存后不得复隐（复隐=闪烁）");
});

test("只有 phase 卡参与隐藏：summary/approval 出生即完整，永不隐身", () => {
  const s = makeSession();
  for (const kind of ["summary", "approval"]) {
    const slot = makeSlot(s, 1, {kind});
    assert.strictEqual(s._slotHidden(slot), false, `${kind} 卡不得隐藏`);
  }
  assert.strictEqual(s._slotHidden(makeSlot(s, 1)), true, "phase 卡 fund 前隐藏");
});

test("熔断（_padFused）豁免：fused 后 reserved 永不增长，隐藏=永久隐形", () => {
  const s = makeSession();
  s._padFused = true;
  assert.strictEqual(s._slotHidden(makeSlot(s, 1)), false);
});

test("_reanchor 盖帽分支：夹紧截断的同时放行（宁藏不盖只遮等 pad 的过渡期）", () => {
  const s = makeSession();
  const slot = makeSlot(s, 1, {rows: 4});
  s._fitNeed = () => {};
  s._blankSpan = () => 0;          // 下方被输出占住，空白 run 断
  s._capped = () => true;
  s._followBottom = () => {};
  s._reanchor(slot);
  assert.strictEqual(slot.clamped, true);
  assert.strictEqual(slot.pinnedRows, 1);
  assert.strictEqual(slot.revealed, true, "盖帽卡应立即放行为夹紧截断态");
  assert.strictEqual(slot.host.style.visibility, "visible");
});

test("_reanchor 未盖帽且未 fund：保持隐藏（真机细条期），徽标接班", () => {
  const s = makeSession();
  s._taskActive = true;
  s._taskCardId = 1;
  const slot = makeSlot(s, 1, {rows: 4});
  s._blankSpan = () => 0;
  s._capped = () => false;         // 等 pad：光标还在 marker 下方空白处
  s._followBottom = () => {};
  s._reanchor(slot);
  assert.strictEqual(slot.clamped, true);
  assert.strictEqual(slot.revealed, false, "等 pad 期间不得放行细条");
  assert.strictEqual(slot.host.style.visibility, "hidden");
  assert.strictEqual(s._regs["think-t1"].hidden, false,
    "卡隐藏时思考徽标应接班显示");
});

test("_reanchor fund 分支：reserved ≥ rows 解钉放行，任务条全程常显", () => {
  const s = makeSession();
  s._taskActive = true;
  s._taskCardId = 1;
  const slot = makeSlot(s, 1, {rows: 4, clamped: true, pinnedRows: 1});
  slot.host.style.visibility = "hidden";
  s._blankSpan = () => 6;          // pad 落地
  s._capped = () => false;
  s._followBottom = () => {};
  s._reanchor(slot);
  assert.strictEqual(slot.clamped, false);
  assert.strictEqual(slot.pinnedRows, null, "fund 后应解钉内容自撑");
  assert.strictEqual(slot.revealed, true);
  assert.strictEqual(slot.host.style.visibility, "visible");
  // 新语义：任务条（AI正在思考）任务全程常显，不再随卡上屏退场
  assert.strictEqual(s._regs["think-t1"].hidden, false, "任务未结束任务条常显");
});

test("_cardOnScreen 守卫：隐藏态挂载完成不算上屏（_phaseLive 不置位）", () => {
  const s = makeSession();
  s._taskActive = true;
  s._taskCardId = 1;
  const slot = makeSlot(s, 1);     // reserved 0 < rows 2：隐藏
  s._cardOnScreen(1);
  assert.strictEqual(s._phaseLive, false, "隐藏卡不得抢占徽标");
  slot.reserved = 4;
  s._cardOnScreen(1);
  assert.strictEqual(s._phaseLive, true, "fund 后挂载完成才算上屏");
});

test("冻结阀：frozen 超 2s 仍未 fund 的隐藏卡按夹紧路径放出", async () => {
  // 非空白缓冲桩：span=0（未 fund），heal 的 _reanchor 走夹紧短分支保留
  // clamped/pinnedRows；空白桩下 span=15 视为已 fund 会合理合钉，非本用例意图
  const s = makeSession({blank: false});
  const slot = makeSlot(s, 1, {rows: 4, frozen: true, frozenAt: Date.now() - 3000});
  s._capped = () => false;
  s._drainHeld = async () => {};
  s._healAll();
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(slot.revealed, true, "冻结阀应放出隐藏卡");
  assert.strictEqual(slot.clamped, true);
  assert.strictEqual(slot.pinnedRows, 1, "按已垫高度夹紧放出，不得 auto 盖下方");
  assert.strictEqual(slot.host.style.visibility, "visible");
});

test("冻结阀未到时（<2s）：隐藏卡继续等 pad", () => {
  const s = makeSession();
  const slot = makeSlot(s, 1, {rows: 4, frozen: true, frozenAt: Date.now()});
  s._capped = () => false;
  s._drainHeld = async () => {};
  s._healAll();
  assert.strictEqual(slot.revealed, false);
});
