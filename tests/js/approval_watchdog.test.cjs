// 审批可点性看门狗回归（真机 2026-10-06「假死 25min」根因）：审批卡被夹紧
// （pinnedRows 钉死）或 pendingMount 永无 host 时用户点不到，core 却在无界等
// 决策——grace 内不 mounted+未夹紧 即 void 终端卡转模态兜底。同测：审批到达
// 即 _approvalOpen（思考徽标换「等待审批」文案）、attach 补发同命令去重不叠卡。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "app.js");

function loadSessionClass() {
  const src = fs.readFileSync(APP, "utf8");
  const els = new Map();
  const fakeDoc = {
    createElement: () => ({style: {}, classList: {add() {}, remove() {}}}),
    addEventListener() {},
    // 单例元素 + .ttext 子节点：_refreshThink 的徽标文案断言靠它
    getElementById: id => {
      if (!els.has(id)) {
        els.set(id, {
          hidden: false, title: "", _ttext: {textContent: ""},
          addEventListener() {}, onclick: null, value: "",
          querySelector(sel) { return sel === ".ttext" ? this._ttext : null; },
        });
      }
      return els.get(id);
    },
    querySelectorAll: () => [],
    head: {appendChild() {}},
    body: {classList: {toggle() {}}},
  };
  const factory = new Function(
    "window", "document", "sessionStorage", "fetch", "performance", "mdLite",
    src + "\n;return Session;");
  const Session = factory(
    {addEventListener() {}}, fakeDoc,
    {getItem: () => null, setItem() {}, removeItem() {}},
    () => new Promise(() => {}),
    {now: () => Date.now()},
    s => s);
  return {Session, els};
}

// 只够 showApproval 跑的会话：feed/mount/模态全打桩并记录调用
function makeApprovalSession(slot) {
  const {Session, els} = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s.tabId = "t1";
  s._slots = new Map();
  s._cardSeq = 0;
  s._taskCardId = null;      // 无活分析卡：跳过定格分支（真机事故形态）
  s._taskActive = true;
  s._approvalOpen = false;
  s._approvalCmd = null;
  s._approvalGraceMs = 120;  // 看门狗 grace 改小跑快
  s.handled = [];
  s.modals = [];
  s.discards = [];
  s._feed = {
    handle: e => s.handled.push(e),
    flush() {}, mount() {}, unmount() {}, destroy() {},
  };
  s._ensureFeed = () => Promise.resolve(s._feed);
  s._mountCard = async () => slot;
  s._discardSlot = sl => s.discards.push(sl);
  s._approvalModal = cmd => s.modals.push(cmd);   // spy：模态真体另路由
  s.sendJson = () => {};
  return {s, els};
}

const settle = ms => new Promise(r => setTimeout(r, ms));

test("审批到达：_approvalOpen 置位 + 思考徽标换「等待审批」文案", async () => {
  const {s, els} = makeApprovalSession({mounted: true, pinnedRows: null});
  s.showApproval("rm -rf /tmp/x", "高危命令需要审批", "h", "high");
  await settle(30);
  assert.deepStrictEqual(s.handled, [{
    kind: "approval", id: 1, command: "rm -rf /tmp/x",
    reasons: "高危命令需要审批", risk: "high",
  }]);
  assert.strictEqual(s._approvalOpen, true);
  assert.strictEqual(s._approvalCmd, "rm -rf /tmp/x");
  const badge = els.get("think-t1");
  assert.strictEqual(badge._ttext.textContent, "等待审批",
    "等审批期间不得照转「AI 正在思考」（真机假死无人知晓在等决策）");
  assert.match(badge.title, /Ctrl\+Enter/);
  assert.strictEqual(s.modals.length, 0, "卡可点时不得弹模态");
});

test("看门狗：卡未 mounted/被夹紧 → grace 后 void 终端卡 + 模态接管", async () => {
  const slot = {mounted: false, pinnedRows: 1};   // 静默期 pendingMount 形态
  const {s} = makeApprovalSession(slot);
  s.showApproval("rm -rf /tmp/y", "r", "h", "high");
  await settle(30);
  assert.strictEqual(s.modals.length, 0, "grace 内不得提前转模态");
  await settle(250);
  assert.deepStrictEqual(s.handled.slice(1), [{kind: "approval_void", id: 1}],
    "终端卡应被 void（键盘路径随之无未决卡，防双决策）");
  assert.deepStrictEqual(s.discards, [slot], "slot 应整体拆掉");
  assert.deepStrictEqual(s.modals, ["rm -rf /tmp/y"], "模态应接管收决策");
});

test("看门狗：fund 到位（mounted 且未夹紧）不转模态", async () => {
  const {s} = makeApprovalSession({mounted: true, pinnedRows: null});
  s.showApproval("rm -rf /tmp/z", "r", "h", "high");
  await settle(300);
  assert.strictEqual(s.modals.length, 0);
  assert.strictEqual(s.discards.length, 0);
  assert.ok(!s.handled.some(e => e.kind === "approval_void"));
});

test("attach 补发去重：同命令未决期间二次 approval 不叠第二张卡", async () => {
  const {s} = makeApprovalSession({mounted: true, pinnedRows: null});
  s.showApproval("rm -rf /tmp/d", "r", "h", "high");
  await settle(30);
  s.showApproval("rm -rf /tmp/d", "r", "h", "high");   // WS 重挂补发同帧
  await settle(30);
  assert.strictEqual(
    s.handled.filter(e => e.kind === "approval").length, 1,
    "同命令补发不得叠第二张未决卡");
});

// 真机 2026-10-07 B1：审批卡被夹紧点不到，用户走 Ctrl+Enter 放行；3s 后看门狗
// 仍按「点不到」转模态，模态再点一次就发第二发决策——落到 core 下一次
// ask_decision 头上＝幽灵批准。看门狗转模态前必须认「本令已决策」。
test("看门狗不得弹幽灵模态：grace 期内已下决策就不再转模态", async () => {
  const slot = {mounted: false, pinnedRows: 1};
  const {s} = makeApprovalSession(slot);
  s.sent = [];
  s.sendJson = m => s.sent.push(m);
  s.showApproval("sc query com.docker.service", "r", "h", "high");
  await settle(30);
  assert.strictEqual(s._approvalResolved, false, "未决策前票是开的");
  // grace 期内用户按 Ctrl+Enter：走单发出口放行
  assert.strictEqual(s._sendDecision({type: "approve"},
    "sc query com.docker.service"), true);
  await settle(250);
  assert.strictEqual(s.modals.length, 0,
    "已决策后看门狗再转模态＝给已放行的命令再开一扇「批准」");
  assert.ok(!s.handled.some(e => e.kind === "approval_void"),
    "已决策不得再 void 终端卡");
  assert.strictEqual(s.sent.length, 1, "决策只发一帧");
});

test("看门狗不接顶掉的旧令：命令换了就不给旧令弹模态", async () => {
  const slot = {mounted: false, pinnedRows: 1};
  const {s} = makeApprovalSession(slot);
  s.sent = [];
  s.sendJson = m => s.sent.push(m);
  s.showApproval("rm -rf /tmp/old", "r", "h", "high");
  await settle(30);
  // 下一令顶掉旧令（core 侧已换 ask_decision）
  s.showApproval("rm -rf /tmp/new", "r", "h", "high");
  await settle(250);
  assert.ok(!s.modals.includes("rm -rf /tmp/old"),
    "旧令不得再弹模态（点下去的决策会发到下一令头上）");
});

test("_sendDecision 单发：同令第二发不落帧", async () => {
  const {s} = makeApprovalSession({mounted: true, pinnedRows: null});
  s.sent = [];
  s.sendJson = m => s.sent.push(m);
  s.showApproval("rm -rf /tmp/once", "r", "h", "high");
  await settle(30);
  assert.strictEqual(s._sendDecision({type: "approve"},
    "rm -rf /tmp/once"), true);
  assert.strictEqual(s._sendDecision({type: "approve"},
    "rm -rf /tmp/once"), false, "第二发必须被吃掉");
  assert.strictEqual(s.sent.length, 1);
  assert.strictEqual(s._approvalOpen, false, "决策后徽标必须回「AI 正在思考」");
});

test("_sendDecision 不认错令：命令串对不上不发", async () => {
  const {s} = makeApprovalSession({mounted: true, pinnedRows: null});
  s.sent = [];
  s.sendJson = m => s.sent.push(m);
  s.showApproval("rm -rf /tmp/a", "r", "h", "high");
  await settle(30);
  assert.strictEqual(s._sendDecision({type: "approve"}, "rm -rf /tmp/b"), false);
  assert.strictEqual(s.sent.length, 0, "错令的决策一帧都不许发");
});

// 徽标三态（真机 bug2 观感根因）：一路「AI 正在思考」时用户分不清「在跑命令」
// 和「假死」。工具在跑就说命令，审批优先级最高。
test("徽标三态：执行中说命令，审批优先", async () => {
  const {s, els} = makeApprovalSession({mounted: true, pinnedRows: null});
  s._cardReady = Promise.resolve();
  s._runningTool = "";
  s._taskActive = true;
  s._refreshThink();
  const badge = els.get("think-t1");
  assert.strictEqual(badge._ttext.textContent, "AI 正在思考");

  s._onAiTool({phase: "start", id: 1, name: "execute", args: "docker ps"});
  assert.strictEqual(badge._ttext.textContent, "执行中: docker ps",
    "在跑命令就得说命令，不能一路「AI 正在思考」");

  s._approvalOpen = true;   // 审批压过执行中
  s._refreshThink();
  assert.strictEqual(badge._ttext.textContent, "等待审批");

  s._approvalOpen = false;
  s._onAiTool({phase: "end", id: 1, failed: false});
  assert.strictEqual(badge._ttext.textContent, "AI 正在思考",
    "工具收尾后回到思考态");
});

test("徽标：超长命令截断，title 保留全文", async () => {
  const {s, els} = makeApprovalSession({mounted: true, pinnedRows: null});
  s._cardReady = Promise.resolve();
  s._runningTool = "";
  s._taskActive = true;
  const long = "Get-Process *docker* | Stop-Process -Force; Start-Sleep -s 3";
  s._onAiTool({phase: "start", id: 2, name: "execute", args: long});
  const badge = els.get("think-t1");
  assert.ok(badge._ttext.textContent.length < long.length,
    "徽标文案必须截断，否则状态栏被撑爆");
  assert.ok(badge._ttext.textContent.endsWith("...") ||
    badge._ttext.textContent.endsWith("…"), "截断要有省略号");
  assert.strictEqual(badge.title, "正在执行: " + long, "title 保留全文");
});
