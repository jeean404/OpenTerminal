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
    querySelector: () => null,
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
  s._toolCards = new Map();   // Phase 2：ai_tool id → 卡 id 映射（构造器字段）
  s._cardSeq = 0;
  s._taskClosed = false;
  s.modals = [];
  s._approvalModal = cmd => s.modals.push(cmd);
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

// Phase 2：审批不再挂独立卡——按钮就地武装在命令卡上（command_card_waiting），
// 「审批卡加塞到宣告卡之前」的事故形态从根上消失；此例守住替代不变量：
// 审批全程零新增 slot（不垫行）、武装事件必须落到映射的那张命令卡上。
test("并行 tool_calls 批量宣告后到达的审批：就地武装命令卡，不加塞不长新卡", async () => {
  const s = makeSession();
  const cmd = "uptime; echo '---'; nproc; ps aux --sort=-%mem | head -n 6";
  // 同一条模型消息的并行调用：tool_start 批量先到，approval 随后
  s._onAiTool({phase: "start", id: 1, name: "read_file", args: "/skills/SKILL.md"});
  s._onAiTool({phase: "start", id: 2, name: "execute", args: "free -h; df -hT", command: "free -h; df -hT"});
  s._onAiTool({phase: "start", id: 3, name: "execute", args: cmd, command: cmd});
  s.showApproval(cmd, "高危命令需要审批", "host1", "high", 3);

  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (s._slots.has(s._toolCards.get(3))) break;
    await s._sleep(20);
  }
  await s._sleep(150);
  const toolIds = [1, 2, 3].map(i => s._toolCards.get(i));
  assert.ok(toolIds.every(id => s._slots.get(id)), "三张工具卡都应挂载");
  assert.strictEqual([...s._slots.values()].filter(x => x.kind === "approval").length, 0,
    "审批不得再挂独立卡（加塞入口从根上消失）");
  assert.strictEqual(s._slots.size, 3, "审批不得新增任何 slot（不垫行）");
  const wait = s.handled.find(e => e.kind === "command_card_waiting");
  assert.ok(wait, "command_card_waiting 应进 feed");
  assert.strictEqual(wait.id, s._toolCards.get(3),
    "武装必须落到映射的那张命令卡（卡 id 统一经 _toolCards 映射）");
  // 工具卡钉位仍单调（旧 marker.line 严格性不变量）
  const lines = toolIds.map(id => s._slots.get(id).marker.line);
  assert.deepStrictEqual([...lines].sort((a, b) => a - b), lines,
    `工具卡钉位应单调（实际 ${lines.join(",")}）`);
});

// 旧例不变量「迟到的审批卡不得上屏」在 Phase 2 结构性消失（无卡可上屏）。
// 顶掉后的残余风险改为：看门狗给旧令弹模态/动命令卡——点了会把决策
// 发到下一令头上（幽灵决策），防幽灵守卫（_approvalKey 整键比对）必须拦下。
test("链上等审批期间命令已被顶掉：看门狗不得给旧令弹模态或动卡", async () => {
  const s = makeSession();
  const cmd = "rm -rf /tmp/a";
  s._mountCard = async () => null;   // 命令卡挂不起来：看门狗全程等不到可点
  s._onAiTool({phase: "start", id: 1, name: "execute", args: cmd, command: cmd});
  s.showApproval(cmd, "删除", "host1", "high", 1);
  // 顶掉时机：showApproval 的同步记账与头部守卫已过（微任务），
  // 看门狗还在 grace 窗口里等——正是「排队等链」扩出来的窗口
  await s._sleep(0);
  s._approvalKey = "2\u0000other-cmd";   // 下一令顶掉（去重键换代）
  await s._sleep(600);                   // 跑过 grace(400)
  assert.ok(!s.modals.includes(cmd), "顶掉后的旧令不得弹模态（点了决策会发给下一令）");
  assert.ok(!s.handled.some(e => e.kind === "approval_void"),
    "顶掉后不得再动命令卡（void 属于旧令）");
});
