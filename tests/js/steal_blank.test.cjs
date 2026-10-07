// 盖帽欠账回收回归（真机 2026-10-06「卡片重叠」第二类根因）：真高度量出来时
// 区已被下层 marker 闭合（React 慢 flush/徽标折行/离屏迟到量高），pad 只追加
// 流底＝永久截断。下层卡没露面（未 reveal/未冻结）时锚点下移让出无主空白 run，
// 本区重新敞开垫满；下层已露面则宁截不跳。同测 _ensurePad 盖帽分支接入。
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

// 缓冲几何：行 5-9 全空白（T 区 5-6、下层区 7-9），光标行 10
function makeStealSession({ lowRevealed = false } = {}) {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._padFused = false;
  s._slots = new Map();
  s.reanchors = [];
  s.decoApplies = [];
  s.clamps = 0;
  s.pads = [];
  const lines = [];
  for (let i = 0; i < 24; i++) lines.push("");
  const cursor = 10;
  s.term = {
    rows: 24, cols: 80,
    registerMarker: off => ({line: cursor + off, onDispose() {}, dispose() {}}),
    registerDecoration: () => ({onRender() {}, dispose() {}}),
    refresh: () => {},
    buffer: {active: {
      baseY: 0, cursorY: cursor, viewportY: 0,
      getLine: i => ({translateToString: () => lines[i] || ""}),
    }},
  };
  s.term.buffer.normal = s.term.buffer.active;
  const mkMarker = line => ({line, onDispose() {}, disposed: 0,
    dispose() { this.disposed++; }});
  const T = {
    id: "t", marker: mkMarker(5), reserved: 2, rows: 4, need: 5,
    revealed: true, frozen: false, pinnedRows: 2, clamped: true,
    host: {style: {}, querySelector: () => null, isConnected: true},
    decoration: {dispose() {}}, padOut: 0,
  };
  const low = {
    id: "b", marker: mkMarker(7), reserved: 3, rows: 3, need: 4,
    revealed: lowRevealed, frozen: false, pinnedRows: null, clamped: false,
    host: null, decoration: {dispose() {}}, padOut: 0,
  };
  s._slots.set("t", T);
  s._slots.set("b", low);
  s._holdBytes = () => {};
  s._releaseBytes = () => {};
  s._drainHeld = async () => {};
  s._reanchor = sl => s.reanchors.push(sl.id);
  s._applyDecoration = (sl, r) => s.decoApplies.push([sl.id, r]);
  s._ensurePad = async sl => { s.pads.push(sl.id); };
  s._clampCard = sl => { s.clamps++; };
  s._revealSlot = () => {};
  s._markerOnScreen = () => true;
  return {s, T, low};
}

test("下层未露面：锚点下移到本卡真高之后，本区重数即 fund", async () => {
  const {s, T, low} = makeStealSession();
  const oldMarker = low.marker;
  const ok = await s._stealBlankBelow(T);
  assert.ok(ok, "未露面的下层卡应让出空白 run");
  assert.strictEqual(low.marker.line, 9, "下层锚点应移到 T 真高（4 行）之后");
  assert.strictEqual(oldMarker.disposed, 1, "旧钉应被 dispose（身份守卫不删槽）");
  assert.strictEqual(s._slots.has("b"), true, "旧钉 dispose 不得删下层槽");
  assert.strictEqual(T.reserved, 4, "本区重数应含让出的空白＝真高 4 行");
  assert.strictEqual(low.host, null);
  assert.strictEqual(low.pinnedRows, null);
  assert.deepStrictEqual(s.decoApplies, [["b", 2]], "下层应重贴 decoration");
  assert.ok(s.reanchors.includes("t") && s.reanchors.includes("b"));
  assert.ok(s.pads.includes("b"), "下层缺的行应自己在流底补");
});

test("下层已露面：宁截不跳，锚点不动", async () => {
  const {s, T, low} = makeStealSession({lowRevealed: true});
  const line = low.marker.line;
  const ok = await s._stealBlankBelow(T);
  assert.strictEqual(ok, false);
  assert.strictEqual(low.marker.line, line);
  assert.strictEqual(T.reserved, 2);
});

test("_ensurePad 盖帽分支接入：欠账先回收、不再直接夹紧", async () => {
  const {s, T, low} = makeStealSession();
  // T 走真 _ensurePad（盖帽分支），内部对 low 的补差落到桩上记一笔
  const real = Object.getPrototypeOf(s)._ensurePad;
  s._ensurePad = sl => (sl === T
    ? real.call(s, sl)
    : (s.pads.push(sl.id), Promise.resolve()));
  await s._ensurePad(T);
  assert.strictEqual(low.marker.line, 9, "盖帽分支应先尝试回收");
  assert.strictEqual(s.clamps, 0, "回收成功不应再夹紧");
});
