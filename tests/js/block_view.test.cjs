"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BlockView, ansiToHtml, stripAnsi,
} = require("../../src/openterminal/web/frontend/static/block_view.js");
const { BlockStream } =
  require("../../src/openterminal/web/frontend/static/block_stream.js");

/* ── ANSI ─────────────────────────────────────────────── */

test("ansiToHtml：颜色/粗体/暗淡都落到 span 上", () => {
  const h = ansiToHtml("\x1b[32mok\x1b[0m \x1b[1;31merr\x1b[0m \x1b[2mdim\x1b[0m");
  assert.match(h, /color:#4ade80/);
  assert.match(h, /font-weight:600/);
  assert.match(h, /color:#f87171/);
  assert.match(h, /opacity:\.62/);
  assert.match(h, />ok</);
  assert.match(h, />err</);
  assert.match(h, />dim</);
});

test("ansiToHtml：控制序列丢弃，文本转义（不能注入标签）", () => {
  const h = ansiToHtml("\x1b[2J\x1b[K\x1b[10;20H<script>alert(1)</script> & 'x'");
  assert.ok(!/\x1b/.test(h), "控制序列不能漏进 HTML");
  assert.ok(!/<script>/.test(h), "用户文本必须转义");
  assert.match(h, /&lt;script&gt;/);
  assert.match(h, /&amp;/);
});

test("ansiToHtml：256 色与真彩色", () => {
  assert.match(ansiToHtml("\x1b[38;5;196mX\x1b[0m"), /color:rgb\(/);
  assert.match(ansiToHtml("\x1b[38;2;12;34;56mX\x1b[0m"), /color:rgb\(12,34,56\)/);
});

test("stripAnsi：剥掉所有转义，留纯文本", () => {
  assert.equal(stripAnsi("\x1b[32mhello\x1b[0m\r\n"), "hello\r\n");
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(stripAnsi(""), "");
});

/* ── 最小 fake DOM ────────────────────────────────────── */
// 按真实 DOM 的 API 面建模：ownerDocument / children / classList / dataset。
// 少一个字段就会把「桩不够」误报成产品 bug（见 fake-must-mirror-real-sdk-api）。
function makeDoc() {
  const doc = {};
  function El(tag) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.innerHTML = "";
    this.textContent = "";
    this._host = null;
    this._body = null;
    this._text = undefined;
    const self = this;
    this.classList = {
      _s: new Set(),
      add(c) { this._s.add(c); self.className = [...this._s].join(" "); },
      remove(c) { this._s.delete(c); self.className = [...this._s].join(" "); },
      toggle(c, on) {
        if (on === undefined) on = !this._s.has(c);
        if (on) this._s.add(c); else this._s.delete(c);
        self.className = [...this._s].join(" ");
        return on;
      },
      contains(c) { return this._s.has(c); },
    };
  }
  El.prototype.appendChild = function (n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this; this.children.push(n); return n;
  };
  El.prototype.removeChild = function (n) {
    const i = this.children.indexOf(n);
    if (i >= 0) { this.children.splice(i, 1); n.parentNode = null; }
    return n;
  };
  El.prototype.insertBefore = function (n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    n.parentNode = this;
    return n;
  };
  El.prototype.addEventListener = function () {};
  doc.createElement = t => new El(t);
  return doc;
}

function mkView() {
  const doc = makeDoc();
  const container = doc.createElement("div");
  const mounted = [];
  const feed = {
    mount(id) { mounted.push(id); },
    unmount() {},
    destroy() {},
  };
  const view = new BlockView(container, { feed, follow: false });
  return { doc, container, view, mounted };
}

test("sync：按块序排布，卡片块与文本块平级", () => {
  const { container, view } = mkView();
  const s = new BlockStream();
  s.append({ id: "cmd-1", kind: "term", payload: { text: "hello\nworld" } });
  s.append({ id: "card-1", kind: "card" });
  s.append({ id: "cmd-2", kind: "term", payload: { text: "after" } });
  view.sync(s.list());

  assert.deepEqual(container.children.map(c => c.dataset.blockId),
    ["cmd-1", "card-1", "cmd-2"]);
  assert.ok(container.children[1]._host, "卡片块必须给 React island 一个宿主");
});

test("sync：节点按 id 复用，不重建（重建会拆 React root 闪烁）", () => {
  const { container, view } = mkView();
  const s = new BlockStream();
  s.append({ id: "cmd-1", kind: "term", payload: { text: "a" } });
  s.append({ id: "card-1", kind: "card" });
  view.sync(s.list());
  const first = container.children.map(c => c.dataset.blockId).join(",");

  s.update("cmd-1", { payload: { text: "a updated" } });
  view.sync(s.list());
  assert.equal(container.children.map(c => c.dataset.blockId).join(","), first);
  assert.equal(container.children[0]._body.innerHTML, "a updated",
    "内容原地更新，节点不变");
});

test("sync：insertAfter 的输出落到自己的卡下面（并行工具不串）", () => {
  const { container, view } = mkView();
  const s = new BlockStream();
  s.append({ id: "card-1", kind: "card" });
  s.append({ id: "card-2", kind: "card" });
  s.append({ id: "card-3", kind: "card" });
  view.sync(s.list());

  s.insertAfter("card-1", { id: "out-1", kind: "term", payload: { text: "OUT1" } });
  s.insertAfter("card-2", { id: "out-2", kind: "term", payload: { text: "OUT2" } });
  view.sync(s.list());

  assert.deepEqual(container.children.map(c => c.dataset.blockId),
    ["card-1", "out-1", "card-2", "out-2", "card-3"]);
  assert.equal(container.children[1]._body.innerHTML, "OUT1");
  assert.equal(container.children[3]._body.innerHTML, "OUT2");
});

test("sync：删块就删节点，不留半截", () => {
  const { container, view } = mkView();
  const s = new BlockStream();
  s.append({ id: "a", kind: "card" });
  s.append({ id: "b", kind: "card" });
  view.sync(s.list());
  assert.equal(container.children.length, 2);
  s.remove("a");
  view.sync(s.list());
  assert.deepEqual(container.children.map(c => c.dataset.blockId), ["b"]);
});

test("卡片宿主只挂一次（重复 mount 会让 React root 来回迁）", () => {
  const { view, mounted } = mkView();
  const s = new BlockStream();
  s.append({ id: "card-1", kind: "card" });
  view.sync(s.list());
  view.sync(s.list());
  view.sync(s.list());
  assert.deepEqual(mounted, ["card-1"]);
});

test("过渡段有紫标注类，内容照常（不是空框）", () => {
  const { container, view } = mkView();
  const s = new BlockStream();
  s.append({ id: "t1", kind: "transition",
    payload: { text: "Last login: Sat Oct 17\nWelcome to Ubuntu" } });
  view.sync(s.list());
  const el = container.children[0];
  assert.ok(el.classList.contains("ot-transition"));
  assert.match(el._body.innerHTML, /Last login/);
  assert.match(el._body.innerHTML, /Welcome to Ubuntu/);
});
