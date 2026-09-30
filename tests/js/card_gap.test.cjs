// 卡间大缝隙回归（真机 2026-09-30：三张卡每张之间约 6 行空白）。根因二：
// ① _fitNeed 的流式裕量 +5 对「挂载首测单次跳变」和「定格后结账」也生效，
//    落地即不可回收＝每卡下定格 6 行空白；② 冻结卡多垫的空白尾不留给下一张
//    卡复用，卡间永久留白。修法：裕量只认流式连续长高；挂载时冻结上游卡的
//    空白尾被新卡 marker 复用（registerMarker 负偏移钉到空白尾首行）。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "app.js");
const LEDGER = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "pad_ledger.js");

function loadSessionClass() {
  const src = fs.readFileSync(APP, "utf8");
  const ledger = require(LEDGER);
  global.rowsForPx = ledger.rowsForPx;
  global.padGap = ledger.padGap;
  global.blankRun = ledger.blankRun;
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
    {getItem: () => null, setItem() {}, removeItem: () => {}},
    () => new Promise(() => {}),
    {now: () => 0},
    s => s);
}

function makeFakeEl() {
  const el = {
    style: {},
    className: "xterm-decoration",
    isConnected: true,
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

// 只够 _mountCard 跑的会话（同 card_mount.test.cjs 的桩法）
function makeMountSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._slots = new Map();
  s._holdDepth = 0;
  s._holdBuf = [];
  s._lastByteAt = 0;
  s.offsets = [];
  s._onRenderCb = null;
  s.term = {
    rows: 24, cols: 80,
    registerMarker: off => {
      s.offsets.push(off);
      return {line: 20 - (off || 0), onDispose() {}};
    },
    registerDecoration: () => ({
      onRender: cb => { s._onRenderCb = cb; },
      dispose() {},
    }),
    refresh: () => { if (s._onRenderCb) s._onRenderCb(makeFakeEl()); },
    buffer: {active: {baseY: 0, cursorY: 20, viewportY: 0}},
  };
  s.term.buffer.normal = s.term.buffer.active;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = cb => setTimeout(() => cb(), 0);
  s._ensureFeed = () => {
    const f = {handle: () => {}, mount: () => {}, unmount() {}, destroy() {}};
    s._feed = f;
    return Promise.resolve(f);
  };
  s._holdBytes = () => {};
  s._releaseBytes = () => {};
  s._discardSlot = () => {};
  s._fitNeed = () => {};
  s._ensurePad = async () => {};
  s._reanchor = () => {};
  s._scheduleReanchor = () => {};
  s._settleCard = async () => {};
  s._capped = () => false;
  return s;
}

test("_fitNeed 裕量只认流式连续长高：首测/冻结不带 +5", () => {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._lineHeight = () => 15;
  s._hostAlive = () => true;
  const host = {scrollHeight: 90, style: {}, querySelector: () => null};
  const slot = {host, rows: 0, need: 0};
  s._fitNeed(slot);                      // 挂载首测：6 行，单次跳变无裕量
  assert.strictEqual(slot.rows, 6);
  assert.strictEqual(slot.need, 7, "首测不得带流式裕量（落地即不可回收）");
  host.scrollHeight = 120;               // 流式第二次长高 → 裕量生效
  s._fitNeed(slot);
  assert.strictEqual(slot.rows, 8);
  assert.strictEqual(slot.need, 14, "流式连续长高应带 +5 裕量防夹紧裁切");
  slot.frozen = true;
  host.scrollHeight = 150;               // 定格后结账：不再带裕量
  s._fitNeed(slot);
  assert.strictEqual(slot.rows, 10);
  assert.strictEqual(slot.need, 11, "冻结卡结账不得带裕量");
});

test("挂载复用冻结上游卡的空白尾：marker 负偏移钉空白尾首行", async () => {
  const s = makeMountSession();
  // 光标行 20；上游冻结卡 marker 10、预留 10 行、真高 4 行 → 空白尾 6 行
  // （缓冲 14..19 空白，14 以上有字）
  s.term.buffer.active.getLine = i => ({
    translateToString: () => (i >= 14 && i <= 19 ? "" : "x"),
  });
  const up = {id: 1, marker: {line: 10, onDispose() {}},
              frozen: true, reserved: 10, rows: 4, need: 10};
  s._slots.set(1, up);
  const slot = await s._mountCard(2);
  assert.ok(slot, "新卡应挂载成功");
  assert.deepStrictEqual(s.offsets, [-6],
    "marker 应钉到空白尾首行（光标 - 复放行数）");
  assert.strictEqual(up.reserved, 4, "上游让出空白尾后账目同步收缩");
  assert.strictEqual(up.need, 4, "冻结卡不再保留 +1 保险行");
});

test("上游未冻结不复用：活卡的空白是它自己的裕量", async () => {
  const s = makeMountSession();
  s.term.buffer.active.getLine = () => ({translateToString: () => ""});
  const up = {id: 1, marker: {line: 10, onDispose() {}},
              frozen: false, reserved: 10, rows: 4, need: 10};
  s._slots.set(1, up);
  const slot = await s._mountCard(2);
  assert.ok(slot);
  assert.strictEqual(s.offsets[0], 0, "活卡上游不得复用（它还可能长高）");
  assert.strictEqual(up.reserved, 10, "活卡账目不动");
});
