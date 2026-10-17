// 文件面板（files_panel.js）单测：纯函数 + 列表交互 + 工具栏契约。
//
// 交互部分用最小 DOM 桩（createElement 返回可挂 onclick/appendChild 的对象）
// ——不解析 HTML，只够驱动 _render 的行为；全局 esc 由测试注入。
"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PANEL = path.join(__dirname, "..", "..", "src", "openterminal", "web",
  "frontend", "static", "files_panel.js");
const {_test, FilePanel} = require(PANEL);

// --- 纯函数 ---------------------------------------------------------------

test("join 相对路径直接落名，绝对路径 posix 拼接", () => {
  assert.equal(_test.join(".", "a.txt"), "a.txt");
  assert.equal(_test.join(null, "a.txt"), "a.txt");
  assert.equal(_test.join("/srv", "a.txt"), "/srv/a.txt");
  assert.equal(_test.join("/srv/", "a.txt"), "/srv/a.txt");
});

test("fmtSize 档位与空值", () => {
  assert.equal(_test.fmtSize(null), "");
  assert.equal(_test.fmtSize(512), "512 B");
  assert.equal(_test.fmtSize(2048), "2.0 KiB");
  assert.equal(_test.fmtSize(3 * 1024 * 1024), "3.0 MiB");
});

test("crumbTargets 每级自带 path（回归：闭包捕获 acc 致中段回退全指向末级）", () => {
  const t = FilePanel.prototype._crumbTargets("/home/testuser/ot_test_dir");
  assert.deepEqual(t, [
    {label: "/", path: "/"},
    {label: "home", path: "/home"},
    {label: "testuser", path: "/home/testuser"},
    {label: "ot_test_dir", path: "/home/testuser/ot_test_dir"},
  ]);
});

test("crumbTargets 相对路径返回 null（面板显示纯文本）", () => {
  assert.equal(FilePanel.prototype._crumbTargets("."), null);
  assert.equal(FilePanel.prototype._crumbTargets(""), null);
});

test("_url 不再有 via 维度（面板只有一条自己的直连）", () => {
  const fp = FilePanel.prototype;
  assert.equal(fp._url.call({tabId: "t1"}, "list", {path: "/srv"}),
    "/api/tabs/t1/files/list?path=%2Fsrv");
  assert.equal(fp._url.call({tabId: "t1"}, "state"),
    "/api/tabs/t1/files/state?");
  assert.equal(fp._api.call({tabId: "t1", _url: fp._url}, "connect"),
    "/api/tabs/t1/files/connect?");
});

test("_url 上传把文件名放进 query（服务端按它剥目录成分）", () => {
  const up = FilePanel.prototype._url.call({tabId: "t1"}, "upload",
    {path: "/srv", name: "hello 世界.txt"});
  assert.equal(up,
    "/api/tabs/t1/files/upload?path=%2Fsrv&name=hello+%E4%B8%96%E7%95%8C.txt");
});

test("连接徽标：默认端口不显示，非默认端口带 :port", () => {
  const fn = FilePanel.prototype._connLabel;
  assert.equal(fn.call({_conn: {host: "h", user: "root", port: 22}}), "root@h");
  assert.equal(fn.call({_conn: {host: "h", user: "root", port: 2223}}),
    "root@h:2223");
  assert.equal(fn.call({_conn: {host: "h", user: null, port: null}}), "h");
  assert.equal(fn.call({_conn: null}), "");
});

test("面板不跟终端 cwd：跟随入口应已移除", () => {
  // 面板与终端是两套独立机制——前端不许自己去读终端目录再拼路径
  const fp = FilePanel.prototype;
  assert.equal(typeof fp.noteTraffic, "undefined", "跟随入口应已移除");
  assert.equal(typeof fp._syncTermPath, "undefined", "跟随刷新应已移除");
  assert.equal(typeof fp.gotoTermCwd, "undefined", "跟随按钮应已移除");
  assert.equal(typeof fp._align, "undefined", "自动对齐已随 /adopt 删除");
  assert.equal(typeof fp._manual, "undefined", "手选身份补丁已删");
  assert.equal(typeof fp._setBackend, "undefined", "via 维度已收敛成单一连接");
});

// --- 列表交互 -------------------------------------------------------------

function makeEl(tag = "div") {
  const el = {
    tagName: tag, children: [], className: "", textContent: "", innerHTML: "",
    title: "", style: {}, dataset: {}, hidden: false, value: "",
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
    // 递归收集（真实 DOM 的 querySelectorAll 就是递归查后代）
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          if (sel === ".fp-row" && /fp-row/.test(c.className)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    addEventListener() {}, focus() {},
  };
  return el;
}

function makePanel(cwd = "/srv") {
  global.esc = (s) => String(s == null ? "" : s);
  // _render 用 document.createElement 造行/按钮
  global.document = {
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({textContent: t}),
  };
  const list = makeEl(), crumbs = makeEl(), badge = makeEl("span");
  const bySel = (sel) => (sel === ".fp-list" ? list
    : sel === ".fp-path" ? crumbs
    : sel === ".fp-badge" ? badge : null);
  const el = makeEl();
  el.querySelector = bySel;
  const pane = makeEl();
  pane.querySelector = bySel;
  const fp = Object.create(FilePanel.prototype);
  fp.el = el;
  fp.pane = pane;
  fp.cwd = cwd;
  fp._selected = null;
  fp.loadCalls = [];
  fp.editCalls = [];
  fp.dlCalls = [];
  fp.load = (p) => { fp.loadCalls.push(p); };
  fp.edit = (n, p) => { fp.editCalls.push([n, p]); };
  fp.download = (n, p) => { fp.dlCalls.push([n, p]); };
  return {fp, list, crumbs, badge};
}

const ENTRIES = [
  {name: "sub", is_dir: true},
  {name: "a.txt", is_dir: false, size: 1, mtime: 1},
];

test("单击只选中，不触发下载/进入（需求 4）", () => {
  const {fp, list} = makePanel();
  fp._render(ENTRIES);
  assert.equal(list.children.length, 2);
  list.children[1].onclick();
  assert.equal(fp._selected, "a.txt");
  assert.ok(list.children[1].classList.contains("active"));
  assert.equal(fp.loadCalls.length, 0, "单击不许进目录");
  assert.equal(fp.dlCalls.length, 0, "单击不许下载——下载是独立按钮");
  // 再点目录行：选中要切过去
  list.children[0].onclick();
  assert.equal(fp._selected, "sub");
  assert.ok(list.children[0].classList.contains("active"));
  assert.ok(!list.children[1].classList.contains("active"));
});

test("双击目录进入、双击文件打开编辑器", () => {
  const {fp, list} = makePanel();
  fp._render(ENTRIES);
  list.children[0].ondblclick();
  assert.deepEqual(fp.loadCalls, ["/srv/sub"], "双击目录进入");
  list.children[1].ondblclick();
  assert.deepEqual(fp.editCalls, [["a.txt", "/srv/a.txt"]], "双击文件打开");
  assert.equal(fp.dlCalls.length, 0);
});

test("文件行有独立的 ⬇ 下载按钮，目录行没有（SFTP 无原生打包）", () => {
  const {fp, list} = makePanel();
  fp._render(ENTRIES);
  const titles = (row) => row.children[row.children.length - 1].children
    .map((b) => b.title);
  assert.ok(titles(list.children[1]).includes("下载"), "文件行要能下载");
  assert.ok(!titles(list.children[0]).includes("下载"), "目录不给下载按钮");
  // 点下载按钮：走 download，且不触发行的 onclick
  const dlBtn = list.children[1].children[list.children[1].children.length - 1]
    .children[0];
  dlBtn.onclick({stopPropagation() {}});
  assert.deepEqual(fp.dlCalls, [["a.txt", "/srv/a.txt"]]);
  assert.equal(fp._selected, null, "行内按钮不该改变选中");
});

test("选中态在 _render 重渲染后回填（不回填就闪没了）", () => {
  const {fp, list} = makePanel();
  fp._render(ENTRIES);
  list.children[1].onclick();
  assert.equal(fp._selected, "a.txt");
  fp._render(ENTRIES);                    // 刷新整表重建
  assert.ok(list.children[1].classList.contains("active"),
    "刷新后选中必须还在");
  assert.ok(!list.children[0].classList.contains("active"));
});

test("工具栏图标按钮都带 title 悬浮提示（防只换图标没加提示）", () => {
  const src = fs.readFileSync(PANEL, "utf8");
  for (const act of ["close", "home", "link", "mkdir", "create", "refresh",
                     "pick"]) {
    assert.match(src, new RegExp(`data-act="${act}"[^>]*title="[^"]+"`),
      `data-act=${act} 必须带 title`);
  }
  // 文字按钮应已换成图标（含中文按钮文案即为未改造）
  for (const gone of ["＋目录", "＋文件", "⌂ 家目录", "⇄ 主机"]) {
    assert.ok(!src.includes(gone), `文字按钮「${gone}」应已换成图标`);
  }
});

test("登录成功后 cwd 归 null → 下一次列目录落登录用户的家目录（需求 3）", () => {
  // _connect 里 this.cwd = null，open()/load(".") 才会用服务端的 home
  const src = fs.readFileSync(PANEL, "utf8");
  assert.match(src, /this\.cwd = null;\s*\/\/ 需求 3/,
    "登录成功必须重置目录上下文，不许沿用旧目标的目录");
});

test("弹框默认值取终端最终服务器，密码栏恒空（需求 1）", () => {
  const src = fs.readFileSync(PANEL, "utf8");
  assert.match(src, /const host = cur\.host \|\| d\.host/,
    "IP 预填终端最终服务器");
  assert.match(src, /autocomplete="new-password"/, "密码栏不预填明文");
  assert.match(src, /记住密码/, "要有记住密码选项");
});
