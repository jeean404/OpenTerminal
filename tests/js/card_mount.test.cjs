// 卡片挂载竞态回归（真机「思考界面没出来」根因）：task_start 落在「提交→首
// 字节」空闲间隙时 xterm 按需渲染不跑、decoration onRender 不触发、host 拿不到。
// 旧实现在 500ms 等不到 host 就 discard+return null → task_start 进不了 store、
// 后续 ai_token/ai_think 全丢、整卡不显示（命令照跑）。修法：挂载时强制
// term.refresh 让 onRender 空闲期即交 host；仍等不到则挂起 pendingMount，由首笔
// 输出引发渲染时 onRender 调 _finishMount 补挂载，且 _mountCard 不再 return null。
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

// 模拟 xterm 交出的装饰元素：带 xterm-decoration 类（vendored xterm.css 靠它给
// position:absolute;z-index）。onRender 必须 classList.add 追加而非覆盖 className，
// 否则定位类被抹掉、卡片掉到屏幕块末尾不可见（真机根因#2）。
function makeFakeEl() {
  const el = {
    style: {},
    className: "xterm-decoration",
    isConnected: true,          // 真元素挂在装饰容器里；_hostAlive 靠它判活
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

// 造一个只够 _mountCard 跑的会话：term/RO/rAF/装饰全打桩，onRender 回调可手动触发
function makeMountSession({ refreshFiresOnRender }) {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._slots = new Map();
  s._holdDepth = 0;
  s._holdBuf = [];
  s._lastByteAt = 0;
  s.mounts = [];          // feed.mount 调用记录
  s.pads = 0;             // _ensurePad 调用次数
  s.refreshCalls = 0;
  s._onRenderCb = null;   // _applyDecoration 捕获的 onRender

  const marker = {line: 5, onDispose() {}};
  s.term = {
    rows: 24, cols: 80,
    registerMarker: () => marker,
    // 让真 _applyDecoration 跑：它内部 deco.onRender(appHandler) 把应用回调
    // 登记进 s._onRenderCb，测试稍后可手动触发模拟「渲染交出 host」
    registerDecoration: () => ({
      onRender: cb => { s._onRenderCb = cb; },
      dispose() {},
    }),
    refresh: (a, b) => {
      s.refreshCalls++;
      // 模拟「强制刷新即触发渲染」：同步回调 onRender 交出 host
      if (refreshFiresOnRender && s._onRenderCb) {
        s._onRenderCb(makeFakeEl());
      }
    },
    buffer: {active: {baseY: 0, cursorY: 20, viewportY: 0}},
  };
  s.term.buffer.normal = s.term.buffer.active;   // 主缓冲：显隐自管生效
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = cb => setTimeout(() => cb(), 0);

  s._ensureFeed = () => {
    const f = {
      handle: () => {}, mount: (id, el) => s.mounts.push(id),
      unmount() {}, destroy() {},
    };
    s._feed = f;   // 真 _ensureFeed 会赋 this._feed，_finishMount 依赖它
    return Promise.resolve(f);
  };
  s._holdBytes = () => {};
  s._releaseBytes = () => {};
  s._discardSlot = () => { s.discarded = true; };
  s._fitNeed = () => {};
  s._ensurePad = async () => { s.pads++; };
  s._reanchor = () => {};
  s._scheduleReanchor = () => {};
  return s;
}

test("空闲期 refresh 触发 onRender → 快路径挂载成功（host/_feed.mount/pad 都到位）", async () => {
  const s = makeMountSession({refreshFiresOnRender: true});
  const slot = await s._mountCard(7);
  assert.ok(slot, "快路径应返回 slot 而非 null");
  assert.strictEqual(s.refreshCalls, 1, "挂载应强制 refresh 一次");
  assert.ok(slot.host, "onRender 应交出 host");
  assert.match(slot.host.className, /xterm-decoration/,
    "不得覆盖 xterm-decoration 类（vendored xterm.css 靠它绝对定位）");
  assert.match(slot.host.className, /ot-card-host/);
  assert.strictEqual(slot.mounted, true);
  assert.strictEqual(slot.pendingMount, false);
  assert.deepStrictEqual(s.mounts, [7], "feed.mount 应被调用");
  assert.strictEqual(s.pads, 1, "空闲期应补差 pad");
  assert.ok(!s.discarded, "不应 discard");
});

test("元素活着时「重贴」只改样式：不 dispose、不换 host（换贴纸=新元素可能永不诞生）", async () => {
  const s = makeMountSession({refreshFiresOnRender: true});
  let disposed = 0;
  s.term.registerDecoration = () => ({
    onRender: cb => { s._onRenderCb = cb; },
    dispose() { disposed++; },
  });
  const slot = await s._mountCard(11);
  const host0 = slot.host;
  assert.ok(host0, "挂载后应有 host");
  // 流底长高（卡高于视口时 marker 会滚到视口上方，xterm 不再建元素）
  slot.rows = 40; slot.clamped = false; slot.pinnedRows = null;
  s._applyDecoration(slot, 40);
  assert.strictEqual(disposed, 0, "元素活着不得 dispose");
  assert.strictEqual(slot.host, host0, "不得换 host（换=React root 迁移=闪）");
  assert.strictEqual(slot.host.style.height, "auto", "非钉死态内容自撑");
  // 钉死截断：写死高度而非重贴
  slot.clamped = true; slot.pinnedRows = 12;
  s._applyDecoration(slot, 12);
  assert.strictEqual(disposed, 0);
  assert.strictEqual(slot.host.style.height, (12 * 15) + "px", "钉死态按行数写死盒高");
});

test("锚定次序：灌已扣字节 → 结账上层卡 → 再灌 → 才钉 marker", async () => {
  const s = makeMountSession({refreshFiresOnRender: true});
  s.seq = [];
  const rm = s.term.registerMarker;
  s.term.registerMarker = () => { s.seq.push("marker"); return rm(); };
  s._drainHeld = async () => { s.seq.push("drain"); };
  s._settleCard = async () => { s.seq.push("settle"); };
  s._capped = () => false;                 // 让上层卡进结账窗口
  s._slots.set(1, {id: 1, marker: {line: 5, onDispose() {}}});
  const slot = await s._mountCard(2);
  assert.ok(slot, "新卡应挂载成功");
  // marker 钉在「已落地字节」之下：否则队列里的输出随后写进新卡预留区，
  // 新卡一出生就被盖帽（blank=0 → 夹紧到 1 行，永不再长）
  assert.deepStrictEqual(s.seq.slice(0, 4), ["drain", "settle", "drain", "marker"],
    "灌干净再钉 marker，结账垫的空行才算数");
});

test("空闲期 onRender 不来 → 挂起 pendingMount，不 return null、不 discard", async () => {
  const s = makeMountSession({refreshFiresOnRender: false});
  const slot = await s._mountCard(8);   // 内部等满 500ms
  assert.ok(slot, "等不到 host 也不得 return null（否则 task_start 丢、整卡不显示）");
  assert.strictEqual(slot.pendingMount, true, "应挂起待补挂载");
  assert.strictEqual(slot.mounted, false);
  assert.strictEqual(s.mounts.length, 0, "host 未到时不 mount");
  assert.ok(!s.discarded, "不得 discard slot");
});

test("首笔输出引发渲染 → onRender 补挂载（_finishMount：mount+pad 到位）", async () => {
  const s = makeMountSession({refreshFiresOnRender: false});
  const slot = await s._mountCard(9);
  assert.strictEqual(slot.pendingMount, true);
  // 模拟首笔输出触发渲染，xterm 回调 onRender 交出 host
  s._onRenderCb(makeFakeEl());
  assert.ok(slot.host, "onRender 应设 host");
  assert.strictEqual(slot.mounted, true, "_finishMount 应置 mounted");
  assert.strictEqual(slot.pendingMount, false);
  assert.deepStrictEqual(s.mounts, [9], "补挂载应 feed.mount");
  assert.strictEqual(s.pads, 1, "补挂载应补差 pad");
});
