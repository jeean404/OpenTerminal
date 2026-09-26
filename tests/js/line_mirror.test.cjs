// 半行镜像光标同步回归（真机「帮我把ll设置为"ls -al"的别名」只送出去光标后
// 尾巴根因）：行内编辑（左/右方向键回引号内补内容）旧实现遇转义序列即清空
// 镜像并标 dirty，submit 只带光标后的残尾，worker 降级路径把 shell 里的真整行
// \x03 丢弃后按残尾重发——AI 收到残句。镜像改为带光标位同步后，常见行内编辑
// 产出与 readline BUFFER 一致的整行；无法镜像的序列（历史召回/Tab/带修饰键
// 方向键）仍清空 + dirty，worker 据此不拿镜像文本重发。
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

// 只跑镜像逻辑：裸对象 + 原型方法，避开 DOM/xterm 构造
function mirror() {
  const o = Object.assign(Object.create(Session.prototype),
    {_lineBuf: "", _lineCur: 0, _lineDirty: false});
  return {
    o,
    feed: (...segs) => {
      for (const s of segs) Session.prototype._feedLineBuf.call(o, s);
      return o;
    },
  };
}

test("行内方向键编辑镜像出整行（真机事故序列）", () => {
  const m = mirror();
  m.feed("帮我把ll设置为", '"', '"', "\x1b[D", "ls -al", "\x1b[C", "的别名");
  assert.strictEqual(m.o._lineBuf, '帮我把ll设置为"ls -al"的别名');
  assert.strictEqual(m.o._lineDirty, false);
});

test("退格/Delete 按光标位删除", () => {
  const m = mirror();
  m.feed("abc", "\x1b[D", "\x7f");        // 光标落在 b 后 → 删 b
  assert.strictEqual(m.o._lineBuf, "ac");
  const d = mirror();
  d.feed("abc", "\x1b[H", "\x1b[3~");     // Home + Delete → 删首字符
  assert.strictEqual(d.o._lineBuf, "bc");
});

test("Home/End/Ctrl+A/Ctrl+E 定位后插入", () => {
  const m = mirror();
  m.feed("abcd", "\x1b[H", "x", "\x1b[F", "y");
  assert.strictEqual(m.o._lineBuf, "xabcdy");
  const c = mirror();
  c.feed("abcd", "\x01", "x", "\x05", "y");
  assert.strictEqual(c.o._lineBuf, "xabcdy");
});

test("IME 整串上屏插在光标位", () => {
  const m = mirror();
  m.feed('"', '"', "\x1b[D", "ls -al");
  assert.strictEqual(m.o._lineBuf, '"ls -al"');
});

test("无法镜像的序列仍清空 + dirty（历史召回/Tab/修饰方向键）", () => {
  for (const seq of ["\x1b[A", "\x1b[B", "\t", "\x1b[1;5D", "\x15"]) {
    const m = mirror();
    m.feed("abc", seq, "尾");
    assert.strictEqual(m.o._lineBuf, "尾", seq);
    assert.strictEqual(m.o._lineDirty, true, seq);
  }
});

test("裸 ESC 与截断 CSI 不吞后续可打印输入", () => {
  const m = mirror();
  m.feed("ab", "\x1b", "cd");
  assert.strictEqual(m.o._lineDirty, true);
  assert.strictEqual(m.o._lineBuf, "cd");
});
