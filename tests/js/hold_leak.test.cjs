// 扣流漏还 + 扣流窗无界 回归（真机 2026-10-11「总结卡渲染后打字不回显」）。
//
// 现象：总结卡渲染完毕后命令行卡顿几秒——打不进字，或打进去几秒后才回显。
// 真机仪表（tools/verify-web/diag-post-final-freeze.cjs）定位到两处：
//   ① 漏还：_scheduleReanchor 的「长高」扣流记在 slot.growHolds，由 150ms
//      批量窗定时器负责归还；_settleCard / _discardSlot 会 clearTimeout 接管
//      或丢弃该窗，旧实现没同步归还 → _holdActive() 永久为真，PTY 字节只进
//      _holdBuf 不落 xterm；且字节不进 _writeTerm 就不唤醒 _scheduleHeal，
//      自愈也救不回（实测 hold depth 卡在 1，之后回显全部 TIMEOUT）。
//   ② 无界：批量窗原来是防抖（每次长高都 clearTimeout 重排），连续流式长高
//      期间永远不触发——实测 3.5s 内叠到 43 层 card-grow 未归还，整段回显被
//      扣住。现改节流：150ms 一批，扣流窗钉在「批量 + pad 往返」量级。
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

// 只够 _scheduleReanchor/_settleCard/_discardSlot 跑的会话。
// 关键：_holdBytes/_releaseBytes/_releaseGrow 用**真**实现——被测的就是记账
// 是否配平，打桩就等于把断言对象换掉了。
function makeGrowSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._slots = new Map();
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
  s._cardOnScreen = () => {};
  s._followBottom = () => {};
  s._applyDecoration = () => {};
  s._styleHost = () => {};
  s._refreshThink = () => {};
  s._revealSlot = () => {};

  // 一张「已露出、还会长高」的卡：_fitNeed 量 6 行 > reserved 0 → 触发长高扣流
  const host = makeFakeEl(90);   // 90px / 15px 行高 = 6 行
  const slot = {
    id: "c1", marker, decoration: null, host,
    reserved: 0, need: 2, rows: 2, clamped: false, ro: null,
    reanchorT: null, mounted: true, pendingMount: false,
    pinnedRows: null, forceReapply: false,
    kind: "phase", revealed: true, frozen: false, frozenAt: 0,
    padOut: 0, padP: null, growHolds: 0,
  };
  s._slots.set("c1", slot);
  return {s, slot};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("定格结账取消批量窗后，长高扣流必须归还（holdDepth 回 0）", async () => {
  const {s, slot} = makeGrowSession();
  s._scheduleReanchor(slot);
  assert.ok(slot.growHolds > 0, "长高应记账扣流");
  assert.strictEqual(s._holdDepth, slot.growHolds);
  assert.ok(slot.reanchorT, "应有在途批量窗");

  // 真机路径：下层卡挂载前的 _settleCard 接管结账 → clearTimeout 批量窗
  s._settleCard(slot);
  await slot.settling;

  assert.strictEqual(slot.growHolds, 0, "接管后记账应清零");
  assert.strictEqual(s._holdDepth, 0,
    "扣流必须配平——漏一笔就让 _holdActive() 永久为真，回显全被扣住");
  assert.strictEqual(s._holdBuf.length, 0);
});

test("丢槽（收束扫尾/同 id 顶替）取消批量窗后，长高扣流必须归还", async () => {
  const {s, slot} = makeGrowSession();
  s._scheduleReanchor(slot);
  assert.strictEqual(s._holdDepth, 1);

  s._discardSlot(slot);

  assert.strictEqual(slot.growHolds, 0);
  assert.strictEqual(s._holdDepth, 0, "丢槽不得漏还扣流");
});

test("批量窗是节流不是防抖：持续长高期间必须周期性放行扣流", async () => {
  const {s, slot} = makeGrowSession();
  let releases = 0, rebases = 0;
  const origRelease = s._releaseBytes.bind(s);
  s._releaseBytes = () => {
    origRelease();
    if (s._holdDepth === 0) releases++;   // 归零次数 = 扣流真正放行过几轮
  };
  s._reanchor = () => { rebases++; };

  // 真机流式：ResizeObserver 大约每 25ms 报一次长高，连着几百 ms 到几秒
  const span = 750, step = 25;
  for (let t = 0; t < span; t += step) {
    s._scheduleReanchor(slot);
    await sleep(step);
  }
  await sleep(250);   // 收尾，让最后一窗落地

  // 防抖（旧实现）整段只在流结束时放行一次（releases 停在 1、rebases = 1），
  // 全程回显被扣住；节流每 150ms 一批 → 放行多轮。
  assert.ok(releases >= 3,
    `持续长高期必须周期性放行扣流（实测归零 ${releases} 次）——` +
    "防抖会让整个流式期回显全被扣住，就是「总结卡后打不进字」的体感来源");
  assert.ok(rebases >= 3,
    `批量窗应按 150ms 节奏重贴（实测 ${rebases} 次），不是流末一次性重贴`);
});

test("长高流结束 + 批量窗落地后，扣流必须归零（残留 = 终端永久停摆）", async () => {
  const {s, slot} = makeGrowSession();
  for (let i = 0; i < 20; i++) { s._scheduleReanchor(slot); await sleep(20); }
  await sleep(300);   // 让在途批量窗跑完

  assert.strictEqual(s._holdDepth, 0,
    `批量窗结束后不得残留扣流（实测深度 ${s._holdDepth}）`);
  assert.strictEqual(slot.growHolds, 0);
});
