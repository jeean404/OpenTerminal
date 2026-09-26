// 连接欢迎横幅顺序：先「已连接…」横幅，后 shell 提示符。
// 旧实现把横幅补写在首个提示符之后（还会前端补画一行提示符），视觉顺序
// 颠倒且叠出多个提示符——新实现扣住 PTY 字节，等提示符出现时先写横幅、
// 再重放「最后一次清屏之后」的字节（清屏前的字节反正会被擦掉）。
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

function makeSession() {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  s._dead = false;
  s.writes = [];
  // _releaseWelcome 重放的是 Uint8Array（xterm 原生接受），桩里解码成字符串便于断言
  s.term = {write: data => s.writes.push(
    typeof data === "string" ? data : new TextDecoder().decode(data))};
  s._welcomeText = "已连接 1.2.3.4（CentOS Stream 9）。…";
  s._welcomeNeed = "[xiaojian@VM-0-11-centos ~]$";
  s._welcomeHold = {raw: null, cleared: 0, at: 0};
  return s;
}

const CLEAR = new TextEncoder().encode("\x1b[H\x1b[2J");
const PROMPT = new TextEncoder().encode("[xiaojian@VM-0-11-centos ~]$ ");

test("横幅未落屏前 PTY 字节一律扣住不写终端", () => {
  const s = makeSession();
  // 不含提示符的普通输出：持续扣住
  const pre = new TextEncoder().encode("Last login: ...\r\n");
  assert.strictEqual(s._holdWelcome(pre), true);
  assert.strictEqual(s.writes.length, 0, "提示符出现前字节应被扣住");
});

test("提示符出现 → 先写横幅、再重放清屏之后的字节", () => {
  const s = makeSession();
  assert.strictEqual(s._holdWelcome(CLEAR), true);
  assert.strictEqual(s._holdWelcome(PROMPT), false, "提示符出现即释放");
  // 横幅在最前，其后只有清屏之后的提示符字节（清屏序列本身被丢弃）
  assert.ok(s.writes[0].includes("已连接 1.2.3.4"), "第一笔必须是横幅");
  assert.strictEqual(
    s.writes.slice(1).join(""),
    "[xiaojian@VM-0-11-centos ~]$ ",
    "清屏前的字节丢弃，提示符原样重放");
  assert.ok(!s.writes.join("").includes("\x1b[2J"), "清屏序列不得再落屏");
});

test("无清屏序列时全部字节原样重放", () => {
  const s = makeSession();
  const plain = new TextEncoder().encode("Last login: ...\r\n");
  assert.strictEqual(s._holdWelcome(plain), true);
  assert.strictEqual(s._holdWelcome(PROMPT), false);
  assert.ok(s.writes[0].includes("已连接"));
  assert.strictEqual(s.writes.slice(1).join(""), "Last login: ...\r\n[xiaojian@VM-0-11-centos ~]$ ");
});

test("提示符对不上 → 1.5s 超时释放，横幅照写、字节不丢", () => {
  const s = makeSession();
  s._welcomeNeed = "不匹配的提示符";
  const chunk = new TextEncoder().encode("weird shell output");
  assert.strictEqual(s._holdWelcome(chunk), true);
  // performance 桩恒 0：at = -2000 即已超时
  s._welcomeHold.at = -2000;
  assert.strictEqual(s._holdWelcome(new Uint8Array([0x41])), false);
  assert.ok(s.writes[0].includes("已连接"), "超时也先写横幅");
  assert.ok(s.writes.slice(1).join("").includes("weird shell output"),
            "字节不丢");
});

test("status 文案未到（1.5s 超时）→ 只重放字节、不写空横幅", () => {
  const s = makeSession();
  s._welcomeText = "";
  s._welcomeHold.at = -2000;
  assert.strictEqual(s._holdWelcome(PROMPT), false);
  assert.strictEqual(s.writes.length, 1);
  assert.strictEqual(s.writes[0], "[xiaojian@VM-0-11-centos ~]$ ");
});

test("未进入扣留态（非交互/无提示符文本）→ 字节直写", () => {
  const s = makeSession();
  s._welcomeHold = null;
  assert.strictEqual(s._holdWelcome(PROMPT), false);
  assert.strictEqual(s.writes.length, 0, "直写由 onmessage 负责，hold 不代写");
});

// P0-3 回归：扣留态必须由 ready+status 的产线路径初始化——此前 status
// 分支只记 _welcomeText 不建 _welcomeHold，横幅永不落屏、扣留机制全死。
test("产线初始化：ready(interactive) + status → 进入扣留态，提示符落屏前先写横幅", () => {
  const s = makeSession();
  // 构造器的初始态（未连上：无扣留、不等横幅）
  s._welcomeHold = null;
  s._awaitWelcome = false;
  s._welcomeText = "";
  s._welcomeNeed = "";
  // handleMsg ready/status 会触碰的旁路方法全部打桩
  s.setStatus = () => {};
  s.sendJson = () => {};
  s._renderModelSelect = () => {};
  s.setMode = () => {};
  s.fit = () => {};
  s.focusCursor = () => {};
  s.tabId = "t1";
  s.term = Object.assign(s.term, {cols: 80, rows: 24});

  s.handleMsg({type: "ready", host: "1.2.3.4", distro: "CentOS Stream 9",
               interactive: 1, prompt: "[xiaojian@VM-0-11-centos ~]$ "});
  assert.strictEqual(s._awaitWelcome, true, "interactive ready 应等横幅文案");
  assert.strictEqual(s._welcomeNeed, "[xiaojian@VM-0-11-centos ~]$");
  assert.strictEqual(s._welcomeHold, null, "ready 还不建扣留态（文案未到）");

  s.handleMsg({type: "status", text: "已连接 1.2.3.4（CentOS Stream 9）。…"});
  assert.strictEqual(s._awaitWelcome, false);
  assert.ok(s._welcomeHold, "status 必须初始化 _welcomeHold，否则横幅永不落屏");
  assert.strictEqual(s._welcomeText, "已连接 1.2.3.4（CentOS Stream 9）。…");

  // 提示符字节到达 → 释放：横幅在最前，其后是提示符
  assert.strictEqual(s._holdWelcome(PROMPT), false);
  assert.ok(s.writes[0].includes("已连接 1.2.3.4"), "第一笔必须是横幅");
  assert.strictEqual(s.writes.slice(1).join(""),
                     "[xiaojian@VM-0-11-centos ~]$ ");
});

test("产线初始化：非交互 ready → 不等横幅，status 不建扣留态", () => {
  const s = makeSession();
  s._welcomeHold = null;
  s._awaitWelcome = false;
  s.setStatus = () => {};
  s.sendJson = () => {};
  s._renderModelSelect = () => {};
  s.setMode = () => {};
  s.fit = () => {};
  s.focusCursor = () => {};
  s.tabId = "t1";
  s.term = Object.assign(s.term, {cols: 80, rows: 24});

  s.handleMsg({type: "ready", host: "1.2.3.4", interactive: 0, prompt: ""});
  assert.strictEqual(s._awaitWelcome, false);
  s.handleMsg({type: "status", text: "随便一条状态"});
  assert.strictEqual(s._welcomeHold, null, "非交互不进扣留态");
});

