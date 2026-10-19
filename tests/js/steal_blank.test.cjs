// 盖帽/漂移处置回归（Phase 4 后语义，替代已拆除的 _stealBlankBelow 移锚回收）。
//
// 旧语义（已删）：盖帽欠账时把「还没露面的下层卡」锚点下移、偷出无主空白 run
// 给本卡补差。移锚会 dispose 旧钉、重贴下层贴纸——错位/闪烁同族根因，且出生
// 事务（锚定前 settle 上游 + 空白尾复用）已把这类欠账在出生窗内消掉，中途
// 不再挪别人的锚。
//
// 新不变量：
//   ① 盖帽欠账：宁截不跳——不移锚、不偷行、下层纹丝不动，本卡夹紧到已垫高度；
//   ② 盖帽零垫的非审批卡不放行（宁藏不盖）；blankSpan ≥ 1 照旧露出已垫部分；
//   ③ 高度漂移感知即钉盒：内容高越出预留区当刻就夹紧钉死，批量窗内不许
//      auto 盒越过预留区盖住下方活文本（遮挡防线）。
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
    classList: {add() {}},
  };
  return el;
}

// 缓冲几何：行 5-9 全空白（T 区 5-6、下层区 7-9），光标行 10
function makeCapSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._padFused = false;
  s._slots = new Map();
  s._toolCards = new Map();   // Phase 2：ai_tool id → 卡 id 映射（构造器字段）
  s.reanchors = [];
  s.decoApplies = [];
  s.clamps = 0;
  s.reveals = 0;
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
    revealed: true, frozen: true, pinnedRows: 2, clamped: true,
    host: makeFakeEl(60), decoration: {dispose() {}}, padOut: 0,
  };
  const low = {
    id: "b", marker: mkMarker(7), reserved: 3, rows: 3, need: 4,
    revealed: true, frozen: true, pinnedRows: null, clamped: false,
    host: null, decoration: {dispose() {}}, padOut: 0,
  };
  s._slots.set("t", T);
  s._slots.set("b", low);
  s._holdBytes = () => {};
  s._releaseBytes = () => {};
  s._drainHeld = async () => {};
  s._reanchor = sl => s.reanchors.push(sl.id);
  s._applyDecoration = (sl, r) => s.decoApplies.push([sl.id, r]);
  // 真 _ensurePad 保留（盖帽分支是被测对象）；子卡补差走桩记账
  const realEnsurePad = Object.getPrototypeOf(s)._ensurePad;
  s._ensurePad = sl => (sl === T
    ? realEnsurePad.call(s, sl)
    : (s.pads.push(sl.id), Promise.resolve()));
  s._clampCard = sl => { s.clamps++; sl.clamped = true; };
  s._revealSlot = sl => { s.reveals++; sl.revealed = true; };
  s._refreshThink = () => {};
  s._styleHost = () => {};
  s._markerOnScreen = () => true;
  return {s, T, low, lines};
}

test("盖帽欠账：宁截不跳——不移锚不偷行，下层纹丝不动，本卡夹紧", async () => {
  const {s, T, low} = makeCapSession();
  const oldMarker = low.marker;
  await s._ensurePad(T);
  assert.strictEqual(low.marker.line, 7, "下层锚点不得移动（移锚回收已拆除）");
  assert.strictEqual(oldMarker.disposed, 0, "下层旧钉不得 dispose");
  assert.strictEqual(s._slots.has("b"), true, "下层槽不得被牵连");
  assert.deepStrictEqual(s.decoApplies, [], "下层不得被重贴");
  assert.ok(!s.pads.includes("b"), "下层不得被代发 pad");
  assert.ok(s.clamps > 0, "本卡应夹紧到已垫高度（宁矮不盖）");
});

test("盖帽零垫的非审批卡不放行（宁藏不盖）", async () => {
  const {s, T, low, lines} = makeCapSession();
  for (let i = 5; i <= 9; i++) lines[i] = "output";   // 预留区被输出插死
  T.reserved = 0;
  await s._ensurePad(T);
  assert.strictEqual(s.reveals, 0, "零空白盖帽不放行——露出必被切成半行细条");
  assert.ok(s.clamps > 0);
});

test("盖帽 blankSpan ≥ 1：露出已垫部分", async () => {
  const {s, T} = makeCapSession();
  await s._ensurePad(T);
  assert.ok(s.reveals > 0, "盖帽 ≥1 行档维持现状，露出已垫部分");
});

test("高度漂移感知即钉盒：内容高越出预留区当刻夹紧，不等批量窗", async () => {
  const {s, T} = makeCapSession();
  T.rows = 2;
  T.reserved = 2;
  T.pinnedRows = null;
  T.clamped = false;
  T.host = makeFakeEl(90);   // 90px / 15px 行高 = 6 行 > reserved 2
  s._scheduleDrift(T);
  assert.strictEqual(T.pinnedRows, 2,
    "感知即钉到已垫高度——批量窗内 auto 盒不得越过预留区盖住下方活文本");
  assert.strictEqual(T.clamped, true);
  await sleep(250);   // 批量窗落地不得再长高
  assert.ok(T.pinnedRows != null, "钉死态维持（出生即定型，永不长高）");
});

test("高度漂移不许偷铺增量垫行：盖帽卡批量窗落地后不进补差", async () => {
  const {s, T} = makeCapSession();
  T.host = makeFakeEl(90);   // 内容 6 行 > reserved 2
  // 记录**真实调用**（不是桩的假记录）：漂移路径对盖帽卡连 _ensurePad 都不许进
  const real = Object.getPrototypeOf(s)._ensurePad;
  s._ensurePad = sl => { s.pads.push(sl.id); return real.call(s, sl); };
  s._scheduleDrift(T);
  await sleep(250);
  assert.ok(!s.pads.includes("t"),
    "盖帽卡（下方已被占住）不得走补差路径——夹紧是终态");
  assert.ok(T.pinnedRows != null, "仍钉死在已垫高度");
});

test("并发 _ensurePad 不得双垫：padOut 入队即记账（卡下大白空回归）", async () => {
  const {s, T} = makeCapSession();
  s._slots.delete("b");   // 下层卡撤掉：T 不盖帽、缺口可垫
  T.marker.line = 8;      // 预留区只剩 8-9 两行空白
  T.reserved = 0;
  T.rows = 4;
  T.need = 5;             // 缺口 = 5 - 2 = 3
  T.pinnedRows = null;
  T.clamped = false;
  T.host = makeFakeEl(60);
  const sends = [];
  s.sendJson = o => sends.push(o);
  s._padQ = Promise.resolve();   // 构造器字段：pad 发送串行队列
  s._padFailStreak = 0;
  s._ensurePad = Object.getPrototypeOf(s)._ensurePad.bind(s);
  // 两个并发调用（drift vs heal vs settle 真机同款）：各自 drain 后算缺口
  const p1 = s._ensurePad(T);
  const p2 = s._ensurePad(T);
  setTimeout(() => s._onPadded({}), 20);   // ack 放行 pad 等待
  setTimeout(() => s._onPadded({}), 30);
  await Promise.all([p1, p2]);
  const padSends = sends.filter(x => x && x.type === "pad");
  assert.strictEqual(padSends.length, 1,
    `并发补差只许发一轮 pad（实发 ${padSends.length} 轮）——双垫＝卡下永久大白空`);
  assert.strictEqual(padSends[0].pad, 3, "缺口 3 行一轮垫足");
});

test("命令卡钉死高度盖到按钮簇底（_floorRows 红线⑨：.cmdacts 在卡头右侧）", () => {
  const {s, T} = makeCapSession();
  s._reanchor = Object.getPrototypeOf(s)._reanchor.bind(s);
  s._floorRows = Object.getPrototypeOf(s)._floorRows.bind(s);
  T.kind = "phase";          // 命令卡挂载 kind（二合一后不是 approval）
  T.reserved = 1;
  T.rows = 5;
  T.pinnedRows = null;
  T.host = makeFakeEl(75);   // 内容 5 行
  // 卡盒 top=100，按钮簇 .cmdacts 在卡头右侧（top=108, 底沿=133）——
  // 底线必须盖到按钮簇底，夹紧裁底只丢状态行、不丢按钮
  T.host.getBoundingClientRect = () =>
    ({top: 100, bottom: 175, height: 75});
  T.host.querySelector = sel => (sel === ".cmdacts"
    ? {getBoundingClientRect: () => ({top: 108, bottom: 133, height: 25})}
    : null);
  s._reanchor(T);
  assert.strictEqual(T.pinnedRows, 3,
    "钉死必须盖到 .cmdacts 底（ceil((133-100)/15)=3）——裁掉按钮＝决策死锁");
});

test("救援卡钉死高度不低于 .aphead 首行（按钮在首行，底线是首行高）", () => {
  const {s, T} = makeCapSession();
  s._reanchor = Object.getPrototypeOf(s)._reanchor.bind(s);
  s._floorRows = Object.getPrototypeOf(s)._floorRows.bind(s);
  T.kind = "approval";
  T.reserved = 1;            // 只垫进 1 行
  T.rows = 5;                // 内容 5 行 → short
  T.pinnedRows = null;
  T.host = makeFakeEl(75);
  // 救援卡的按钮就在 .aphead 首行里（RescueCard 的 .apbtns → <button>）：
  // fixture 必须如实带出按钮，否则量的是「无交互行的卡头」，与产品 DOM 不符
  T.host.querySelector = sel => (sel === ".aphead"
    ? {getBoundingClientRect: () => ({height: 45}),   // 按钮行 3 行
       querySelector: q => (q === "button" ? {} : null)}
    : null);
  s._reanchor(T);
  assert.strictEqual(T.pinnedRows, 3,
    "钉死不得低于按钮行高度——细条态按钮不可点＝审批死锁");
});

test("无按钮的卡头不给交互底线（警告/工具卡头只有标签，正文不许被裁）", () => {
  const {s, T} = makeCapSession();
  s._floorRows = Object.getPrototypeOf(s)._floorRows.bind(s);
  // AlertCard/ToolCard 的 .aphead 里只有 .apq 标签与徽标，没有 button：
  // 旧实现把任何 .aphead 都当交互行，夹紧恒钉在卡头高、正文永远被裁出盒
  //（真机图一「⚠ 系统警告」只剩标题、错误正文整段不可见）
  T.host = makeFakeEl(78);
  T.host.querySelector = sel => (sel === ".aphead"
    ? {getBoundingClientRect: () => ({height: 45}),
       querySelector: () => null}
    : null);
  assert.strictEqual(s._floorRows(T), 0,
    "卡头里没有按钮就不该有交互底线");
});

test("钉死高每帧兜底到交互底线（按钮换行长高后不许裁出盒）", () => {
  const {s, T} = makeCapSession();
  const proto = Object.getPrototypeOf(s);
  for (const m of ["_styleHost", "_hostAlive", "_floorRows", "_blankSpan"]) {
    s[m] = proto[m].bind(s);
  }
  s._lineHeight = () => 15;
  s._cellWidth = () => 8;
  s._fixHostVisibility = () => {};
  // clamp 那一刻按钮还没布局完，pinnedRows 记成 3；按钮随后换行长到 4 行底。
  // 只在武装时抬一次底线不够——_styleHost 必须每帧取当前 _floorRows 兜底，
  // 否则按钮行被 overflow:hidden 裁出盒 = 真鼠标点不到 = 决策死锁（红线⑨）
  T.pinnedRows = 3;
  T.rows = 8;
  T.host = makeFakeEl(120);
  T.host.style = {};
  T.host.getBoundingClientRect = () => ({top: 100, bottom: 220, height: 120});
  T.host.querySelector = sel => (sel === ".cmdacts"
    ? {getBoundingClientRect: () => ({top: 100, bottom: 155, height: 55})}
    : null);
  s._styleHost(T);
  // 底线 = ceil((155-100)/15) = 4 行 → 盒高必须抬到 60px，不能停在 3 行 45px
  assert.strictEqual(T.host.style.height, "60px",
    "钉死高不得低于当前按钮行底——按钮被裁＝审批死锁");
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
