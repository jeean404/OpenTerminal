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

test("续传标识由文件路径和属性稳定生成，不依赖会话或浏览器存储", () => {
  const oldStorage = Object.getOwnPropertyDescriptor(global, "localStorage");
  const oldCrypto = Object.getOwnPropertyDescriptor(global, "crypto");
  const values = new Map();
  Object.defineProperty(global, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  Object.defineProperty(global, "crypto", {
    configurable: true,
    value: require("node:crypto").webcrypto,
  });
  try {
    const panel = {_conn: {host: "server", port: 22, user: "alice"},
      _toast() {}};
    const file = {name: "archive.bin", size: 1024, lastModified: 1234};
    const first = FilePanel.prototype._upId.call(panel, {
      dir: "/srv", file,
    });
    const resumed = FilePanel.prototype._upId.call(panel, {
      dir: "/srv", file,
    });
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.equal(resumed, first);

    const otherSession = {
      tabId: "new-session",
      _conn: {host: "other-server", port: 2200, user: "bob"},
      _toast() {},
    };
    Object.defineProperty(global, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => { throw new Error("storage unavailable"); },
      },
    });
    const afterReconnect = FilePanel.prototype._upId.call(otherSession, {
      dir: "/srv", file,
    });
    assert.equal(afterReconnect, first);
  } finally {
    if (oldStorage) Object.defineProperty(global, "localStorage", oldStorage);
    else delete global.localStorage;
    if (oldCrypto) Object.defineProperty(global, "crypto", oldCrypto);
    else delete global.crypto;
  }
});

test("上传从服务端已有偏移开始，并在完成后清除续传标识", async () => {
  const globals = ["localStorage", "crypto", "authFetch", "getToken",
    "XMLHttpRequest"];
  const saved = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(global, key)]));
  const values = new Map();
  const sent = [];
  const leases = [];
  Object.defineProperty(global, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  Object.defineProperty(global, "crypto", {
    configurable: true,
    value: require("node:crypto").webcrypto,
  });
  global.getToken = () => "";
  global.authFetch = async (url) => {
    const parsed = new URL(url, "http://test");
    if (parsed.pathname.endsWith("/upload/status"))
      return {ok: true, json: async () => ({offset: 2})};
    if (parsed.pathname.endsWith("/upload/lease")) {
      leases.push(parsed.searchParams.get("active"));
      return {ok: true, json: async () => ({ok: true})};
    }
    assert.equal(parsed.pathname.endsWith("/upload/complete"), true);
    return {ok: true, json: async () => ({ok: true})};
  };
  global.XMLHttpRequest = class {
    constructor() { this.upload = {}; }
    open(_method, url) { this.url = url; }
    setRequestHeader() {}
    send(body) {
      const parsed = new URL(this.url, "http://test");
      const offset = Number(parsed.searchParams.get("offset"));
      sent.push({offset, data: body});
      this.status = 200;
      this.responseText = JSON.stringify({offset: offset + body.size});
      this.onload();
    }
  };
  try {
    const panel = Object.create(FilePanel.prototype);
    panel.tabId = "current-tab";
    panel._conn = {host: "server", port: 22, user: "alice"};
    panel._toast = () => {};
    panel._upPaint = () => {};
    panel._upEnd = () => {};
    const file = new Blob(["abcde"]);
    Object.defineProperties(file, {
      name: {value: "resume.bin"},
      lastModified: {value: 1234},
    });
    const item = {file, dir: "/srv", state: "running", xhr: null, row: null};
    await panel._upRun(item);
    assert.equal(item.state, "done");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].offset, 2);
    assert.equal(sent[0].data.size, 3);
    assert.deepEqual(leases, ["true", "false"]);
    assert.equal(values.size, 0);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(global, key, descriptor);
      else delete global[key];
    }
  }
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

test("文件行有独立的下载按钮，目录行没有（SFTP 无原生打包）", () => {
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
  for (const act of ["close", "home", "mkdir", "create", "refresh",
                     "pick"]) {
    assert.match(src, new RegExp(`data-act="${act}"[^>]*title="[^"]+"`),
      `data-act=${act} 必须带 title`);
  }
  // 文字按钮应已换成图标（含中文按钮文案即为未改造）
  for (const gone of ["＋目录", "＋文件", "⌂ 家目录", "⇄ 主机"]) {
    assert.ok(!src.includes(gone), `文字按钮「${gone}」应已换成图标`);
  }
  // 图标一律实体图标：⌂ ＋ ⟳ ⬆ 这类字符在按钮里像键盘按键，看不出是功能
  const solid = {home: "🏠", mkdir: "📁", create: "📄", refresh: "🔄", pick: "📤"};
  for (const [act, ico] of Object.entries(solid)) {
    assert.match(src, new RegExp(`data-act="${act}"[^>]*>${ico}</button>`),
      `data-act=${act} 要用实体图标 ${ico}`);
  }
  assert.match(src, /_actBtn\("📥", _t\("下载"\)/, "下载也用实体图标");
  // 连接设置入口已去掉：面板靠终端记住的密码自动连
  assert.ok(!src.includes('data-act="link"'), "不该再有连接设置按钮");
  assert.match(src, /手动连接/, "无凭据空态要留手动连接入口");
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

// --- 会话收束：定时器泄漏（真机 404 刷屏回归）-----------------------------
//
// 现象：关掉 tab（或断线宽限期后被服务端 reap）之后，日志每 1～2 秒刷一条
//   "GET /api/tabs/<tabId>/files/state" 404 Not Found
// 一直刷到用户刷新页面才停。
//
// 根因是两条定时链都不跟会话一起死：
//   ① _startFollow 的 2 秒 _followTick，404 被 `if (!r.ok) return` 吞掉，
//      setInterval 照跑；
//   ② _fetchState 把 404 当「连接未就绪」走 _pending 退避重试，无限排下一轮。
// Session.close() 清了别的定时器，却没碰 filesPanel。
//
// 不变量（**不得回归**）：真·网络抖动必须继续退避重试，绝不能因为这层守卫
// 把面板冻死；终端身份没变时的跟随轮询必须继续跑。

function barePanel() {
  global.esc = (s) => String(s == null ? "" : s);
  const fp = Object.create(FilePanel.prototype);
  fp.tabId = "t1";
  fp.el = {hidden: false, querySelector: () => ({innerHTML: ""})};
  fp.pane = {classList: {toggle() {}, remove() {}}};
  fp.cwd = null;
  fp._conn = null;
  fp._defaults = null;
  fp._selected = null;
  fp._seq = 0;
  fp._stateSeq = 0;
  fp._retryT = null;
  fp._wantOpen = false;
  fp._retryWait = 0;
  fp._connecting = false;
  fp._followKey = "";
  fp._pendKey = "";
  fp._followT = null;
  fp._dead = false;
  return fp;
}

test("dispose() 收掉 follow 与退避两条定时链并停机", () => {
  const fp = barePanel();
  fp._wantOpen = true;
  fp._startFollow();
  assert.ok(fp._followT, "跟随定时器应已武装");
  fp._retryT = setTimeout(() => {}, 60000);
  fp.dispose();
  assert.equal(fp._dead, true);
  assert.equal(fp._wantOpen, false);
  assert.equal(fp._followT, null);
  assert.equal(fp._retryT, null);
});

test("dispose 后 _startFollow 不得再武装定时器（防死后复活）", () => {
  const fp = barePanel();
  fp._wantOpen = true;
  fp.dispose();
  fp._startFollow();
  assert.equal(fp._followT, null);
});

test("dispose 后 open() 不再发任何请求", async () => {
  const fp = barePanel();
  let hits = 0;
  global.authFetch = async () => {
    hits++;
    return {ok: true, status: 200, json: async () => ({})};
  };
  try {
    fp.dispose();
    await fp.open();
    assert.equal(hits, 0);
  } finally {
    delete global.authFetch;
  }
});

test("_followTick 遇 404 no_tab 就地停机，不再排下一轮", async () => {
  const fp = barePanel();
  fp._wantOpen = true;
  let hits = 0;
  global.authFetch = async () => { hits++; return {ok: false, status: 404}; };
  try {
    fp._startFollow();
    await fp._followTick();
    assert.equal(hits, 1);
    assert.equal(fp._dead, true);
    assert.equal(fp._followT, null);
  } finally {
    clearInterval(fp._followT);
    delete global.authFetch;
  }
});

test("终端身份未变时跟随轮询不得停机（真·跟随要继续）", async () => {
  const fp = barePanel();
  fp._wantOpen = true;
  fp._followKey = "h|22|u";
  global.authFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      defaults: {supported: true, host: "h", port: 22, user: "u"},
    }),
  });
  try {
    fp._startFollow();
    await fp._followTick();
    assert.equal(fp._dead, false);
    assert.ok(fp._followT, "定时器应仍在");
  } finally {
    clearInterval(fp._followT);
    delete global.authFetch;
  }
});

test("_fetchState 遇 404 返回 null 且不得排退避重试", async () => {
  const fp = barePanel();
  global.authFetch = async () => ({ok: false, status: 404});
  try {
    assert.equal(await fp._fetchState(), null);
    assert.equal(fp._retryT, null, "404 是终态，不得退避重试");
    assert.equal(fp._dead, true);
  } finally {
    delete global.authFetch;
  }
});

test("网络抖动仍退避重试，不许当成会话没了（不得回归）", async () => {
  const fp = barePanel();
  global.authFetch = async () => { throw new Error("net down"); };
  try {
    assert.equal(await fp._fetchState(), null);
    assert.ok(fp._retryT, "仍要排重试");
    assert.equal(fp._dead, false, "网络抖动 ≠ 会话回收");
  } finally {
    clearTimeout(fp._retryT);
    delete global.authFetch;
  }
});

test("Session.close() 必须收掉文件面板", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "src",
    "openterminal", "web", "frontend", "static", "app.js"), "utf8");
  assert.match(app, /close\(\) \{[\s\S]{0,240}this\.filesPanel\.dispose\(\)/,
    "漏了就拿死 tabId 无限刷 404");
});
