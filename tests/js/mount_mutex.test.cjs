// 并发挂载同锚点重叠回归（真机「工具卡盖审批卡、点不到、界面干等审批」根因）：
// tool_start 走 _cardReady 链、showApproval/_showRescue/_mountSummary 不走——
// 两条链上的 _mountCard 并发跑到底时，registerMarker 都钉在「当前光标行」，
// 两张 island 叠在同一缓冲行上，后贴纸者盖住先者。被盖的是审批卡时按钮点不到，
// 而看门狗视 mounted+未夹紧(pinnedRows==null) 为健康、不转模态＝决策死锁。
// 契约：_mountCard 的锚定临界区（含尾部 _ensurePad——下张卡的 marker 必须钉在
// 本卡预留空行落地、光标下移之后）对并发调用串行。
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
    {now: () => Date.now()},
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

// 可推进光标的会话桩：_ensurePad 模拟 pad 空行落地（光标随之下移），
// registerMarker 按「调用时刻的光标行」发钉——并发挂载是否同锚点一目了然。
function makeSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s._slots = new Map();
  s._holdDepth = 0;
  s._holdBuf = [];
  s._lastByteAt = 0;
  s._cardReady = Promise.resolve();
  s._approvalGraceMs = 400;
  s.lines = [];            // registerMarker 发钉行序
  s.handled = [];          // feed.handle 事件序
  s._onRenderCb = null;

  const buf = {baseY: 0, cursorY: 20, viewportY: 0,
               getLine: () => ({translateToString: () => ""})};
  s.term = {
    rows: 24, cols: 80,
    registerMarker: off => {
      const line = buf.baseY + buf.cursorY + (off || 0);
      s.lines.push(line);
      return {line, onDispose() {}};
    },
    registerDecoration: () => ({
      onRender: cb => { s._onRenderCb = cb; },
      dispose() {},
    }),
    refresh: () => { if (s._onRenderCb) s._onRenderCb(makeFakeEl()); },
    buffer: {active: buf},
  };
  s.term.buffer.normal = buf;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = cb => setTimeout(() => cb(), 0);

  s._ensureFeed = () => {
    const f = {
      handle: e => s.handled.push(e),
      mount: () => {}, unmount() {}, destroy() {}, flush() {},
    };
    s._feed = f;
    return Promise.resolve(f);
  };
  s._holdBytes = () => {};
  s._releaseBytes = () => {};
  s._drainHeld = async () => {};
  s._settleCard = async () => {};
  s._capped = () => false;
  s._fitNeed = slot => { slot.rows = 3; slot.need = 4; };
  s._reanchor = () => {};
  s._scheduleReanchor = () => {};
  s._watchCardResize = () => {};
  s._refreshThink = () => {};
  s._cardOnScreen = () => {};
  s._followBottom = () => {};
  // pad 落地：空行追加在流底，光标下移——串行挂载的下一张卡因此钉在更下方
  s._ensurePad = async slot => { buf.cursorY += (slot.need || 2); };
  return s;
}

const slotLines = s => [...s._slots.values()]
  .filter(x => x.marker).map(x => x.marker.line);

test("并发 _mountCard：两张卡不得钉同一缓冲行（后贴纸者会盖住先者）", async () => {
  const s = makeSession();
  const [a, b] = await Promise.all([
    s._mountCard(1, "phase"),
    s._mountCard(2, "approval"),
  ]);
  assert.ok(a && b, "两张卡都应挂载成功");
  assert.strictEqual(s.lines.length, 2, "应发两枚钉");
  assert.ok(s.lines[1] > s.lines[0],
    `第二张卡必须钉在第一张预留区之下（实际 ${s.lines[0]} vs ${s.lines[1]}＝同锚重叠）`);
});

test("真入口竞态：ai_tool start 与 showApproval 同包到达，审批卡钉在工具卡之下", async () => {
  const s = makeSession();
  const cmd = "docker exec vb_fwl_svc rm -rf /tmp/x";
  s._onAiTool({phase: "start", id: 7, name: "execute", args: cmd});
  s.showApproval(cmd, "删除操作", "host1", "high");
  // 等两条挂载链都落定（审批卡 kind=approval）
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    const kinds = [...s._slots.values()].map(x => x.kind);
    if (kinds.includes("approval") && s._slots.has("tool7")) break;
    await s._sleep(20);
  }
  const tool = s._slots.get("tool7");
  const ap = [...s._slots.values()].find(x => x.kind === "approval");
  assert.ok(tool && tool.marker, "工具卡应挂载");
  assert.ok(ap && ap.marker, "审批卡应挂载");
  assert.ok(ap.marker.line > tool.marker.line,
    `审批卡须位于工具卡之下（实际 tool@${tool.marker.line} approval@${ap.marker.line}＝审批卡被工具卡盖住、按钮点不到）`);
  // 视觉叠序由各 island 自己的 marker 行决定，与 feed.handle 序无关
  // （showApproval 刻意「先入 store 再挂卡」，approval handle 早于挂载）
  assert.ok(s.handled.some(e => e.kind === "tool_start") &&
            s.handled.some(e => e.kind === "approval"),
    "tool_start 与 approval 都应进 store");
});

test("串行回归：顺序挂载仍各自钉流底（锁不改变单调用方语义）", async () => {
  const s = makeSession();
  const a = await s._mountCard(1, "phase");
  const b = await s._mountCard(2, "approval");
  assert.ok(a && b);
  assert.ok(s.lines[1] > s.lines[0], "顺序挂载次序不变");
  assert.strictEqual(a.mounted, true);
  assert.strictEqual(b.mounted, true);
});
