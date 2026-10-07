// 审批卡不得加塞到已宣告工具卡之前（真机 2026-10-08「还没审批，工具卡已经
// 出现在审批卡下面」）：并行 tool_calls 会让 core 在消息到达时一次性发齐全部
// tool_start（工具卡＝调用宣告，不是已执行），approval 消息随后才到；
// showApproval 挂卡不走 _cardReady 链 → 审批卡抢在「已宣告未挂载」的工具卡
// 前面锚定，屏上就是审批卡居中、下面挂一排未决策的宣告卡。契约：审批卡挂载
// 排进 _cardReady 链尾，落在这批工具卡之下，决策前屏底不再长新卡。
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
  s.lines = [];
  s.handled = [];
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
  s._ensurePad = async slot => { buf.cursorY += (slot.need || 2); };
  return s;
}

test("并行 tool_calls 批量宣告后到达的审批：审批卡钉在全部工具卡之下", async () => {
  const s = makeSession();
  const cmd = "uptime; echo '---'; nproc; ps aux --sort=-%mem | head -n 6";
  // 同一条模型消息的并行调用：tool_start 批量先到，approval 随后
  s._onAiTool({phase: "start", id: 1, name: "read_file", args: "/skills/SKILL.md"});
  s._onAiTool({phase: "start", id: 2, name: "execute", args: "free -h; df -hT"});
  s._onAiTool({phase: "start", id: 3, name: "execute", args: cmd});
  s.showApproval(cmd, "高危命令需要审批", "host1", "high");

  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if ([...s._slots.values()].some(x => x.kind === "approval") &&
        s._slots.has("tool3")) break;
    await s._sleep(20);
  }
  const ap = [...s._slots.values()].find(x => x.kind === "approval");
  const tools = ["tool1", "tool2", "tool3"].map(id => s._slots.get(id));
  assert.ok(ap && ap.marker, "审批卡应挂载");
  assert.ok(tools.every(t => t && t.marker), "三张工具卡都应挂载");
  const maxTool = Math.max(...tools.map(t => t.marker.line));
  assert.ok(ap.marker.line > maxTool,
    `审批卡须在本批工具卡之下（实际 approval@${ap.marker.line}，工具卡最高@${maxTool}＝未决策的宣告卡挂到审批卡下面）`);
});

test("链上等审批期间命令已被顶掉：迟到的审批卡不得上屏（void+出清）", async () => {
  const s = makeSession();
  const cmd = "rm -rf /tmp/a";
  s._onAiTool({phase: "start", id: 1, name: "execute", args: "free -h"});
  s.showApproval(cmd, "删除", "host1", "high");
  // 顶掉时机：showApproval 的同步记账与头部守卫已过（微任务），挂载还在路上
  // （定时器序）——正是「排队等链」扩出来的窗口
  await s._sleep(0);
  s._approvalCmd = "other-cmd";
  const t0 = Date.now();
  while (Date.now() - t0 < 2000 && s._slots.size < 1) await s._sleep(20);
  await s._sleep(150);   // 给迟到挂载一点落地窗口
  const stale = [...s._slots.values()].find(x => x.kind === "approval");
  assert.ok(!stale, "命令已顶掉时迟到的审批卡不得留在屏上");
});
