// 密码内联捕获（初始连接讨密码与真实终端一致）：
// ① ask_password(auth_kind=password) 不弹模态——提示符直接落终端；
// ② 输入无回显、退格可改、回车整行提交；
// ③ Ctrl+C 取消整个连接尝试（发 password_cancel）；
// ④ 错密后端重讨 → 补 OpenSSH 的 "Permission denied, please try again." 行；
// ⑤ ready/closed 撤捕获；嵌套密码（nested_password）仍走模态不变。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "app.js");

function loadSessionClass() {
  const src = fs.readFileSync(APP, "utf8");
  // getElementById 用注册表：测试可检视 modal-root 的 innerHTML 与按钮回调
  const els = {};
  const fakeDoc = {
    createElement: () => ({style: {}, classList: {add() {}, remove() {}}}),
    addEventListener() {},
    querySelectorAll: () => [],
    getElementById: id => (els[id] ||= {onclick: null, addEventListener() {},
      value: "", dataset: {}, hidden: false, textContent: "", style: {},
      focus() {}, innerHTML: "",
      classList: {add() {}, remove() {}, toggle() {}},
      querySelectorAll: () => []}),
    body: {classList: {toggle() {}}},
  };
  return {Session: load(src, fakeDoc), els};

  function load(src2, doc) {
    const factory = new Function(
      "window", "document", "sessionStorage", "fetch", "performance", "mdLite",
      src2 + "\n;return Session;");
    return factory(
      {addEventListener() {}}, doc,
      {getItem: () => null, setItem() {}, removeItem() {}},
      () => new Promise(() => {}),
      {now: () => 0},
      s => s);
  }
}

function modalRoot(s) {
  // 预取注册表条目（未弹过框时 getElementById 尚未创建）
  return (s.els["modal-root"] ||= {dataset: {}, innerHTML: "",
                                   querySelectorAll: () => []});
}

function makeSession() {
  const {Session, els} = loadSessionClass();
  const s = Object.create(Session.prototype);
  s.els = els;   // DOM 注册表：检视/驱动模态框
  s._dead = false;
  s.writes = [];
  s.term = {write: data => s.writes.push(
    typeof data === "string" ? data : new TextDecoder().decode(data))};
  s.tabId = "t1";
  s.sent = [];
  s.sendJson = obj => s.sent.push(obj);
  s.ws = {readyState: 1, send: () => {}};   // 透传链的字节出口
  s._lineBuf = "";
  s._lineCur = 0;
  s._lineDirty = false;
  s._scheduleHeal = () => {};
  // handleMsg ready/closed 触碰的旁路方法打桩（focus/SVG/模型条等）
  s.setStatus = () => {};
  s._renderModelSelect = () => {};
  s.fit = () => {};
  s.focusCursor = () => {};
  return s;
}

function askPassword(s, label = "xiaojian@1.2.3.4 密码: ") {
  s.handleMsg({type: "ask_password", label, auth_kind: "password"});
}

test("ask_password 不弹模态：提示符落终端、进入捕获态", () => {
  const s = makeSession();
  askPassword(s);
  assert.ok(!s._pwCapture.submitted);
  assert.strictEqual(s.writes.join(""), "xiaojian@1.2.3.4 密码: ",
                     "空终端光标在行首：不补换行，提示符原样落屏");
});

test("输入无回显；退格删末字符；回车整行提交", () => {
  const s = makeSession();
  askPassword(s);
  s._feedData("secre");
  s._feedData("t");
  assert.strictEqual(s.writes.join(""), "xiaojian@1.2.3.4 密码: ",
                     "键入不回显");
  s._feedData("\x7f123");   // 退格删 t，再补 123 → "secre123"
  s._feedData("\r");
  assert.deepStrictEqual(s.sent, [{type: "auth", auth_kind: "password",
                                   text: "secre123", remember: false}]);
  assert.strictEqual(s.writes.join(""), "xiaojian@1.2.3.4 密码: \r\n",
                     "回车只换行");
  assert.ok(s._pwCapture.submitted, "提交后保持捕获壳（等错密重讨）");
});

test("错密重讨：补 Permission denied 行 + 新提示符，重新捕获", () => {
  const s = makeSession();
  askPassword(s);
  s._feedData("wrong\r");
  askPassword(s);
  assert.ok(s.writes.join("").includes("Permission denied, please try again."),
            "补 OpenSSH 的 denied 行");
  assert.ok(s.writes.join("").endsWith("xiaojian@1.2.3.4 密码: "));
  s._feedData("right\r");
  assert.deepStrictEqual(s.sent[1], {type: "auth", auth_kind: "password",
                                     text: "right", remember: false});
});

test("Ctrl+C 取消：发 password_cancel、退出捕获、终端见 ^C", () => {
  const s = makeSession();
  askPassword(s);
  s._feedData("partial");
  s._feedData("\x03");
  assert.deepStrictEqual(s.sent, [{type: "auth",
                                   auth_kind: "password_cancel", text: ""}]);
  assert.strictEqual(s._pwCapture, null);
  assert.ok(s.writes.join("").endsWith("^C\r\n"));
});

test("ready/closed 撤捕获：登录成功后按键走正常透传链", () => {
  const s = makeSession();
  askPassword(s);
  s._feedData("pw\r");
  s.handleMsg({type: "ready", host: "1.2.3.4", interactive: 0, models: [],
               model: "", prompt: "$"});
  assert.strictEqual(s._pwCapture, null);
  s.sent.length = 0;
  s._feedData("echo hi\r");   // 捕获已撤：普通输入不再被吞
  assert.ok(!s.sent.some(m => m.type === "auth"),
            "普通按键不得再进密码通道");
});

test("closed 同样撤捕获", () => {
  const s = makeSession();
  askPassword(s);
  s.handleMsg({type: "closed", text: "连接失败"});
  assert.strictEqual(s._pwCapture, null);
});

test("嵌套密码（nested_password）仍走模态，不进内联捕获", () => {
  const s = makeSession();
  s.handleMsg({type: "ask_password", label: "密码: ",
               auth_kind: "nested_password"});
  assert.strictEqual(s._pwCapture, undefined, "不设捕获态");
  assert.ok(!s.writes.length, "不写终端");
  // 模态路径：global modal-root 是真 DOM，摸不到——能确认的是没写终端即可
});

test("捕获态下方向键等控制序列被忽略（不进缓冲不落屏）", () => {
  const s = makeSession();
  askPassword(s);
  s._feedData("ab\x1b[Acd");
  s._feedData("\r");
  assert.deepStrictEqual(s.sent, [{type: "auth", auth_kind: "password",
                                   text: "abcd", remember: false}]);
});

test("手输密码登录成功 → ready 弹「记住」确认；点记住 → 发 password_remember", () => {
  const s = makeSession();
  askPassword(s);
  s._feedData("pw\r");
  // 预置两个假按钮让 modalShell 绑回调（0=记住 primary / 1=不记住）
  const root = modalRoot(s);
  const btns = [{dataset: {i: "0"}}, {dataset: {i: "1"}}];
  root.querySelectorAll = () => btns;
  s.handleMsg({type: "ready", host: "1.2.3.4", interactive: 0, models: [],
               model: "", prompt: "$"});
  assert.ok(root.innerHTML.includes("记住密码"), "应弹记住确认框");
  assert.strictEqual(s._pwEntered, null);
  s.sent.length = 0;
  btns[0].onclick();   // 点「记住」
  assert.deepStrictEqual(s.sent, [{type: "auth",
                                   auth_kind: "password_remember",
                                   text: ""}]);
  assert.strictEqual(root.innerHTML, "", "确认后关框");
});

test("点「不记住」→ 不发 password_remember，照常关框", () => {
  const s = makeSession();
  askPassword(s);
  s._feedData("pw\r");
  const root = modalRoot(s);
  const btns = [{dataset: {i: "0"}}, {dataset: {i: "1"}}];
  root.querySelectorAll = () => btns;
  s.handleMsg({type: "ready", host: "1.2.3.4", interactive: 0, models: [],
               model: "", prompt: "$"});
  btns[1].onclick();
  assert.ok(!s.sent.some(m => m.auth_kind === "password_remember"),
            "不记住不回 password_remember");
  assert.strictEqual(root.innerHTML, "");
});

test("非手输密码登录（凭据库自动登录）→ 不弹记住确认", () => {
  const s = makeSession();
  s.handleMsg({type: "ready", host: "1.2.3.4", interactive: 0, models: [],
               model: "", prompt: "$"});
  assert.strictEqual(modalRoot(s).innerHTML, "");
});

test("失败/取消的连接不弹记住确认", () => {
  const s = makeSession();
  askPassword(s);
  s._feedData("pw\r");
  s.handleMsg({type: "closed", text: "连接失败"});
  assert.strictEqual(s._pwEntered, null);
  assert.strictEqual(modalRoot(s).innerHTML, "");
});
