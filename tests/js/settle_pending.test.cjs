// 结账补 host 回归（真机 2026-10-06「卡片重叠」根因）：PTY 静默窗（glob 等进程内
// 工具执行、无终端字节）里 xterm 按需渲染不跑，工具卡停 pendingMount——无 host、
// React 内容没落地、高度停出生值 2 行。下层分析卡挂载前的 _settleCard 按出生高
// 结账（_fitNeed 无 host 早退）；等真高度量出来时下层 marker 已钉，pad 只追加在
// 流底、垫不进已闭合的区＝工具卡永久截断在半截头、分析卡紧贴切边（截图形态）。
// 修法：_settleCard 量高前先强制刷视口让 onRender 空闲期交 host，再按真高结账。
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
  // app.js 里 blankRun/rowsForPx/padGap 是浏览器全局（pad_ledger.js 先载）
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

// xterm 装饰元素桩：_fitNeed 量 scrollHeight（4 行 × 兜底行高 15 = 60px）
function makeFakeEl() {
  const el = {
    style: {},
    className: "xterm-decoration",
    isConnected: true,
    scrollHeight: 60,
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

// 只够 _mountCard + _settleCard 跑的会话：真 _fitNeed/_settleCard/_blankSpan，
// pad/reanchor/扣流打桩；refresh 是否触发 onRender 由 s.refreshFires 开关控制
function makeSettleSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._slots = new Map();
  s._lastByteAt = 0;
  s.refreshFires = false;   // 挂载期关掉 → 工具卡落 pendingMount（静默窗形态）
  s.refreshCalls = 0;
  s._onRenderCb = null;
  s.padSnap = null;         // _ensurePad 入账快照（结账时量到的高度）
  s.reanchors = 0;
  s.mounts = [];

  const marker = {line: 5, onDispose() {}};
  const lines = [];
  for (let i = 0; i < 24; i++) lines.push("");   // 全空白缓冲：预留区数得满
  s.term = {
    rows: 24, cols: 80,
    registerMarker: () => marker,
    registerDecoration: () => ({
      onRender: cb => { s._onRenderCb = cb; },
      dispose() {},
    }),
    refresh: () => {
      s.refreshCalls++;
      if (s.refreshFires && s._onRenderCb) s._onRenderCb(makeFakeEl());
    },
    buffer: {active: {
      baseY: 0, cursorY: 20, viewportY: 0,
      getLine: i => ({translateToString: () => lines[i] || ""}),
    }},
  };
  s.term.buffer.normal = s.term.buffer.active;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = cb => setTimeout(() => cb(), 0);

  s._ensureFeed = () => {
    const f = {
      handle: () => {}, mount: id => s.mounts.push(id),
      unmount() {}, destroy() {},
    };
    s._feed = f;
    return Promise.resolve(f);
  };
  s._settle = async () => {};
  s._holdBytes = () => {};
  s._releaseBytes = () => {};
  s._drainHeld = async () => {};
  s._cardOnScreen = () => {};
  s._followBottom = () => {};
  s._ensurePad = async slot => {
    s.padSnap = {rows: slot.rows, need: slot.need, reserved: slot.reserved};
  };
  s._reanchor = () => { s.reanchors++; };
  return s;
}

test("静默窗 pendingMount 卡：结账先补 host、按真高（4 行）入账而非出生 2 行",
  async () => {
    const s = makeSettleSession();
    const slot = await s._mountCard("tool1", "phase");
    assert.ok(slot);
    assert.strictEqual(slot.host, null, "静默窗应落 pendingMount（无 host）");
    assert.ok(slot.pendingMount);

    // 下层卡挂载前的结账：此刻起 refresh 能交出 host（真机：渲染循环被唤醒）
    s.refreshFires = true;
    await s._settleCard(slot);

    assert.ok(slot.host, "结账应强制 refresh 补到 host");
    assert.ok(slot.mounted, "补到 host 即走补挂载（React 内容落地）");
    assert.ok(s.mounts.includes("tool1"));
    assert.ok(s.padSnap, "结账应走到补差");
    assert.strictEqual(s.padSnap.rows, 4,
      "结账按真高 4 行入账（scrollHeight 60 / 行高 15），不是出生 2 行");
    assert.strictEqual(s.padSnap.need, 5, "need = rows + 1 保险行");
  });

test("host 始终交不出（离屏/渲染死）：结账 300ms 放弃、不挂死", async () => {
  const s = makeSettleSession();
  const slot = await s._mountCard("tool2", "phase");
  assert.strictEqual(slot.host, null);
  const t0 = Date.now();
  await s._settleCard(slot);   // refreshFires 恒 false
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `结账不得挂死（实测 ${elapsed}ms）`);
  assert.strictEqual(slot.host, null);
  assert.ok(s.padSnap, "无 host 也按既有路径结账（出生高兜底，不回退）");
  assert.strictEqual(s.padSnap.rows, 2);
});
