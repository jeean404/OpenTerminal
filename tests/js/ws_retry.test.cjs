// WS 重连收束回归（真机「总是 403」根因）。
//
// 现象：服务重启后浏览器拿旧 tabId 无限重连，日志三连
//   "WebSocket /ws/81592eea" 403 / connection rejected (403 Forbidden)
//
// 根因两段：
//   ① 服务端在 accept() 之前 close(4401/4404)，uvicorn 把它翻成握手 403
//      空 body，关闭码到不了客户端（见 server.py _reject_ws）；
//   ② 前端 onclose 靠 ev.code !== 4401 && ev.code !== 4404 判死，但客户端
//      只拿得到 1006，判死条件永不生效 → 无限重连。
//
// 不变量（**不得回归**）：真·断线（服务端无响应）必须继续不限次数退避重连。
// 旧实现 8 次封顶会让页面永久冻结在「连接已关闭」（真机截图二），
// 见 app.js _scheduleWsRetry 注释——本文件把这条一起钉死。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "app.js");

function loadSessionClass(fetchImpl) {
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
    fetchImpl,
    {now: () => Date.now()},
    s => s,
    ledger.blankRun, ledger.rowsForPx, ledger.padGap);
}

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    FakeWS.last = this;
  }
  send() {}
  close() {}
}

// 真实 connectWS（要测的判死条件在它的 onclose 闭包里），外包一层计数
function makeSession(fetchImpl) {
  const Session = loadSessionClass(fetchImpl);
  const s = Object.create(Session.prototype);
  s._dead = false;
  s.tabId = "deadbeef";
  s._wsRetryT = null;
  s._wsRetries = 0;
  s.statuses = [];
  s.connects = 0;
  s.setStatus = (k, t) => { s.statuses.push(t); };
  const realConnect = Session.prototype.connectWS;
  s.connectWS = function (...args) {
    s.connects++;
    return realConnect.apply(this, args);
  };
  return s;
}

function prime() {
  global.WebSocket = FakeWS;
  global.location = {protocol: "http:", host: "127.0.0.1:8177"};
}

test("4404（tab 已回收）：判死不重连，并给出可行动的收束", () => {
  prime();
  const s = makeSession(() => new Promise(() => {}));
  s.connectWS();                                  // 首连：1
  FakeWS.last.onopen();
  FakeWS.last.onclose({code: 4404, wasClean: true});
  assert.strictEqual(s.connects, 1, "4404 不得再连第二次");
  assert.strictEqual(s.statuses.at(-1), "会话已失效，请从左侧重新连接");
});

test("4401（鉴权失败）：判死不重连，提示刷新", () => {
  prime();
  const s = makeSession(() => new Promise(() => {}));
  s.connectWS();
  FakeWS.last.onopen();
  FakeWS.last.onclose({code: 4401, wasClean: true});
  assert.strictEqual(s.connects, 1, "4401 不得再连第二次");
  assert.strictEqual(s.statuses.at(-1), "访问令牌无效，请刷新页面");
});

test("没握上手 + 服务端还活着：会话已随重启消失，停止空转", async () => {
  prime();
  // fetch 有响应 = 服务端活着（401 也算，见 _serverAlive）
  const s = makeSession(() => Promise.resolve({status: 401}));
  s.connectWS();
  FakeWS.last.onclose({code: 1006, wasClean: false});   // 没 onopen = 没握上手
  await new Promise(r => setTimeout(r, 700));           // 退避 500ms 后应已判死
  assert.strictEqual(s.connects, 1, "服务端活着却拒握手 = tab 没了，不得再连");
  assert.strictEqual(s.statuses.at(-1), "会话已失效，请从左侧重新连接");
});

test("没握上手 + 服务端无响应：真·断线，继续不限次数重连", async () => {
  prime();
  // fetch 抛网络错 = 服务端不在：这是「不限次数」不变量的守卫
  const s = makeSession(() => Promise.reject(new Error("down")));
  s.connectWS();
  FakeWS.last.onclose({code: 1006, wasClean: false});
  await new Promise(r => setTimeout(r, 700));
  assert.strictEqual(s.connects, 2, "服务端无响应必须继续重连（不许封顶停手）");
});
