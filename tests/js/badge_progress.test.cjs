// Phase 3 徽标：progress 心跳（1s）→ 「AI 正在思考 Ns · 已生成 M 字 · in X / out Y」。
// 后端 _seg_beat 发 {kind:"progress", chars, tokens_in, tokens_out}；前端
// _onProgress 收数并推动 _refreshThink 走字（自身无定时器）。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "app.js");

// 徽标 DOM 桩：think-{tabId} 内 .ttext 记文案。document 经 loader 形参注入
// 闭包（不是 global.document）——getElementById 必须在工厂里接线。
function makeBadgeSession() {
  const ttext = {textContent: ""};
  const badge = {hidden: false, title: "", querySelector: () => ttext};
  const fakeDoc = {
    createElement: () => ({style: {}, classList: {add() {}, remove() {}}}),
    addEventListener() {},
    getElementById: id => (id === "think-t1" ? badge
      : {onclick: null, addEventListener() {}, value: ""}),
    querySelectorAll: () => [],
    head: {appendChild() {}},
    body: {classList: {toggle() {}}},
  };
  const src = fs.readFileSync(APP, "utf8");
  const factory = new Function(
    "window", "document", "sessionStorage", "fetch", "performance", "mdLite",
    "blankRun", "rowsForPx", "padGap",
    src + "\n;return Session;");
  const ledger = require(path.join(__dirname, "..", "..", "src", "openterminal",
    "web", "frontend", "static", "pad_ledger.js"));
  const Session = factory(
    {addEventListener() {}}, fakeDoc,
    {getItem: () => null, setItem() {}, removeItem() {}},
    () => new Promise(() => {}),
    {now: () => Date.now()},
    s => s,
    ledger.blankRun, ledger.rowsForPx, ledger.padGap);
  const s = Object.create(Session.prototype);
  s._dead = false;
  s.tabId = "t1";
  s._taskActive = true;
  s._runningTool = "";
  s._approvalOpen = false;
  s._progress = {chars: 0, tokensIn: 0, tokensOut: 0};
  s._taskStartedAt = Date.now() - 12000;   // 已跑 12s
  s.paneEl = {querySelector: () => ({classList: {toggle() {}}})};
  s._el = ttext;
  return s;
}

test("progress 心跳：徽标拼「已生成 N 字 · in X / out Y」", () => {
  const s = makeBadgeSession();
  s._onProgress({kind: "progress", chars: 1234, tokens_in: 500, tokens_out: 200});
  assert.strictEqual(s._progress.chars, 1234);
  assert.ok(s._el.textContent.includes("已生成 1234 字"),
    `徽标应含字数（实得「${s._el.textContent}」）`);
  assert.ok(s._el.textContent.includes("in 500 / out 200"),
    `徽标应含 token 计数（实得「${s._el.textContent}」）`);
  assert.ok(s._el.textContent.includes("12s"),
    `思考态应含已耗秒数（实得「${s._el.textContent}」）`);
});

test("progress 缺省字段容错：0 值不炸、空载荷不动数", () => {
  const s = makeBadgeSession();
  s._onProgress({kind: "progress"});
  assert.deepStrictEqual(s._progress, {chars: 0, tokensIn: 0, tokensOut: 0});
  s._onProgress(null);
  assert.deepStrictEqual(s._progress, {chars: 0, tokensIn: 0, tokensOut: 0});
});

test("等审批/执行中三态文案也拼进度（三态统一口径）", () => {
  const s = makeBadgeSession();
  s._onProgress({kind: "progress", chars: 9, tokens_in: 1, tokens_out: 2});
  s._approvalOpen = true;
  s._refreshThink();
  assert.ok(s._el.textContent.startsWith("等待审批"));
  assert.ok(s._el.textContent.includes("已生成 9 字"));
  s._approvalOpen = false;
  s._runningTool = "ls -la";
  s._refreshThink();
  assert.ok(s._el.textContent.startsWith("执行中: ls -la"));
  assert.ok(s._el.textContent.includes("已生成 9 字"));
});
