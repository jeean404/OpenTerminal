// 幽灵占位输入痕迹判据（真机：中文 IME 整串上屏后占位灰字仍贴在输入后）。
// 旧判据只认「单字符可打印」——IME 上屏是一次 onData 整串 CJK（length>1）、
// ↑ 历史召回是方向键序列 \x1b[A，都漏判反而走重显分支。任何含非控制字节的
// onData 都算输入痕迹；回车/纯控制键才走静默窗重显。
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

const Session = loadSessionClass();
const trace = d => Session.prototype._ghostTrace.call({}, d);

test("可打印单字符算输入痕迹（藏）", () => {
  assert.ok(trace("a"));
  assert.ok(trace("1"));
  assert.ok(trace(" "));
});

test("中文 IME 整串上屏算输入痕迹（真机漏判根因）", () => {
  assert.ok(trace("可以帮我写一个python脚本"));
  assert.ok(trace("计算器"));
});

test("方向键/编辑键序列（↑ 历史召回）算输入痕迹", () => {
  assert.ok(trace("\x1b[A"));
  assert.ok(trace("\x1b[B"));
  assert.ok(trace("\x1b[D"));
  assert.ok(trace("\x1b[3~"));   // Delete
});

test("bracketed paste 整段含可打印字节算输入痕迹", () => {
  assert.ok(trace("\x1b[200~ls -la\x1b[201~"));
});

test("回车/纯控制键不算（走静默窗重显），Backspace 算（编辑中）", () => {
  assert.ok(!trace("\r"));
  assert.ok(!trace("\x03"));     // Ctrl-C
  assert.ok(!trace("\x15"));     // Ctrl-U 清行
  assert.ok(!trace("\x1b"));     // 单独 Esc
  assert.ok(trace("\x7f"));      // Backspace：编辑输入痕迹
});
