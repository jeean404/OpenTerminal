// 通用模态框（modal.js）单测：锁住三个容易回归的语义
// ① async onClick 返回 false 不关窗（旧实现 Promise 恒 !== false，必关）；
// ② 嵌套开窗（TOFU 确认框顶掉登录框）时旧 close 不得清新窗——缺了代际号，
//    async 修复会把刚开的 TOFU 框清空，表现为「点了连接就没反应」；
// ③ Enter 提交对 input 生效、对 textarea 不生效（编辑器里 Enter 是换行）。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {modalShell} = require(path.join(__dirname, "..", "..", "src",
  "openterminal", "web", "frontend", "static", "modal.js"));

/** 最小 DOM 桩：按钮数从 innerHTML 的 data-i 认出，够测行为不必解析 DOM。
 *  按钮对象要缓存——modalShell 往上面赋 onclick，测试再取必须是同一批。 */
function makeRoot() {
  const cache = {};
  return {
    dataset: {},
    innerHTML: "",
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (sel !== ".modal-btns button") return [];
      if (cache[sel]) return cache[sel];
      const n = (this.innerHTML.match(/data-i="/g) || []).length;
      cache[sel] = Array.from({length: n}, (_, i) => {
        const btn = {dataset: {i: String(i)}};
        let fn = null;
        Object.defineProperty(btn, "onclick", {
          get: () => fn, set: (v) => { fn = v; },
        });
        return btn;
      });
      return cache[sel];
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const btns = (root) => root.querySelectorAll(".modal-btns button");

test("async onClick 返回 false 不关窗（旧实现必关）", async () => {
  const root = makeRoot();
  modalShell("删除确认", "", [
    {label: "删除", primary: true, onClick: async () => false},
    {label: "取消"},
  ], {root});
  assert.match(root.innerHTML, /删除确认/);
  btns(root)[0].onclick();
  await tick();
  assert.match(root.innerHTML, /删除确认/, "返回 false 就该把框留在原地");
});

test("同步 onClick 返回 false 仍不关窗（回归旧行为）", async () => {
  const root = makeRoot();
  modalShell("留在原地", "", [{label: "确定", primary: true, onClick: () => false}],
    {root});
  btns(root)[0].onclick();
  await tick();
  assert.match(root.innerHTML, /留在原地/);
});

test("async onClick 内再开一个 modalShell，旧 close 不清新窗", async () => {
  // TOFU 流程正是这样：登录框的「连接」里开「确认未知主机」框再 return true
  const root = makeRoot();
  modalShell("连接远程主机", "登录", [
    {label: "连接", primary: true, onClick: async () => {
      modalShell("确认未知主机", "指纹", [{label: "信任并连接", primary: true}],
        {root});
      return true;                       // 旧框想关掉自己
    }},
  ], {root});
  btns(root)[0].onclick();
  await tick();
  assert.match(root.innerHTML, /确认未知主机/,
    "新开的 TOFU 确认框必须还在，不能被旧 close 清掉");
  assert.doesNotMatch(root.innerHTML, /连接远程主机/);
});

test("input 上 Enter 触发 primary 按钮", async () => {
  const root = makeRoot();
  let fired = 0;
  modalShell("登录", "", [
    {label: "连接", primary: true, onClick: () => { fired++; }},
  ], {root});
  root.onkeydown({key: "Enter", shiftKey: false, target: {tagName: "INPUT"},
                  preventDefault() {}});
  await tick();
  assert.equal(fired, 1, "四栏表单靠 Enter 提交");
});

test("textarea 上 Enter 不提交（编辑器里是换行）", async () => {
  const root = makeRoot();
  let fired = 0;
  modalShell("编辑文件", "", [
    {label: "保存", primary: true, onClick: () => { fired++; }},
  ], {root});
  root.onkeydown({key: "Enter", shiftKey: false, target: {tagName: "TEXTAREA"},
                  preventDefault() {}});
  await tick();
  assert.equal(fired, 0, "编辑器里 Enter 是换行，不能关窗");
});

test("Shift+Enter 不提交", async () => {
  const root = makeRoot();
  let fired = 0;
  modalShell("登录", "", [
    {label: "连接", primary: true, onClick: () => { fired++; }},
  ], {root});
  root.onkeydown({key: "Enter", shiftKey: true, target: {tagName: "INPUT"},
                  preventDefault() {}});
  await tick();
  assert.equal(fired, 0);
});

test("onClick 抛异常不影响后续（不产生未处理拒绝）", async () => {
  const root = makeRoot();
  const prev = console.error;
  console.error = () => {};              // 静音预期的错误日志
  try {
    modalShell("炸", "", [
      {label: "确定", primary: true, onClick: async () => { throw new Error("x"); }},
    ], {root});
    btns(root)[0].onclick();
    await tick();
    assert.match(root.innerHTML, /炸/, "出错不该把框关掉");
  } finally {
    console.error = prev;
  }
});
