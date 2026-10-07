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
