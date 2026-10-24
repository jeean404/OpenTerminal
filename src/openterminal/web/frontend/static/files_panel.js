function _t(key, ...args) {
  // node 测试单独 require 本文件时全局 t 不存在：回落原文，但占位符仍要替换，
  // 否则断言会拿到带 {0} 的键
  const text = (typeof t === "function") ? t(key) : key;
  if (!args.length) return text;
  return String(text).replace(/\{(\d+)\}/g, (whole, n) =>
    args[Number(n)] === undefined ? whole : String(args[Number(n)]));
}

// 文件面板：远程目录浏览/上传/下载（走 REST，不占 WebSocket）。
// 面板仍是 absolute 覆盖层（不改 DOM 结构），但打开时终端让位收缩：
// pane.fp-open → .term margin-right，fit() 同步 PTY 列宽与卡片重贴。
//
// 三条硬约束：
//  1. **面板与终端完全独立**：面板自带一条 SSH 直连（不借终端的连接、
//     不经隧道、不碰 PTY），终端画面零变化，终端断开面板照常工作。
//  2. **登录弹框四栏**：IP / 端口 / 用户名 / 密码。IP 与端口默认取终端
//     连接的最终服务器、用户名默认取终端当前所处的用户，密码由用户输入。
//     勾「记住密码」后写入系统凭据库，后续打开面板自动连接、不再弹框。
//  3. **登录成功默认进当前用户目录**（SFTP 默认目录即登录用户的家目录），
//     不跟终端 cwd——跟了会把跳板机上的无关目录当用户目录列出来。
//
// 列表交互：单击＝选中，双击目录＝进入、双击文件＝打开编辑器；下载是
// 独立的 ⬇ 按钮，不跟单击绑在一起。
const UP_MAX = 5;   // 同时上传的文件数上限，其余排队
const UP_CHUNK_SIZE = 1024 * 1024;

class FilePanel {
  constructor(session) {
    this.s = session;
    this.tabId = session.tabId;
    this.pane = session.paneEl;
    this.cwd = null;            // 面板当前目录（null=尚未定位）
    this._built = false;
    this._conn = null;          // 当前连接 {host, port, user}
    this._defaults = null;      // /state 给的弹框默认值（来自终端身份）
    this._selected = null;      // 选中的条目名（load 重渲染后回填）
    this._seq = 0;              // 列目录请求序号：过期响应一律丢弃
    this._stateSeq = 0;
    this._retryT = null;        // 未就绪自动重试定时器
    this._wantOpen = false;     // 面板应处于展开态（重试链据此续命）
    this._retryWait = 0;        // 未就绪自动重试的退避
    this._connecting = false;   // 自动连接途中，防重入
    this._followKey = "";       // 面板已对齐的终端身份（host|port|user）
    this._pendKey = "";         // 候选新身份：连续两次轮询一致才切换
    this._followT = null;       // 跟随终端身份的轮询定时器
  }

  static _idKey(d) {
    return d && d.supported && d.host
      ? `${d.host}|${d.port == null ? 22 : d.port}|${d.user || ""}` : "";
  }

  /** 面板展开期间轮询终端身份：跳到 B / 切用户后自动重连到新身份。 */
  _startFollow() {
    clearInterval(this._followT);
    this._followT = setInterval(() => this._followTick(), 2000);
  }

  _stopFollow() { clearInterval(this._followT); this._followT = null; }

  async _followTick() {
    if (!this._wantOpen || this.el.hidden || this._connecting) return;
    let st;
    try {
      const r = await authFetch(this._api("state"));
      if (!r.ok) return;
      st = await r.json();
    } catch (e) { return; }
    const d = st.defaults;
    this._defaults = d || this._defaults;
    const key = FilePanel._idKey(d);
    if (!key || key === this._followKey) { this._pendKey = ""; return; }
    if (key !== this._pendKey) { this._pendKey = key; return; }   // 去抖
    this._pendKey = "";
    this._followKey = key;
    this._conn = null;
    this.cwd = null;
    this._selected = null;
    if (await this._autoConnect()) return;
    this._noCred();
  }

  toggle() {
    if (!this._built) this._build();
    this._wantOpen = this.el.hidden;
    this.el.hidden = !this._wantOpen;
    // 终端让位：面板打开时 .term 收缩（pane.fp-open → margin-right），
    // fit() 走窗口 resize 同一条链把新 cols 同步给 PTY 与卡片重贴
    this.pane.classList.toggle("fp-open", this._wantOpen);
    if (this._wantOpen) {
      this._place();
      this.open();
      this._startFollow();
    } else {
      clearTimeout(this._retryT);
      this._stopFollow();
    }
    if (this.s.fit) this.s.fit();
  }

  /** 会话类型探测后由 app.js 调用：本机终端没有「最终服务器」，不给入口。 */
  setSupported(ok) {
    const btn = document.getElementById(`filesbtn-${this.tabId}`);
    if (btn) btn.hidden = !ok;
    if (!ok && this.el) {
      this.el.hidden = true;
      this._wantOpen = false;
      this._stopFollow();
      this.pane.classList.remove("fp-open");
    }
  }

  _place() {
    const head = this.pane.querySelector(".pane-head");
    const bar = this.pane.querySelector(".statusbar");
    this.el.style.top = head.offsetHeight + "px";
    this.el.style.bottom = (bar ? bar.offsetHeight : 0) + "px";
  }

  _build() {
    const el = document.createElement("div");
    el.className = "files-panel";
    el.hidden = true;
    // 工具栏一律图标 + 原生 title（全仓库唯一的悬浮提示做法，不引 tooltip 组件）
    el.innerHTML = `
      <div class="fp-head">
        <div class="fp-head-top">
          <span class="fp-title">${_t("远程文件")}</span>
          <span class="fp-badge"></span>
          <button class="fp-btn fp-icon" data-act="close" title="${_t("关闭面板")}">×</button>
        </div>
        <div class="fp-head-acts">
          <button class="fp-btn fp-icon" data-act="home" title="${_t("回到登录用户的家目录")}">🏠</button>
          <button class="fp-btn fp-icon" data-act="mkdir" title="${_t("新建文件夹")}">📁</button>
          <button class="fp-btn fp-icon" data-act="create" title="${_t("新建文件")}">📄</button>
          <button class="fp-btn fp-icon" data-act="refresh" title="${_t("刷新")}">🔄</button>
        </div>
      </div>
      <div class="fp-path"></div>
      <div class="fp-list" tabindex="-1"></div>
      <div class="fp-progress" hidden><i></i></div>
      <div class="fp-uploads" hidden></div>
      <div class="fp-foot">
        <input type="file" class="fp-input" multiple hidden>
        <button class="fp-btn fp-icon fp-up" data-act="pick" title="${_t("上传文件")}">📤</button>
        <span class="fp-hint">${_t("可拖文件进列表上传，双击进入 / 打开")}</span>
      </div>`;
    this.pane.appendChild(el);
    this.el = el;
    this._built = true;

    el.querySelector('[data-act="home"]').onclick = () => {
      this.cwd = null;
      this._selected = null;
      this.load(".");
    };
    el.querySelector('[data-act="refresh"]').onclick = () => this.refresh();
    el.querySelector('[data-act="close"]').onclick = () => this.toggle();
    el.querySelector('[data-act="mkdir"]').onclick = () => {
      this._promptName(_t("新建文件夹"), _t("目录名"), (name) => {
        const remote = this._join(this.cwd, name);
        this._post("mkdir", remote, _t("已创建文件夹 {0}", name))
          .then((ok) => { if (ok) this.load(this.cwd); });
      });
    };
    el.querySelector('[data-act="create"]').onclick = () => {
      this._promptName(_t("新建文件"), _t("文件名（创建后直接进编辑器）"), (name) => {
        const remote = this._join(this.cwd, name);
        this._post("create", remote, null, {exists: _t("已存在同名文件 {0}", name)})
          .then((ok) => {
            if (!ok) return;
            this.load(this.cwd);
            this.edit(name, remote);
          });
      });
    };
    el.querySelector('[data-act="pick"]').onclick = () => el.querySelector(".fp-input").click();
    el.querySelector(".fp-input").onchange = (e) => {
      this.upload(e.target.files);
      e.target.value = "";
    };
    const list = el.querySelector(".fp-list");
    list.addEventListener("dragover", (e) => { e.preventDefault(); list.classList.add("drop"); });
    list.addEventListener("dragleave", () => list.classList.remove("drop"));
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      list.classList.remove("drop");
      if (e.dataTransfer.files.length) this.upload(e.dataTransfer.files);
    });
    // 键盘等价物：↑/↓ 移动选中，Enter 打开（双击的键盘路径）
    list.addEventListener("keydown", (ev) => this._onListKey(ev));
    this._setBadge("");
  }

  // 面板请求的单点 URL 构造（连接与终端无关，没有 via 维度）
  _url(action, params) {
    const q = new URLSearchParams(params || {});
    return `/api/tabs/${this.tabId}/files/${action}?${q.toString()}`;
  }

  _api(action) { return this._url(action); }

  _setBadge(text) {
    const badge = this.el && this.el.querySelector(".fp-badge");
    if (!badge) return;
    badge.textContent = text;
    badge.hidden = !text;
  }

  // --- 打开 / 状态 / 加载 ---------------------------------------------------

  /** 打开面板：已连接就列目录；没连接先试着用记住的密码连，连不上才弹框。 */
  async open() {
    const st = await this._fetchState();
    if (!st) return;
    if (!st.supported) { this.setSupported(false); return; }
    this._defaults = st.defaults || null;
    this._followKey = FilePanel._idKey(this._defaults);
    if (st.connected) {
      this._conn = {host: st.host, port: st.port, user: st.user};
      this._setBadge(this._connLabel());
      this.load(this.cwd || ".");     // 需求 3：默认进登录用户的家目录
      return;
    }
    if (await this._autoConnect()) return;
    this._noCred();
  }

  refresh() { return this.load(this.cwd == null ? "." : this.cwd); }

  _connLabel() {
    const c = this._conn;
    if (!c) return "";
    let t = (c.user ? c.user + "@" : "") + (c.host || "");
    if (c.port && Number(c.port) !== 22) t += `:${c.port}`;
    return t;
  }

  /**
   * 用记住的密码静默登录（需求 2：记住后点开自动连，不再弹框）。
   * 目标恒为终端那台（defaults）——用户手改的临时目标只管本次。
   * 返回 true 表示已在列目录，调用方不必再弹框。
   */
  async _autoConnect() {
    const d = this._defaults;
    if (this._connecting || !d || !d.host || !d.has_password) return false;
    this._connecting = true;
    try {
      return await this._connect({host: d.host, port: d.port, user: d.user,
                                 password: "", remember: false}, false, true);
    } finally {
      this._connecting = false;
    }
  }

  /** 没有可用凭据：不弹框，提示在终端登录时记住密码；空态留手动连接入口。 */
  _noCred() {
    this._setBadge("");
    const d = this._defaults || {};
    const who = d.host ? `${d.user ? d.user + "@" : ""}${d.host}` : _t("当前主机");
    const msg = _t("未保存 {0} 的密码。请在终端登录时选择「记住密码」，", who) +
      _t("文件列表会随终端自动连接。");
    // 「手动连接」只在无凭据时空态里出现：工具栏的连接设置已按需求去掉，
    // 但没记住密码时仍要能手填一次（否则面板再也登不进去）
    const list = this.el.querySelector(".fp-list");
    list.innerHTML = `<div class="fp-empty">${esc(msg)}</div>`;
    const box = list.firstChild;
    box.appendChild(document.createElement("br"));
    const manual = document.createElement("button");
    manual.className = "fp-btn fp-retry";
    manual.textContent = _t("手动连接");
    manual.onclick = () => this._connectDialog();
    box.appendChild(manual);
    this.el.querySelector(".fp-path").innerHTML =
      `<span class="fp-muted">${_t("未连接")}</span>`;
  }

  /** 通道不可用的统一展示 + 自动退避重试（只用于面板自己的连接在重建）。 */
  _pending(reason, retryIn) {
    const list = this.el.querySelector(".fp-list");
    const why = reason === "need_password" ? _t("目标主机需要密码")
      : _t("等待连接…");
    list.innerHTML = `<div class="fp-empty">${esc(why)}</div>`;
    this.el.querySelector(".fp-path").innerHTML =
      `<span class="fp-muted">${esc(why)}</span>`;
    if (reason === "need_password") return;
    clearTimeout(this._retryT);
    const wait = retryIn == null
      ? Math.min(4000, (this._retryWait || 500))
      : retryIn;
    if (retryIn == null) this._retryWait = Math.min(4000, wait * 1.7);
    this._retryT = setTimeout(() => {
      if (this._wantOpen && !this.el.hidden) this.open();
    }, wait);
  }

  async _fetchState() {
    const seq = ++this._stateSeq;
    let r;
    try {
      r = await authFetch(this._api("state"));
    } catch (e) {
      if (seq !== this._stateSeq) return null;
      this._pending("not_ready", 1500);
      return null;
    }
    if (seq !== this._stateSeq) return null;
    if (!r.ok) {
      this._pending("not_ready", 1500);
      return null;
    }
    const st = await r.json();
    if (seq !== this._stateSeq) return null;
    if (st.connected) this._retryWait = 0;
    return st;
  }

  async load(path) {
    const list = this.el.querySelector(".fp-list");
    const seq = ++this._seq;
    list.innerHTML = `<div class="fp-empty">${_t("加载中…")}</div>`;
    let r;
    try {
      r = await authFetch(this._url("list", {path: path}));
    } catch (e) {
      if (seq === this._seq) {
        this._err(list, {detail: String(e), code: "io"},
                  _t("请求失败"), () => this.load(path));
      }
      return;
    }
    if (seq !== this._seq) return;          // 已有更新的请求在跑：丢弃本次
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.code === "auth_failed" || j.code === "not_connected") {
        // 密码不对/连接没了：不是「重试」能解决的，回登录框换凭据
        this._conn = null;
        this._noCred();
        return;
      }
      if (j.code === "not_ready") { this._pending("not_ready", 1200); return; }
      this._err(list, j, _t("列目录失败"), () => this.load(path));
      return;
    }
    const data = await r.json();
    if (seq !== this._seq) return;
    this.cwd = data.path;
    this._render(data.entries);
  }

  _err(list, j, label, onRetry) {
    list.innerHTML = "";
    const box = document.createElement("div");
    box.className = "fp-empty";
    box.appendChild(document.createTextNode(
      `${label}：${(j && j.detail) || "未知错误"}`));
    if (onRetry) {
      const b = document.createElement("button");
      b.className = "fp-btn fp-retry";
      b.textContent = _t("重试");
      b.onclick = onRetry;
      box.appendChild(document.createElement("br"));
      box.appendChild(b);
    }
    list.appendChild(box);
  }

  _render(entries) {
    const list = this.el.querySelector(".fp-list");
    list.innerHTML = "";
    if (!entries.length) {
      list.innerHTML = `<div class="fp-empty">${_t("（空目录）")}</div>`;
    }
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "fp-row" + (e.is_dir ? " dir" : "");
      const icon = e.is_dir ? "📁" : "📄";
      const meta = e.is_dir ? "" : `${this._fmtSize(e.size)} · ${this._fmtTime(e.mtime)}`;
      row.innerHTML = `<span class="fp-icon">${icon}</span>` +
        `<span class="fp-name" title="${esc(e.name)}">${esc(e.name)}</span>` +
        `<span class="fp-meta">${esc(meta)}</span>`;
      // 选中态在重渲染后回填（_render 整表重建，不回填就闪没了）
      if (e.name === this._selected) row.classList.add("active");
      const path = this._join(this.cwd, e.name);
      // 单击＝选中；双击才进入目录/打开文件（需求 4：下载不再绑在单击上）
      row.onclick = () => {
        this._selected = e.name;
        for (const r of list.querySelectorAll(".fp-row")) r.classList.remove("active");
        row.classList.add("active");
      };
      row.ondblclick = () => {
        if (e.is_dir) { this._selected = null; this.load(path); }
        else this.edit(e.name, path);
      };
      // 行内操作：悬浮出现。下载是独立按钮（仅文件——SFTP 无原生打包）
      const acts = document.createElement("span");
      acts.className = "fp-acts";
      if (!e.is_dir) {
        acts.appendChild(this._actBtn("📥", _t("下载"), () =>
          this.download(e.name, path)));
        acts.appendChild(this._actBtn("✏️", _t("编辑"), () =>
          this.edit(e.name, path)));
      }
      acts.appendChild(this._actBtn("🗑", _t("删除"), () =>
        this._confirmDelete(e.name, e.is_dir, path)));
      row.appendChild(acts);
      list.appendChild(row);
    }
    // 面包屑：绝对路径逐级可点；相对路径（如 "."，家目录未解析前）只显示文本。
    // 每项 path 由 _crumbTargets 预先算好——handler 若闭包捕获循环里
    // 累加的 acc，点击时读到的都是循环结束后的完整路径（中段回退全坏）
    const crumbs = this.el.querySelector(".fp-path");
    crumbs.innerHTML = "";
    const targets = this._crumbTargets(this.cwd);
    if (!targets) {
      crumbs.textContent = this.cwd;
      return;
    }
    targets.forEach(({label, path}, i) => {
      if (i > 0) crumbs.appendChild(document.createTextNode(" / "));
      const a = document.createElement("a");
      a.textContent = label;
      a.onclick = () => { this._selected = null; this.load(path); };
      crumbs.appendChild(a);
    });
  }

  _onListKey(ev) {
    const rows = Array.from(this.el.querySelectorAll(".fp-row"));
    if (!rows.length) return;
    const names = rows.map((r) => r.querySelector(".fp-name").textContent);
    let i = names.indexOf(this._selected);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      i = ev.key === "ArrowDown"
        ? Math.min(names.length - 1, i + 1)
        : Math.max(0, i < 0 ? 0 : i - 1);
      this._selected = names[i];
      rows.forEach((r, k) => r.classList.toggle("active", k === i));
    } else if (ev.key === "Enter" && i >= 0) {
      ev.preventDefault();
      rows[i].dispatchEvent(new MouseEvent("dblclick"));
    }
  }

  _crumbTargets(cwd) {
    if (!cwd || !cwd.startsWith("/")) return null;
    const targets = [{label: "/", path: "/"}];
    let acc = "";
    for (const p of cwd.split("/").filter(Boolean)) {
      acc += "/" + p;
      targets.push({label: p, path: acc});
    }
    return targets;
  }

  _join(base, name) {
    if (!base || base === ".") return name;
    return base.replace(/\/+$/, "") + "/" + name;
  }

  _fmtSize(n) {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let v = n;
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  _fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    return d.toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit" });
  }

  _progress(show, frac) {
    const p = this.el.querySelector(".fp-progress");
    p.hidden = !show;
    if (show) {
      p.querySelector("i").style.width =
        frac == null ? "33%" : `${Math.max(2, Math.min(100, Math.round(frac * 100)))}%`;
    }
  }

  _toast(msg, bad) {
    let el = this.pane.querySelector(".fp-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "fp-toast";
      this.pane.appendChild(el);
    }
    el.textContent = msg;
    el.className = "fp-toast show" + (bad ? " bad" : "");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /** 会话就绪后探测一次：本机终端没有「最终服务器」，直接不给入口。 */
  async probeSupport() {
    let ok = true;
    try {
      const r = await authFetch(this._api("state"));
      if (r.ok) ok = !!(await r.json()).supported;
    } catch (e) { ok = true; }    // 探测失败先保留入口，别误伤 SSH
    this.setSupported(ok);
    return ok;
  }

  // --- 登录弹框 ------------------------------------------------------------

  /**
   * 四栏登录表单：IP / 端口 / 用户名 / 密码 + 「记住密码」。
   * IP/端口默认＝终端连接的最终服务器，用户名默认＝终端当前所处的用户（需求 1）。
   * 密码栏恒空（不预填明文）；留空表示用已记住的。
   */
  _connectDialog() {
    const d = this._defaults || {};
    const cur = this._conn || {};
    const host = cur.host || d.host || "";
    const port = (cur.port != null ? cur.port
      : (d.port != null ? d.port : 22));
    const user = cur.user || d.user || "";
    const hint = [];
    if (d.host && d.nested) {
      hint.push(`${_t("终端当前在")} <b>${esc(d.host)}</b>` +
        (d.user ? `${_t("（身份")} <b>${esc(d.user)}</b>）` : "") +
        _t("，已按它预填。面板独立于终端，改这里只影响本次连接。"));
    }
    if (d.has_password) hint.push(_t("该身份已记住密码，留空密码即可自动登录。"));
    else if (d.fallback_user) {
      // 没有目标用户的密码（典型：终端里 sudo su - 到了 root）：面板会用有
      // 密码的那个身份登录，再提权到目标用户——SFTP 换不了用户
      hint.push(_t("没有 {0} 的密码，会改用 {1} 登录并提权到 {0} 浏览文件。",
                   user || d.user || "", d.fallback_user));
    }
    modalShell(_t("连接远程主机"),
      `<div class="form-grid">` +
      `<label>${_t("IP 地址")}</label><input id="fp-host" value="${esc(host)}" autofocus>` +
      `<label>${_t("端口")}</label><input id="fp-port" value="${esc(port)}">` +
      `<label>${_t("用户名")}</label><input id="fp-user" value="${esc(user)}">` +
      `<label>${_t("密码")}</label><input type="password" id="fp-pass" ` +
        `autocomplete="new-password" placeholder="${_t("留空则用已记住的")}">` +
      `</div>` +
      `<label class="fp-remember"><input type="checkbox" id="fp-remember"> ` +
      `${_t("记住密码（写入系统凭据库，不落数据库）")}</label>` +
      (hint.length ? `<p class="fp-hint2">${hint.join("<br>")}</p>` : ""),
      [
        {label: _t("连接"), primary: true, onClick: () => {
          const h = document.getElementById("fp-host");
          const v = h.value.trim();
          if (!v) { h.classList.add("invalid"); h.focus(); return false; }
          const rawPort = document.getElementById("fp-port").value.trim();
          return this._connect({
            host: v,
            port: /^\d+$/.test(rawPort) ? parseInt(rawPort, 10) : null,
            user: document.getElementById("fp-user").value.trim() || null,
            password: document.getElementById("fp-pass").value,
            remember: document.getElementById("fp-remember").checked,
          }, false);
        }},
      ].concat(this._conn
        ? [{label: _t("断开连接"), onClick: () => this._disconnect()}] : [])
       .concat([{label: _t("取消")}]));
    const h = document.getElementById("fp-host");
    if (h) { h.focus(); if (h.select) h.select(); }
  }

  /**
   * 登录。silent=true 时失败只退回调用方（自动连接不该打扰用户）。
   * 返回 true 表示已连上并在列目录。
   */
  async _connect({host, port, user, password, remember}, confirmKey, silent) {
    let r;
    try {
      r = await authFetch(this._api("connect"), {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({host, port, user, password,
          remember: !!remember, confirm_host_key: !!confirmKey}),
      });
    } catch (e) {
      if (!silent) this._toast(_t("请求失败：{0}", e), true);
      return false;
    }
    if (r.status === 428) {
      // 未知主机（TOFU）：展示指纹让用户确认后带 confirm 重发。
      // 依赖 modal.js 的模态代际号——否则这里开的确认框会被登录框的
      // close 清掉，表现为「点了连接就没反应」。
      const j = await r.json().catch(() => ({}));
      modalShell(_t("确认未知主机"),
        `<p>${esc(j.detail || _t("主机密钥未知"))}</p><p>${_t("信任并继续连接？")}</p>`,
        [
          {label: _t("信任并连接"), primary: true, onClick: () =>
            this._connect({host, port, user, password, remember}, true, silent)},
          {label: _t("取消")},
        ]);
      return true;                          // 原弹窗关闭，流程转入确认框
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (!silent) {
        // 密码错/账号无权（403 auth_failed）留在弹框便于改了重试；
        // 绝不弹「访问令牌」框——401 才是它的专属语义
        this._toast(j.detail || _t("连接失败（{0}）", r.status), true);
      }
      return false;
    }
    const j = await r.json();
    this._conn = {host: j.host, port: j.port, user: j.user || ""};
    this.cwd = null;                        // 需求 3：登录成功默认进用户目录
    this._selected = null;
    this._setBadge(this._connLabel());
    this.load(".");
    if (!silent) this._toast(_t("已连接 {0}", j.host));
    return true;
  }

  async _disconnect() {
    try {
      await authFetch(this._api("disconnect"), {method: "POST"});
    } catch (e) { /* 断开失败不阻断本地回退 */ }
    this._conn = null;
    this.cwd = null;
    this._selected = null;
    this._setBadge("");
    this._toast(_t("已断开"));
    this._connectDialog();
  }

  // --- 下载 / 上传 ---------------------------------------------------------

  async download(name, path) {
    this._progress(true, 0);
    try {
      const url = this._url("download", {path: path});
      let r = await authFetch(url);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        this._toast(_t("下载失败：{0}", j.detail || r.status), true);
        return;
      }
      // 流式读取：按 Content-Length 显示真实进度
      const total = +(r.headers.get("content-length") || 0);
      const reader = r.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        this._progress(true, total ? got / total : null);
      }
      const blob = new Blob(chunks);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      this._toast(_t("已下载 {0}（{1}）", name, this._fmtSize(got)));
    } catch (e) {
      this._toast(_t("下载失败：{0}", e), true);
    } finally {
      this._progress(false);
    }
  }

  // 上传队列：最多 UP_MAX 个并发，其余排队；每项独立进度、可取消。
  upload(fileList) {
    if (!this.cwd) { this._toast(_t("目录未就绪"), true); return; }
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!this._ups) { this._ups = []; this._upOk = false; }
    for (const f of files) {
      const it = {file: f, dir: this.cwd, state: "queued", xhr: null, row: null};
      this._ups.push(it);
      this._upRender(it);
    }
    this._upPump();
  }

  _upPump() {
    let running = this._ups.filter((u) => u.state === "running").length;
    for (const it of this._ups) {
      if (running >= UP_MAX) break;
      if (it.state !== "queued") continue;
      it.state = "running";
      running++;
      this._upRun(it);
    }
  }

  _upRender(it) {
    const box = this.el.querySelector(".fp-uploads");
    const row = document.createElement("div");
    row.className = "fp-up";
    row.innerHTML = `
      <div class="fp-up-top">
        <span class="fp-up-name"></span>
        <span class="fp-up-pct"></span>
        <button class="fp-act fp-up-x"></button>
      </div>
      <div class="fp-up-bar"><i></i></div>`;
    row.querySelector(".fp-up-name").textContent = it.file.name;
    row.querySelector(".fp-up-name").title = it.file.name;
    row.querySelector(".fp-up-x").onclick = () => this._upCancel(it);
    it.row = row;
    box.appendChild(row);
    box.hidden = false;
    this._upPaint(it, 0);
  }

  _upPaint(it, frac) {
    const row = it.row;
    if (!row) return;
    const pct = row.querySelector(".fp-up-pct");
    const bar = row.querySelector(".fp-up-bar i");
    const x = row.querySelector(".fp-up-x");
    row.dataset.state = it.state;
    x.textContent = it.state === "error" ? "✕" : "⏹";
    x.title = it.state === "error" ? _t("关闭") : (it.state === "queued" ? _t("移出队列") : _t("取消上传"));
    if (it.state === "queued") {
      pct.textContent = _t("排队中");
      bar.style.width = "0";
    } else if (it.state === "error") {
      pct.textContent = it.err || _t("失败");
      bar.style.width = "100%";
    } else {
      const total = it.file.size;
      const p = Math.max(0, Math.min(1, frac));
      pct.textContent = `${Math.floor(p * 100)}% · ${this._fmtSize(Math.round(p * total))}/${this._fmtSize(total)}`;
      bar.style.width = `${Math.round(p * 100)}%`;
    }
  }

  _upCancel(it) {
    if (it.state === "error" || it.state === "queued") {
      this._upRemove(it);
      return;
    }
    if (it.state === "running") {
      it.state = "canceled";
      if (it.xhr) it.xhr.abort();           // onabort 里收尾（腾出并发槽位）
      else this._upEnd(it);                 // 令牌弹窗等待期间没有 xhr
      this._toast(_t("已取消 {0}", it.file.name));
    }
  }

  _upRemove(it) {
    this._ups = this._ups.filter((u) => u !== it);
    if (it.row) it.row.remove();
    it.row = null;
    const box = this.el.querySelector(".fp-uploads");
    box.hidden = !box.children.length;
  }

  // 一项结束（成功 / 失败 / 取消）：腾出槽位、补位排队项、全部结束后刷新目录
  _upEnd(it) {
    it.xhr = null;
    if (it.state === "done" || it.state === "canceled") {
      if (it.state === "done") {
        this._upOk = true;
        this._upPaint(it, 1);
      }
      setTimeout(() => this._upRemove(it), it.state === "done" ? 1200 : 0);
    }
    this._upPump();
    if (!this._ups.some((u) => u.state === "queued" || u.state === "running")) {
      if (this._upOk) this.load(this.cwd);
      this._upOk = false;
    }
  }

  _upId(it) {
    const target = this._conn || {};
    const identity = JSON.stringify([
      it.dir,
      it.file.name, it.file.size, it.file.lastModified,
    ]);
    const key = `ot-upload:${identity}`;
    const legacyKey = `ot-upload:${JSON.stringify([
      target.host, target.port, target.user, it.dir,
      it.file.name, it.file.size, it.file.lastModified,
    ])}`;
    it.uploadKey = key;
    it.uploadLegacyKey = legacyKey;
    let hash = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    for (let i = 0; i < identity.length; i++) {
      const code = identity.charCodeAt(i);
      hash = hash.map((value) =>
        Math.imul(value ^ code, 0x01000193) >>> 0);
    }
    const stableId = hash.map((value) => value.toString(16).padStart(8, "0")).join("");
    try {
      const prior = localStorage.getItem(key) || localStorage.getItem(legacyKey);
      if (prior && /^[0-9a-f]{32}$/.test(prior)) {
        localStorage.setItem(key, prior);
        return prior;
      }
      localStorage.setItem(key, stableId);
    } catch (e) {
      it.uploadKey = null;
    }
    return stableId;
  }

  _upStatus(it, params) {
    return authFetch(this._url("upload/status", params)).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
      return body.offset;
    });
  }

  async _upLease(params, active) {
    const r = await authFetch(this._url("upload/lease", {
      path: params.path, name: params.name, upload_id: params.upload_id,
      active: String(active),
    }), {method: "POST"});
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
  }

  _upRequest(it, url, body, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      it.xhr = xhr;
      xhr.open("POST", url);
      const token = getToken();
      if (token) xhr.setRequestHeader("x-ot-token", token);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && it.state === "running") progress(event.loaded);
      };
      xhr.onload = () => {
        it.xhr = null;
        resolve({status: xhr.status, text: xhr.responseText});
      };
      xhr.onerror = () => {
        it.xhr = null;
        reject(new Error(_t("网络错误")));
      };
      xhr.onabort = () => {
        it.xhr = null;
        if (it.state === "canceled") this._upEnd(it);
        reject(new Error(_t("上传已取消")));
      };
      xhr.send(body);
    });
  }

  async _upPost(it, url, body, progress) {
    let retriedToken = false;
    for (;;) {
      const response = await this._upRequest(it, url, body, progress);
      if (response.status !== 401 || retriedToken) return response;
      let tokenish = true;
      try {
        const json = JSON.parse(response.text);
        if (json && json.code && json.code !== "unauthorized") tokenish = false;
      } catch (e) { /* 无法解析响应时按令牌问题处理 */ }
      if (!tokenish) return response;
      await promptForToken();
      if (it.state !== "running") throw new Error(_t("上传已取消"));
      retriedToken = true;
    }
  }

  async _upRun(it) {
    const file = it.file;
    let params;
    let leaseTimer = null;
    let leaseActive = false;
    let leaseChain = Promise.resolve();
    const fail = (error) => {
      if (it.state !== "running") return;
      it.state = "error";
      it.err = error.message || String(error);
      this._upPaint(it, 0);
      this._toast(_t("上传失败 {0}：{1}", file.name, it.err), true);
      this._upEnd(it);
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      params = {path: it.dir, name: file.name, upload_id: this._upId(it),
        total: file.size};
      await this._upLease(params, true);
      leaseActive = true;
      leaseTimer = setInterval(() => {
        leaseChain = leaseChain.then(() => this._upLease(params, true)).catch((error) => {
          if (it.state === "running")
            this._toast(_t("上传保活失败 {0}：{1}", file.name, error.message || error), true);
        });
      }, 30000);
      const refreshOffset = async () => {
        const current = await this._upStatus(it, params);
        if (!Number.isSafeInteger(current) || current < 0 || current > file.size)
          throw new Error(_t("服务端续传位置无效"));
        return current;
      };
      let offset = await refreshOffset();
      if (it.state !== "running") return;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
        throw new Error(_t("服务端续传位置无效"));
      let attemptsComplete = 0;
      while (it.state === "running") {
        while (offset < file.size && it.state === "running") {
          const end = Math.min(offset + UP_CHUNK_SIZE, file.size);
          const url = this._url("upload/chunk", {...params, offset});
          let attempts = 0;
          for (;;) {
            if (it.state !== "running") return;
            let response;
            try {
              response = await this._upPost(it, url, file.slice(offset, end),
                (loaded) => this._upPaint(it, (offset + loaded) / file.size));
            } catch (error) {
              if (it.state !== "running") return;
              if (attempts >= 3) throw error;
              await wait(500 * (2 ** attempts++));
              if (it.state !== "running") return;
              offset = await refreshOffset();
              if (offset >= file.size) break;
              continue;
            }
            let result = {};
            try { result = JSON.parse(response.text); } catch (e) { /* 下方报 HTTP 错误 */ }
            if (response.status === 409 && result.code === "upload_offset") {
              if (!Number.isSafeInteger(result.offset) || result.offset < 0
                  || result.offset > file.size)
                throw new Error(_t("服务端返回了无效的续传位置"));
              if (result.offset === offset) throw new Error(result.detail || _t("上传位置冲突"));
              offset = result.offset;
              break;
            }
            if (response.status !== 200) {
              if (response.status >= 500 && attempts < 3) {
                await wait(500 * (2 ** attempts++));
                if (it.state !== "running") return;
                offset = await refreshOffset();
                if (offset >= file.size) break;
                continue;
              }
              throw new Error(result.detail || `HTTP ${response.status}`);
            }
            if (!Number.isSafeInteger(result.offset) || result.offset <= offset
                || result.offset > file.size)
              throw new Error(_t("服务端返回了无效的续传位置"));
            offset = result.offset;
            break;
          }
        }
        if (it.state !== "running") return;
        const completeUrl = this._url("upload/complete", params);
        let completed;
        try {
          completed = await authFetch(completeUrl, {method: "POST"});
        } catch (error) {
          if (attemptsComplete >= 3) throw error;
          await wait(500 * (2 ** attemptsComplete++));
          offset = await refreshOffset();
          continue;
        }
        const result = await completed.json().catch(() => ({}));
        if (completed.status === 409 && result.code === "upload_incomplete") {
          if (!Number.isSafeInteger(result.offset) || result.offset < 0
              || result.offset >= file.size)
            throw new Error(_t("服务端返回了无效的续传位置"));
          offset = result.offset;
          continue;
        }
        if (!completed.ok) throw new Error(result.detail || `HTTP ${completed.status}`);
        break;
      }
      if (it.state !== "running") return;
      try {
        if (it.uploadKey) localStorage.removeItem(it.uploadKey);
        if (it.uploadLegacyKey) localStorage.removeItem(it.uploadLegacyKey);
      }
      catch (error) { this._toast(_t("上传已完成，但无法清理本地续传记录"), true); }
      it.state = "done";
      this._toast(_t("已上传 {0}", file.name));
      this._upEnd(it);
    } catch (error) {
      if (it.state === "running") fail(error);
    } finally {
      clearInterval(leaseTimer);
      if (leaseActive) {
        await leaseChain;
        try {
          await this._upLease(params, false);
        } catch (error) {
          if (it.state !== "done")
            this._toast(_t("释放上传保活失败 {0}：{1}", file.name, error.message || error), true);
        }
      }
    }
  }

  // --- 行内操作 -------------------------------------------------------------

  _actBtn(icon, title, onClick) {
    const b = document.createElement("button");
    b.className = "fp-act";
    b.textContent = icon;
    b.title = title;
    b.onclick = (ev) => { ev.stopPropagation(); onClick(); };
    // 双击行内按钮不该再触发行的 dblclick（进入目录/打开文件）
    b.ondblclick = (ev) => ev.stopPropagation();
    return b;
  }

  _promptName(title, placeholder, onOk) {
    modalShell(title,
      `<input type="text" id="modal-value" class="fp-name-input" ` +
      `placeholder="${esc(placeholder)}" autofocus>`,
      [
        {label: _t("确定"), primary: true, onClick: () => {
          const v = document.getElementById("modal-value").value.trim();
          if (!v) return false;               // 空名不关窗
          onOk(v);
        }},
        {label: _t("取消")},
      ]);
    const v = document.getElementById("modal-value");
    if (v) v.focus();
  }

  _confirmDelete(name, isDir, path) {
    modalShell(_t("删除确认"),
      `<p>${_t("确定删除{0}", isDir ? _t("文件夹") : _t("文件"))} <b>${esc(name)}</b>` +
      (isDir ? `${_t("（含其全部内容，")}<b>${_t("递归删除")}</b>）` : "") + `${_t("？不可恢复。")}</p>`,
      [
        {label: _t("删除"), primary: true, onClick: async () => {
          if (await this._post("delete", path)) {
            this._toast(_t("已删除 {0}", name));
            this._selected = null;
            this.load(this.cwd);
          } else {
            return false;                     // 删除失败留在确认框便于重试
          }
        }},
        {label: _t("取消")},
      ]);
  }

  /** POST 动作：okMsg 成功提示；codes 把业务码翻成更贴切的文案。 */
  async _post(action, remote, okMsg, codes) {
    try {
      const url = this._url(action, {path: remote});
      let r = await authFetch(url, {method: "POST"});
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j.code === "auth_failed" || j.code === "not_connected") {
          this._conn = null;
          this._noCred();
          return false;
        }
        const alt = codes && j.code && codes[j.code];
        this._toast(alt || j.detail || r.status, true);
        return false;
      }
      if (okMsg) this._toast(okMsg);
      return true;
    } catch (e) {
      this._toast(_t("请求失败：{0}", e), true);
      return false;
    }
  }

  async edit(name, path) {
    const url = this._url("read", {path: path});
    let r = await authFetch(url);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.code === "auth_failed" || j.code === "not_connected") {
        this._conn = null;
        this._noCred();
        return;
      }
      const why = j.code === "too_large"
        ? _t("{0}，请用 ⬇ 下载后编辑", j.detail || _t("文件过大"))
        : `${j.detail || r.status}`;
      this._toast(_t("读取失败：{0}", why), true);
      return;
    }
    const data = await r.json();
    modalShell(_t("编辑文件 — {0}", name),
      `<textarea id="fp-edit" class="fp-edit" spellcheck="false" wrap="off"></textarea>` +
      `<p class="fp-edit-hint">${_t("{0} · {1} · Ctrl+S 保存", esc(data.path), this._fmtSize(data.size))}</p>`,
      [
        {label: _t("保存"), primary: true, onClick: async () => {
          const text = document.getElementById("fp-edit").value;
          if (await this._write(path, text)) { this._toast(_t("已保存 {0}", name)); }
          else return false;
        }},
        {label: _t("取消")},
      ]);
    const ta = document.getElementById("fp-edit");
    ta.value = data.content;
    ta.focus();
    ta.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        document.querySelector("#modal-root .modal-btns button.primary").click();
      }
    });
  }

  async _write(remote, text) {
    try {
      const url = this._url("write", {path: remote});
      let r = await authFetch(url, {method: "POST",
        headers: {"Content-Type": "text/plain"}, body: text});
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        this._toast(_t("保存失败：{0}", j.detail || r.status), true);
        return false;
      }
      return true;
    } catch (e) {
      this._toast(_t("保存失败：{0}", e), true);
      return false;
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {FilePanel, _test: {
    join: FilePanel.prototype._join,
    fmtSize: FilePanel.prototype._fmtSize,
    fmtTime: FilePanel.prototype._fmtTime,
    url: FilePanel.prototype._url,
    crumbTargets: FilePanel.prototype._crumbTargets,
    connLabel: FilePanel.prototype._connLabel,
  }};
}
