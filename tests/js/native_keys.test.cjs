// 终端原生能力不被卡片层劫持的回归（用户硬性目标 3）：
// Tab 补全、↑↓ 历史翻动、Ctrl+R 反向搜索等**原生按键必须原样直通 PTY**。
//
// 两层防线：
//   ① attachCustomKeyEventHandler（xterm 唯一键钩子）只在四种情形吃键
//      （卡片选区复制 / 剪贴板 / 审批快捷键），其余一律 return true 放行——
//      Tab、↑↓、PageUp/Down、Ctrl+R 不得被拦；
//   ② _feedData 的行镜像（_feedLineBuf）只做「自然语言行」判定，镜像不可信
//      （历史召回 \x1b[A、Tab \t 等）时只丢镜像（_lineDirty），**按键字节本身
//      必须原样发进 WS/PTY**——绝不许被吞掉或改写。
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
    documentElement: {},
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
    {addEventListener() {}, getSelection: () => null}, fakeDoc,
    {getItem: () => null, setItem() {}, removeItem() {}},
    () => new Promise(() => {}),
    {now: () => Date.now()},
    s => s,
    ledger.blankRun, ledger.rowsForPx, ledger.padGap);
}

class FakeTerminal {
  constructor() {
    this.cols = 80;
    this.rows = 24;
    this.element = null;
    this.buffer = {
      active: {
        type: "normal", baseY: 0, cursorY: 0, cursorX: 0, viewportY: 0,
        getLine: () => ({translateToString: () => ""}),
      },
    };
    this.buffer.normal = this.buffer.active;
  }
  loadAddon() {}
  open() {}
  onData(fn) { this._onData = fn; }
  onResize(fn) { this._onResize = fn; }
  onSelectionChange(fn) { this._onSelectionChange = fn; }
  attachCustomKeyEventHandler(fn) { this._keyHandler = fn; }
  hasSelection() { return false; }
  getSelection() { return ""; }
  write() {}
  refresh() {}
  focus() {}
  dispose() {}
  scrollToBottom() {}
  registerMarker() { return {line: 0, onDispose() {}, dispose() {}}; }
  registerDecoration() { return {onRender() {}, dispose() {}}; }
}

// 建一个跑到「键钩子已挂上」的会话：stub Terminal/FitAddon/getComputedStyle
function makeKeySession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s.tabId = "t1";
  s.mode = "agent";
  s._taskActive = false;
  s._pwCapture = null;
  s._lineBuf = "";
  s._lineCur = 0;
  s._lineDirty = false;
  s._lastSendAt = 0;
  s._ghostEl = null;
  s._ghostDec = null;
  const input = {
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
  const fakeEl = {
    insertAdjacentHTML() {},
    classList: {add() {}, remove() {}, toggle() {}, contains: () => false},
    style: {},
    querySelector: selector => selector === ".xterm-helper-textarea" ? input : null,
    querySelectorAll: () => [],
    onclick: null,
  };
  s.paneEl = {querySelector: () => fakeEl, querySelectorAll: () => []};
  global.Terminal = FakeTerminal;
  global.FitAddon = {FitAddon: class { fit() {} }};
  global.getComputedStyle = () => ({getPropertyValue: () => ""});
  global.ResizeObserver = class { observe() {} disconnect() {} };
  s._buildTerm();
  clearInterval(s._ghostTimer);
  clearInterval(s._wdTimer);
  s.sent = [];
  s.ws = {
    readyState: 1,
    send: d => {
      s.sent.push(typeof d === "string" ? d : new TextDecoder().decode(d));
    },
  };
  s.sendJson = obj => { s.sent.push(JSON.stringify(obj)); };
  return s;
}

const key = (k, mods = {}) => Object.assign({
  type: "keydown", key: k, ctrlKey: false, shiftKey: false,
  altKey: false, metaKey: false, isComposing: false, preventDefault() {},
}, mods);

test("IME 组合期间与提交后产生的 Tab 字节不透传，普通补全恢复", async () => {
  const s = makeKeySession();
  const input = s.paneEl.querySelector().querySelector(".xterm-helper-textarea");
  input.listeners.compositionstart();
  assert.strictEqual(s.term._keyHandler(key("Process", {keyCode: 229})), true,
    "229/Process 必须交给 xterm 更新组合输入框");
  assert.strictEqual(s.term._keyHandler(key("Tab")), true,
    "候选 Tab 也要让 xterm 完成当前组合");
  s.term._onData("\t\t");
  assert.deepStrictEqual(s.sent, [], "组合期间的 Tab 字节不能进入 PTY");
  input.listeners.compositionend({data: "中"});
  assert.strictEqual(s.term._keyHandler(key("Tab")), true,
    "紧随候选提交的 Tab 应由字节过滤器处理");
  s.term._onData("\t");
  assert.deepStrictEqual(s.sent, [], "提交后的候选 Tab 不能进入 PTY");
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.strictEqual(s.term._keyHandler(key("Tab")), true,
    "组合结束后的正常 Tab 补全仍应透传");
  s.term._onData("\t");
  assert.deepStrictEqual(s.sent, ["中", "\t"],
    "组合文本应发送，普通 Tab 补全仍应进入 PTY");
});

test("IME compositionend 提交在 Enter 前透传，延迟的 xterm 提交不重复发送", async () => {
  const s = makeKeySession();
  const input = s.paneEl.querySelector().querySelector(".xterm-helper-textarea");
  input.listeners.compositionend({data: "中文"});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepStrictEqual(s.sent, ["中文"]);

  s.term._onData("中文");
  assert.deepStrictEqual(s.sent, ["中文"]);
});

test("IME insertFromComposition 在 compositionend 前可提交，不等 Enter", async () => {
  const s = makeKeySession();
  const input = s.paneEl.querySelector().querySelector(".xterm-helper-textarea");
  input.listeners.beforeinput({
    inputType: "insertFromComposition",
    data: "已选中文",
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepStrictEqual(s.sent, ["已选中文"]);

  input.listeners.compositionend({data: "已选中文"});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepStrictEqual(s.sent, ["已选中文"],
    "同一次 IME 提交不能因 compositionend 再发送一次");
});

test("原生按键直通：Tab/↑↓/PageUp/PageDown/Ctrl+R 不被键钩子拦截", () => {
  const s = makeKeySession();
  const h = s.term._keyHandler;
  assert.ok(typeof h === "function", "键钩子应挂在 xterm 上");
  for (const ev of [
    key("Tab"), key("ArrowUp"), key("ArrowDown"),
    key("PageUp"), key("PageDown"), key("Home"), key("End"),
    key("r", {ctrlKey: true}),          // 反向搜索
    key("c", {ctrlKey: true}),          // 无选区时 ^C 中断照发（不拦）
    key("u", {ctrlKey: true}),          // 杀行
  ]) {
    assert.strictEqual(h(ev), true,
      `键 ${ev.key}${ev.ctrlKey ? "+Ctrl" : ""} 必须放行给 xterm→PTY`);
  }
});

test("审批快捷键只在有活审批卡时吃键：闲时 Ctrl+Enter/Backspace/e 直通", () => {
  const s = makeKeySession();
  const h = s.term._keyHandler;
  // 无 feed（卡片层未起）：审批键不得拦截
  assert.strictEqual(h(key("Enter", {ctrlKey: true})), true);
  assert.strictEqual(h(key("Backspace", {ctrlKey: true})), true);
  assert.strictEqual(h(key("e", {ctrlKey: true})), true);
  // 有 feed 但无 armed 卡：同样不拦
  s._feed = {handle: () => false};
  assert.strictEqual(h(key("Enter", {ctrlKey: true})), true);
  // armed 卡接走：这才允许拦截（返回 false 阻止发进 PTY）
  s._feed = {handle: () => true};
  assert.strictEqual(h(key("Enter", {ctrlKey: true})), false);
});

test("历史召回 ↑/↓ 的转义序列原样发进 WS（只丢行镜像，不吞键）", () => {
  const s = makeKeySession();
  s._feedData("\x1b[A");
  assert.deepStrictEqual(s.sent, ["\x1b[A"], "↑ 序列必须原样发进 PTY");
  assert.strictEqual(s._lineDirty, true, "镜像不可信（历史召回）→ 丢镜像");
  s.sent.length = 0;
  s._feedData("\x1b[B");
  assert.deepStrictEqual(s.sent, ["\x1b[B"], "↓ 序列必须原样发进 PTY");
});

test("Tab 补全字节原样发进 WS（镜像丢弃不改写按键）", () => {
  const s = makeKeySession();
  s._feedData("\t");
  assert.deepStrictEqual(s.sent, ["\t"], "Tab 必须原样发进 PTY（补全由 shell 做）");
  assert.strictEqual(s._lineDirty, true, "镜像丢弃（补全结果不可预测）");
  // 混合序列：打字 + Tab 补全 + 继续打字——字节序列不得被吞改
  s.sent.length = 0;
  s._lineDirty = false;
  s._feedData("gi");
  s._feedData("\t");
  s._feedData("t");
  assert.deepStrictEqual(s.sent, ["gi", "\t", "t"]);
});

test("方向键左右移动光标维持镜像（不误伤行内编辑），命令行不被改写", () => {
  const s = makeKeySession();
  s._feedData("echo");
  s._feedData("\x1b[D");   // ← 光标左移
  s._feedData("X");        // 插入
  assert.strictEqual(s._lineBuf, "echXo", "行内编辑镜像正确");
  assert.deepStrictEqual(s.sent, ["echo", "\x1b[D", "X"], "字节原样透传");
});
