// OpenTerminal Web 前端：左侧服务器列表 + 右侧多 tab 终端。
// 单管线架构（docs/design-single-pipeline.md）：一个全屏连续 xterm 是唯一渲染
// 管线，PTY 字节直写（SSH/Agent 统一）——Tab 补全、历史、Ctrl+R、vim/top、
// 嵌套 shell、clear 全部走终端原生；AI 卡片以 React island 分区挂载（阿里
// workbench 同款）：卡片占 pad 打孔预留的空白行，输出永远从卡片下方流走。
// 分析卡（流式）、总结卡（mdLite 表格）、审批卡（按钮/编辑/快捷键）。
"use strict";

// HTML 转义（与 md_lite.js 的 esc 同实现；island 的 md_lite 打包进了 ui.js，
// index.html 不再全局装载 md_lite.js，这里本地补一份给 modal/tab 等用）
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
    {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

const sessions = {};   // tabId -> Session
let activeTabId = null;
const closedTargets = new Set();   // 最近关闭过（曾 connected/connecting）的目标名 → 状态点转红 closed
let targetsData = null;         // /api/targets 最近一次返回，供搜索重渲染
let searchQuery = "";
// --- 装饰卡落网格用的 ANSI 片段 ---

// --- token（局域网访问 `ot web --host 0.0.0.0 --token X` 时使用）---
function getToken() {
  return sessionStorage.getItem("ot-token") || "";
}

function setToken(v) {
  if (v) sessionStorage.setItem("ot-token", v);
  else sessionStorage.removeItem("ot-token");
}

function promptForToken() {
  return new Promise(resolve => {
    modalShell("访问令牌", `<input type="password" id="modal-value" autofocus>`, [
      {label: "确定", primary: true, onClick: () => {
        setToken(document.getElementById("modal-value").value);
        resolve();
        return true; // close
      }},
    ]);
    document.getElementById("modal-value").focus();
  });
}

// 带 token 的 fetch：401 时先问一次 token 再重试
function authFetch(url, opts = {}) {
  opts.headers = Object.assign({"Content-Type": "application/json"}, opts.headers || {});
  const t = getToken();
  if (t) opts.headers["x-ot-token"] = t;
  return fetch(url, opts).then(r => {
    if (r.status === 401 && !opts._retried) {
      return promptForToken().then(() => {
        const o2 = Object.assign({}, opts, {_retried: true});
        const t2 = getToken();
        if (t2) o2.headers["x-ot-token"] = t2;
        return fetch(url, o2);
      });
    }
    return r;
  });
}

function wsUrl(tabId) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let url = `${proto}://${location.host}/ws/${tabId}`;
  const t = getToken();
  if (t) url += `?token=${encodeURIComponent(t)}`;
  return url;
}

// --- 通用模态框 ---
// buttons: [{label, primary?, onClick() -> bool(true=关闭)}]
function modalShell(title, bodyHtml, buttons) {
  const root = document.getElementById("modal-root");
  const btns = buttons.map((b, i) =>
    `<button class="${b.primary ? "primary" : ""}" data-i="${i}">${esc(b.label)}</button>`).join("");
  root.innerHTML = `
    <div class="modal">
      <h3>${esc(title)}</h3>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-btns">${btns}</div>
    </div>`;
  const close = () => { root.innerHTML = ""; };
  root.querySelectorAll(".modal-btns button").forEach(btn => {
    btn.onclick = () => {
      const b = buttons[Number(btn.dataset.i)];
      const shouldClose = b.onClick ? b.onClick() !== false : true;
      if (shouldClose) close();
    };
  });
  const val = document.getElementById("modal-value");
  if (val) {
    val.addEventListener("keydown", ev => {
      if (ev.key === "Enter") {
        const ok = buttons.find(b => b.primary) || buttons[0];
        if (ok && ok.onClick() !== false) close();
      }
    });
  }
  root.onmousedown = ev => { if (ev.target === root) close(); };
  return close;
}

function modalAsk(title, message, onOk, opts = {}) {
  const rememberHtml = opts.remember
    ? `<label class="modal-check"><input type="checkbox" id="modal-remember" checked> ` +
      `${esc(opts.rememberLabel || "记住密码")}</label>`
    : "";
  modalShell(title,
    `<p>${esc(message)}</p>` +
    `<input type="${opts.password === false ? "text" : "password"}" id="modal-value" autofocus>` +
    rememberHtml,
    [
      {label: "确定", primary: true, onClick: () => {
        const remember = opts.remember
          ? document.getElementById("modal-remember").checked : false;
        onOk(document.getElementById("modal-value").value, remember);
      }},
      {label: "取消", onClick: () => {}},
    ]);
  const v = document.getElementById("modal-value");
  if (v) v.focus();
}

function modalConfirm(title, message, onOk, yesLabel = "信任", noLabel = "拒绝") {
  modalShell(title, `<p>${esc(message)}</p>`, [
    {label: yesLabel, primary: true, onClick: () => onOk(true)},
    {label: noLabel, onClick: () => onOk(false)},
  ]);
}

// --- 单个会话：唯一全屏 xterm（PTY 字节直写）+ 卡片层 React island（纯 overlay）---
class Session {
  constructor(tabId, name) {
    this.tabId = tabId;
    this.name = name;
    this.baseName = name;       // 原始目标名（保留：未来 Tab 标签动态化用）
    this.mode = "agent";        // 'ssh' | 'agent'（仅切换后端 hook 开关，显示不再分叉）
    this._lineBuf = "";         // 半行缓冲（外部分类触发链，见 _feedLineBuf）
    this._lineCur = 0;          // 半行镜像光标位（行内编辑同步用）
    this._lineDirty = false;    // 缓冲被无法镜像的转义/控制键清过（提交时随 submit 上报）
    this.status = "connecting"; // connecting | connected | closed
    this.statusText = "";       // 连接中文案由 status-connect 徽标（旋转+循环点）承担
    this.ws = null;
    this._clip = "";            // 页内最近复制的文本（http 局域网无剪贴板读权限时的粘贴兜底）
    this._feed = null;          // React island 句柄 {handle, mount, unmount, destroy}
    this._feedPromise = null;   // island 懒加载 Promise（失败置空可重试）
    this._lastSummaryMd = null;   // final/ai_card 双发同文的前端去重
    this._padQ = Promise.resolve();  // pad 请求串行队列（应答不串位）
    this._padWait = null;       // 在途 pad 请求的应答 resolver
    this._padSlot = null;       // 在途 pad 请求归属的卡
    this._slots = new Map();    // cardId -> Slot
    this._cardSeq = 0;          // 卡号计数（island 单卡 root 的 key）
    this._taskCardId = null;    // 流式分析卡 id（task_start → final）
    this._cardReady = Promise.resolve();  // 在途开卡链：store 的 task_start 必先于该卡 token
    this._cardsText = new Map();// cardId -> 纯文本（_fallbackPlain 兜底用）
    this._padFailStreak = 0;    // 连续超时计数（≥2 熔断）
    this._padFused = false;     // 熔断：本轮禁用补差，只夹紧
    this._healT = null;         // idle 自愈 debounce
    this._remeasurePending = false; // 备用缓冲期推迟重测，回主缓冲再补
    this._lastByteAt = 0;       // 最近 PTY 字节到达时间（开区前等流沉降）
    this._holdDepth = 0;        // 字节扣流嵌套深度（welcome + card 临界区）
    this._holdBuf = null;       // 扣住的 PTY 字节队列
    this._welcomeHold = null;   // 连接横幅扣留态（先横幅后提示符，见 _holdWelcome）
    this._taskActive = false;   // 任务进行中（task_start → final/denied/limit/error）
    this._phaseLive = false;    // 有活分析卡在流底（task_start/新段 token → ai_collapse/ai_card）
    this._summaryShown = false; // 本轮总结卡已挂（挂出即不再显示思考徽标）
    this._approvalOpen = false; // 有未决策审批卡（球在用户侧，不显思考徽标）
    this._timer = null;         // 任务计时 setInterval id
    this._taskStart = 0;        // 最近一次任务开始时间戳
    this._csTimer = 0;          // cmdset 完成提示的消隐定时器
    // Agent 空提示符占位提示(幽灵文本)状态
    this._ghostHide = false;    // 有输入痕迹(可打印键/历史召回):藏到新提示符安静
    this._ghostQuietUntil = 0;  // 回车/控制键后的重显静默窗
    this._ghostDec = null;
    this._ghostMarker = null;
    this._ghostKey = "";
    this.interactive = false;   // shell 集成就绪：AI 功能可用；false=纯终端回退（隐藏模型信息）
    this._dead = false;         // 会话已关闭：停止一切写终端
    this._buildDom();
    this._buildTerm();
  }

  _buildDom() {
    const tabBtn = document.createElement("button");
    tabBtn.className = "tab";
    tabBtn.id = `tabbtn-${this.tabId}`;
    tabBtn.innerHTML = `<span class="tab-name">${esc(this.name)}</span><span class="tab-x" title="关闭">×</span>`;
    tabBtn.querySelector(".tab-name").onclick = () => activateTab(this.tabId);
    tabBtn.querySelector(".tab-x").onclick = ev => { ev.stopPropagation(); closeTab(this.tabId); };
    document.getElementById("tabs").appendChild(tabBtn);
    this.tabEl = tabBtn;

    const pane = document.createElement("div");
    pane.className = "pane";
    pane.id = `pane-${this.tabId}`;
    pane.innerHTML = `
      <div class="pane-head">
        <div class="seg" role="tablist">
          <button data-mode="ssh">Shell</button>
          <button data-mode="agent" class="on">Agent <kbd>Ctrl+Shift+I</kbd></button>
        </div>
        <div class="pane-host" id="host-${this.tabId}"></div>
      </div>
      <div class="term" id="term-${this.tabId}"></div>
      <div class="statusbar">
        <span class="status-connect" id="conn-${this.tabId}" title="正在建立连接"><i class="cspin"></i><span>连接中</span><span class="cdots"></span></span>
        <span class="status-think" id="think-${this.tabId}" hidden title="任务未结束：AI 正在分析或执行"><i class="tspin"></i><span class="ttext">AI 正在思考</span><span class="tdots"></span></span>
        <span class="status-text" id="status-${this.tabId}"></span>
        <span class="status-meta">
          <span class="status-cmdset" id="cs-${this.tabId}"></span>
          <button class="status-newtask" id="newtask-${this.tabId}" tabindex="-1" title="开启新会话（/clear）：清掉本轮 AI 卡片与任务上下文">新会话</button>
          <button class="status-stop" id="stop-${this.tabId}" hidden tabindex="-1" title="停止当前任务（Ctrl+C）">⏹</button>
          <span class="status-tokens" id="tokens-${this.tabId}" title="累计 token 消耗（输入/输出）"></span>
          <select class="status-model" id="model-${this.tabId}" tabindex="-1" title="切换模型"></select>
          <span class="status-time" id="time-${this.tabId}" title="任务耗时"></span>
          <span class="status-size" id="size-${this.tabId}"></span>
        </span>
      </div>`;
    document.getElementById("panes").appendChild(pane);
    this.paneEl = pane;

    pane.querySelectorAll(".seg button").forEach(btn => {
      btn.onclick = () => this.setMode(btn.dataset.mode);
    });
    // 点 pane 任意处锁定终端光标（像真实终端）：xterm 只处理自己的屏幕区域，
    // 点边距/状态栏时焦点会丢到 body，键盘输入全部失效。
    // 可交互元素（按钮/输入框/审批编辑器）不抢——它们有自己的焦点语义。
    // 划选文字松开鼠标同样会触发 click（click 在 mouseup 后）：存在未折叠
    // 选区时说明刚完成一次划选，不抢焦点。
    pane.addEventListener("click", ev => {
      if (ev.target.closest("button, input, textarea, select, a, .modal")) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && String(sel)) return;
      this.focusCursor();
    });
    // 右键菜单：复制选中 / 粘贴到终端（输入类元素用浏览器原生菜单）
    pane.addEventListener("contextmenu", ev => {
      if (ev.target.closest("input, textarea, button, select, a, .modal")) return;
      ev.preventDefault();
      this._showCtxMenu(ev.clientX, ev.clientY);
    });
    pane.querySelector(`#stop-${this.tabId}`).onclick = () => {
      this.sendJson({type: "interrupt"});
    };
    pane.querySelector(`#newtask-${this.tabId}`).onclick = () => {
      // 单管线：等价于用户在提示符敲入 /clear（hook 拦截重置后端对话）
      this._sendInput("/clear\r");
    };
  }

  _buildTerm() {
    // 单管线：唯一渲染实例，SSH 与 Agent 模式共用（命令/AI 输出全在网格里）
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: true,
      // registerMarker（卡片层锚定）在 xterm 5+ 为稳定 API；
      // allowProposedApi 保留以防后续接入装饰类扩展
      allowProposedApi: true,
      // xterm 不认 "var(--...)" 字面量，须传解析后的真实色值；
      // 前景对齐 main 分支的正文白 #e6e8ea（提示符/输出不再发灰）
      theme: {background: getComputedStyle(document.documentElement)
        .getPropertyValue("--term-bg").trim() || "#0d1117",
        foreground: getComputedStyle(document.documentElement)
        .getPropertyValue("--text").trim() || "#e6e8ea"},
    });
    this.term = term;
    this.fitAddon = new FitAddon.FitAddon();
    term.loadAddon(this.fitAddon);
    term.open(this.paneEl.querySelector(`#term-${this.tabId}`));
    // 连接中浮层：盖在终端区中央，两阶段文案（连接中 → 初始化 Agent，由
    // worker 的 stage 事件切换），ready/closed/error 即撤（setStatus 统一
    // 切换）；须在 term.open 之后插入，xterm 接管容器
    const termEl = this.paneEl.querySelector(`#term-${this.tabId}`);
    termEl.insertAdjacentHTML("beforeend",
      `<div class="connect-overlay" id="connov-${this.tabId}">` +
      `<i class="cspin"></i><span class="ctext">连接中</span>` +
      `<span class="cdots"></span></div>`);
    // 键盘字节直发 PTY（契约：input 保留）。外部分类触发链：agent 模式下
    // 整行带自然语言特征（CJK/? 前缀）时不发回车，改送 submit 让 worker 直接
    // 起任务——触发不再依赖 shell hook（sudo su - 等 login shell 重置后仍可用）；
    // 其余按键原样透传，命令执行/英文自然语言仍由 shell hook 分类（行为不变）。
    // 全屏应用（vim/htop 走 alternate buffer）不拦截，Enter 照常送达。
    term.onData(d => {
      // WS 未就绪（连接中/重连间隙）不丢键：缓存待开连后按序回放。旧实现
      // 静默丢弃——刚开页就打字时前几个 IME 提交整段消失（「整行只剩尾巴」
      // 嫌疑之一；回放走 _feedData 同一条 submit 拦截链，语义不旁路）
      if (!this.ws || this.ws.readyState !== 1) {
        this._keyBacklog = this._keyBacklog || [];
        if (this._keyBacklog.length < 64) this._keyBacklog.push(d);
        return;
      }
      this._feedData(d);
    });
    term.onResize(({cols, rows}) => {
      this.sendJson({type: "resize", cols, rows});
      const el = document.getElementById(`size-${this.tabId}`);
      if (el) el.textContent = `${cols}×${rows}`;
      this._remeasureCards();
    });
    // 终端级渲染钩子：decoration 的 onRender 不保证滚动后每帧路过（真机实测
    // 旧 top 悬 2.5s+、盒体整体下移压回显——19geo7 的 approval cover 类）。
    // term.onRender 每次渲染 pass（含滚动驱动）都触发；top 只随 viewportY/
    // 缓冲行数失效，二者没变直接返回，不逐帧量空白。
    if (term.onRender) {
      let lastVp = -1, lastLen = -1;
      term.onRender(() => {
        if (this._dead || !this._slots) return;
        try {
          const b = this.term.buffer.active;
          if (b.viewportY === lastVp && b.length === lastLen) return;
          lastVp = b.viewportY; lastLen = b.length;
          for (const sl of this._slots.values()) {
            if (sl.marker && sl.host) this._fixHostVisibility(sl, sl.host);
          }
        } catch (e) {}
      });
    }
    if (this.term.buffer && this.term.buffer.onBufferChange) {
      this.term.buffer.onBufferChange(() => {
        if (this._remeasurePending) this._remeasureCards();
      });
    }
    // Cmd/Ctrl+Shift+C 有选中时复制（无选中时 Ctrl+C 照常发 ^C 中断）。
    // attachCustomKeyEventHandler 只有一个槽位，多个逻辑必须合并在一个 handler 里
    term.attachCustomKeyEventHandler(ev => {
      if (ev.type === "keydown" && (ev.metaKey || (ev.ctrlKey && ev.shiftKey)) &&
          ev.key.toLowerCase() === "c" && term.hasSelection()) {
        this._copyText(term.getSelection());
        return false;
      }
      // 审批快捷键必须在 xterm 的这个唯一钩子里路由：终端持有焦点时
      // xterm 会处理并吞掉 Enter/Backspace（不冒泡到 document 监听）；
      // 消费后返回 false 阻止 xterm 把按键继续发给 PTY
      if (ev.type === "keydown" && this.approvalKeys(ev)) return false;
      return true;
    });
    // 占位提示驱动:低频轮询足够(显示条件全是廉价缓冲读)
    this._ghostTimer = setInterval(() => this._updateGhost(), 250);
  }

  // onData 主体（WS 就绪后走这里）：submit 拦截链 + 按键透传
  _feedData(d) {
    if (typeof localStorage !== "undefined" && localStorage.getItem("otdbg"))
      console.log("[ot onData]", d.length, JSON.stringify(d.slice(0, 60)));
    // 占位提示追踪:任何非控制字节=有输入痕迹,立即藏——可打印键之外,
    // 中文 IME 上屏是整串 CJK 一次 onData(旧判据只认单字符,打完一整行
    // 灰字占位还贴在输入后面,真机),↑ 历史召回的方向键序列 \x1b[A 同理
    // 漏判;回车/纯控制键(中断/清屏等)后开静默窗,新提示符安静下来重显
    if (this._ghostTrace(d)) { this._ghostHide = true; this._hideGhost(); }
    else { this._ghostHide = false; this._ghostQuietUntil = Date.now() + 800; }
    const enc = new TextEncoder();
    let rest = d, out = "";
    while (rest.length) {
      const i = rest.indexOf("\r");
      const seg = i === -1 ? rest : rest.slice(0, i);
      if (seg) { this._feedLineBuf(seg); out += seg; }
      if (i === -1) break;
      const line = this._lineBuf;
      this._lineBuf = "";
      this._lineCur = 0;
      if (this.mode === "agent" && line && this._looksNL(line) &&
          this.term.buffer.active.type === "normal") {
        if (out) { this.ws.send(enc.encode(out)); out = ""; }
        this.sendJson({type: "submit", text: line, dirty: this._lineDirty});
        this._lastSubmitAt = Date.now();   // 挂载门闩用：见 _mountCard
      } else if (this.mode === "agent" && !line && this._taskActive &&
                 this.term.buffer.active.type === "normal") {
        // 任务期空行 Enter 吞掉：此刻光标可能还在流式卡未落地的预留区里，
        // hook 空行重画的提示符行会写进卡区、掐断连续空白账→卡被提示符墙
        // 覆盖（真机图三）。任务结束后恢复原生空行换行
        if (out) { this.ws.send(enc.encode(out)); out = ""; }
      } else {
        out += "\r";
      }
      this._lineDirty = false;
      rest = rest.slice(i + 1);
    }
    if (out) this.ws.send(enc.encode(out));
  }

  connectWS() {
    const ws = new WebSocket(wsUrl(this.tabId));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    // 开连（或重连）后按序回放 WS 未就绪期缓存的按键（onData 不丢键）
    ws.onopen = () => {
      const bl = this._keyBacklog;
      this._keyBacklog = null;
      if (bl) for (const d of bl) this._feedData(d);
    };
    // PTY 原始字节走二进制帧直写唯一 xterm（契约），JSON 控制事件走 handleMsg
    ws.onmessage = ev => {
      if (ev.data instanceof ArrayBuffer) {
        this._lastByteAt = Date.now();
        const u8 = new Uint8Array(ev.data);
        this._ingestBytes(u8);
      } else this.handleMsg(JSON.parse(ev.data));
    };
    ws.onclose = () => {
      this.setStatus("closed", "连接已关闭");
      this._failPads();
    };
  }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // --- 字节扣流（临界区）---
  // 挂载/补差期间扣住 PTY 二进制帧，防止输出插进 pad 预留区。
  // 嵌套计数：welcome 与 card 临界区可叠加；归零才放行。
  // 用户按键不扣（onData 直发 PTY，提示符在占位区下方）。
  _holdBytes(tag) {
    this._holdDepth = (this._holdDepth || 0) + 1;
    if (!this._holdBuf) this._holdBuf = [];
    this._holdTags = this._holdTags || [];
    this._holdTags.push(tag || "");
  }

  _releaseBytes() {
    if (!this._holdDepth) return;
    this._holdDepth -= 1;
    if (this._holdTags && this._holdTags.length) this._holdTags.pop();
    if (this._holdDepth > 0) return;
    const q = this._holdBuf || [];
    this._holdBuf = [];
    for (const u8 of q) this._writeTerm(u8);
  }

  _holdActive() {
    return (this._holdDepth || 0) > 0;
  }

  // 扣流照旧，但把已扣字节灌进 xterm 并等解析完：重数缓冲前必须调它。
  // PTY 字节顺序即真相——pad 的空行必在其后到达的输出之前，提前灌入不会
  // 错位；不灌就永远数不到刚落地的空行。嵌套扣流下（_settleCard/_mountCard
  // 外层扣着，_ensurePad 内层放行只减一层计数）旧实现按旧缓冲判「还缺行」：
  // 结账时垫的 2 行数不到 → 误夹紧钉死，随后下层卡锚定即永久盖帽，分析卡末行
  // 被切（真机「底部切 ---」）；同款还让新卡 marker 钉在尚未落地的字节之上。
  async _drainHeld() {
    if (this._dead) return;
    const q = this._holdBuf;
    if (q && q.length) {
      this._holdBuf = [];
      for (const u8 of q) this._writeTerm(u8);
    }
    await this._flushWrites();
  }

  _writeTerm(u8) {
    if (this._dead) return;
    this._lastByteAt = Date.now();
    this.term.write(u8);
    this._scheduleHeal();
  }

  // 字节入口：welcome 扣留优先，其次临界区队列，否则直写
  _ingestBytes(u8) {
    if (this._holdWelcome(u8)) return;
    if (this._holdActive()) {
      if (this._holdBuf) this._holdBuf.push(u8);
      return;
    }
    this._writeTerm(u8);
  }

  // --- 连接欢迎横幅（先「已连接…」横幅，后提示符；真机反馈的顺序颠倒 bug）---
  // PTY 字节在横幅未落屏前一律扣住：旧实现「提示符先画、400ms 后在其下方补
  // 横幅再前端补画一行提示符」，视觉顺序颠倒且叠出多个提示符。扣住期间跟踪
  // 最后一次清屏序列（\x1b[2J/\x1b[3J）的位置——清屏会擦掉先写的横幅，所以
  // 横幅只在「最后清屏之后、提示符之前」落屏，清屏前的字节反正会被擦掉，
  // 重放时直接丢弃。释放时机：扣住流里出现 ready 下发的提示符文本（去 ANSI
  // 后匹配）即写横幅 + 重放清屏后字节；1.5s 仍未匹配（提示符对不上/status
  // 文案未到）按超时释放，横幅照写、字节不丢。
  _holdWelcome(u8) {
    const h = this._welcomeHold;
    if (!h) return false;
    if (h.raw) {
      const merged = new Uint8Array(h.raw.length + u8.length);
      merged.set(h.raw);
      merged.set(u8, h.raw.length);
      h.raw = merged;
    } else {
      h.raw = u8;
    }
    // 清屏序列扫描在原始字节上做（\x1b[2J = 1b 5b 32 4a；\x1b[3J 同型）
    for (let i = 0; i + 3 < h.raw.length; i++) {
      if (h.raw[i] === 0x1b && h.raw[i + 1] === 0x5b &&
          (h.raw[i + 2] === 0x32 || h.raw[i + 2] === 0x33) &&
          h.raw[i + 3] === 0x4a) {
        h.cleared = i + 4;
      }
    }
    if (this._welcomeText) {
      const tail = h.cleared ? h.raw.subarray(h.cleared) : h.raw;
      const plain = new TextDecoder().decode(tail)
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
      if (plain.includes(this._welcomeNeed)) {
        this._releaseWelcome();
        return false;
      }
    }
    if (performance.now() - h.at > 1500) {
      this._releaseWelcome();
      return false;
    }
    return true;
  }

  _releaseWelcome() {
    const h = this._welcomeHold;
    this._welcomeHold = null;
    if (this._dead || !h) return;
    if (this._welcomeText) {
      this._writeTerm("\x1b[2m" + this._welcomeText + "\x1b[0m\r\n");
    }
    const tail = h.cleared ? h.raw.subarray(h.cleared) : h.raw;
    if (tail.length) this._writeTerm(tail);
  }

  // 键盘字节注入（等价于用户在终端里敲入）：审批卡「开启新会话」等场景用
  _sendInput(str) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(new TextEncoder().encode(str));
    }
  }

  // 半行缓冲：镜像已透传的可打印输入，供 Enter 时判定自然语言行。带光标位
  // 镜像行内编辑：左右方向键/Home/End/Delete/退格按光标同步（真机：敲完引号
  // 左方向键回引号内补内容再右方向键出来，旧实现遇方向键转义序列即判镜像不
  // 可信清空，submit 只剩光标后的尾巴，worker 降级路径把真整行 \x03 丢弃后按
  // 尾巴重发——AI 收到残句）。
  // 无法镜像的序列（历史召回、Tab 补全、Ctrl+U 杀行、带修饰键的方向键等）仍
  // 清空 + _lineDirty：worker 据此不拿镜像文本重发/不等兜底（hook 上报即真相）。
  _feedLineBuf(seg) {
    const sc = Array.from(seg);
    let cp = Array.from(this._lineBuf);
    let cur = Math.min(this._lineCur, cp.length);
    const drop = () => { cp = []; cur = 0; this._lineDirty = true; };
    for (let i = 0; i < sc.length; ) {
      const ch = sc[i];
      if (ch === "\x1b") {
        // 手动扫 CSI/SS3：只认无修饰参数的光标移动/删除，其余转义一律弃镜像
        let j = i + 1, op = null;
        if (sc[j] === "[") {
          j++;
          let params = "";
          while (j < sc.length && /[0-9;?]/.test(sc[j])) params += sc[j++];
          if (j < sc.length && sc[j] >= "@" && sc[j] <= "~")
            op = this._csiOp(params, sc[j++]);
        } else if (sc[j] === "O" && sc[j + 1] >= "A" && sc[j + 1] <= "Z") {
          op = this._csiOp("", sc[++j]); j++;
        }
        if (!op) { drop(); i = j > i + 1 ? j : i + 1; continue; }
        if (op === "left") cur = Math.max(0, cur - 1);
        else if (op === "right") cur = Math.min(cp.length, cur + 1);
        else if (op === "home") cur = 0;
        else if (op === "end") cur = cp.length;
        else if (op === "del" && cur < cp.length) cp.splice(cur, 1);
        i = j;
        continue;
      }
      if (ch === "\x7f" || ch === "\x08") { if (cur > 0) { cp.splice(cur - 1, 1); cur--; } }
      else if (ch === "\x01") cur = 0;
      else if (ch === "\x05") cur = cp.length;
      else if (ch >= " ") { cp.splice(cur, 0, ch); cur++; }
      else drop();
      i++;
    }
    this._lineBuf = cp.join("");
    this._lineCur = cur;
  }

  // CSI/SS3 终字符 → 光标操作；带修饰参数（Word 跳转等语义随 shell 变）不认
  _csiOp(params, fin) {
    if (fin === "~") {
      if (params === "" || params === "1") return "home";
      if (params === "4") return "end";
      if (params === "3") return "del";
      return null;
    }
    if (params !== "") return null;
    if (fin === "D") return "left";
    if (fin === "C") return "right";
    if (fin === "H") return "home";
    if (fin === "F") return "end";
    return null;
  }

  _looksNL(line) {
    return line.startsWith("?") ||
      /[一-鿿぀-ヿ가-힯　-〿＀-￯]/.test(line);
  }

  // --- 终端剪贴板：右键菜单（复制/粘贴）+ Cmd/Ctrl+Shift+C ---
  // 写剪贴板优先异步 API（https/localhost），http 局域网下 navigator.clipboard
  // 不暴露 → 降级 document.execCommand("copy")：要求当前 DOM 选区存在且处于
  // 用户手势内——xterm 划选就是真实 DOM 选区，mouseup 手势内调用即可。
  _copyText(text) {
    if (!text) return;
    this._clip = text;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => this._execCopy());
    } else {
      this._execCopy();
    }
  }

  _execCopy() {
    try { document.execCommand("copy"); } catch (e) {}
  }

  _pasteText() {
    const done = t => { if (t) { try { this.term.paste(t); } catch (e) {} } };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.readText().then(done, () => done(this._clip));
    } else {
      done(this._clip);
    }
  }

  _showCtxMenu(x, y) {
    const t = this.term;
    const sel = (t.hasSelection && t.hasSelection()) ? t.getSelection() : "";
    const old = document.querySelector(".ctxmenu");
    if (old) old.remove();
    const menu = document.createElement("div");
    menu.className = "ctxmenu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    const mk = (label, disabled, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.disabled = !!disabled;
      b.onclick = () => { menu.remove(); fn(); };
      menu.appendChild(b);
    };
    mk("复制", !sel, () => this._copyText(sel));
    mk("粘贴", false, () => this._pasteText());
    document.body.appendChild(menu);
    // 菜单内部点击不冒泡（避免 document 级关闭先于按钮 click 触发）
    menu.addEventListener("mousedown", ev => ev.stopPropagation());
    setTimeout(() => {
      document.addEventListener("mousedown", () => menu.remove(), {once: true});
    }, 0);
  }

  // =====================================================================
  // 卡片层：一卡一钉（registerMarker + registerDecoration）
  // 定位/滚动/trim 全由 xterm 管；推开文字靠 shell pad 空行（账目见 pad_ledger）。
  // app.js 职责：
  //   1) 挂载：settle → marker → decoration → island.mount → 量高补 pad → 重贴定高
  //   2) 长高：150ms 批量重贴（marker 不动）；流底才补差，否则夹紧
  //   3) 兜底：registerDecoration 失败 → _writePlain 纯文本
  // =====================================================================

  async _settle() {
    const t0 = Date.now();
    while (this._lastByteAt && Date.now() - this._lastByteAt < 120 &&
           Date.now() - t0 < 1000) {
      await this._sleep(40);
    }
  }

  _ensureFeed() {
    if (!this._feedPromise) {
      this._feedPromise = import("/static/ui/ui.js").then(mod => {
        if (this._dead) return null;
        // island 自带样式表单独装载（cssCodeSplit:false 产物 ui.css）
        if (!document.getElementById("ot-ui-css")) {
          const link = document.createElement("link");
          link.id = "ot-ui-css";
          link.rel = "stylesheet";
          link.href = "/static/ui/ui.css";
          document.head.appendChild(link);
        }
        this._feed = mod.createFeed({
          onDecision: (decision, stateText, command, cardId) => {
            this.setStatus(this.status, stateText + " " + (command || ""));
            this._approvalOpen = false;   // 决策完成：思考徽标接管执行空隙期
            this._refreshThink();
            this._releaseDecision(decision, cardId);
          },
          onRescue: accept => {
            // 失败救援卡决策回传（true = 交给 AI）
            this.sendJson({type: "rescue", accept});
          },
          onNewSession: cardId => {
            // 总结卡「开启新会话」：后端只重置模型上下文（不清屏）；PTY 发
            // 一个回车等效换行出新鲜提示符——界面上就像按了一下 Enter
            this.sendJson({type: "new_session"});
            this._sendInput("\r");
          },
        });
        return this._feed;
      }).catch(e => {
        console.error("[ot] 卡片层加载失败:", e);
        this._feedPromise = null;   // 允许下次事件重试
        return null;
      });
    }
    return this._feedPromise;
  }

  // 挂载一张卡：marker 钉流底，decoration 贴纸盖在 pad 预留行上。
  // 整段在扣流临界区内完成，输出不可能插进占位区。失败返回 null。
  async _mountCard(cardId, kind = "phase") {
    await this._settle();
    // 提交在途门闩：task_start 可能先于 \r 的回显/重绘字节到达，此刻 settle 误判
    // 静默、marker 钉在回显行上——卡盖住输入行（真机「中文提交行消失」根因）。
    // 先等提交后首波字节落地再走静默判定；超时（hook 死/无字节）放行老路
    if (this._lastSubmitAt && Date.now() - this._lastSubmitAt < 1500) {
      const t0 = Date.now();
      while (this._lastByteAt <= this._lastSubmitAt && Date.now() - t0 < 1200) {
        await this._sleep(10);
      }
      await this._settle();
    }
    if (this._dead) return null;
    const feed = await this._ensureFeed();
    if (!feed) return null;
    this._holdBytes("card-mount");
    try {
      // 扣流只挡「新到」的字节，队列里已扣的仍在缓冲之外：先灌干净再判盖帽、
      // 再钉 marker。否则 marker 钉在未落地的字节之上，那些字节随后写进新卡的
      // 预留区，新卡一出生就被盖帽（blank=0 → 夹紧到 1 行，永不再长）。
      await this._drainHeld();
      // 锚定窗口：此刻光标下还没有新 marker，最末卡尚未被盖帽——先把它定格
      // 后的最终高度垫满（一旦下层锚定，上层长高只能夹紧截断，真机分析卡
      // 底部切 "---" 即此）。中层卡区已闭合，垫不进去，_settleCard 自会跳过。
      const up = [...this._slots.values()].filter(o => o.marker)
        .sort((a, b) => a.marker.line - b.marker.line).pop();
      if (up && !this._capped(up)) await this._settleCard(up);
      await this._drainHeld();   // 结账垫的空行必须已落地，marker 才钉在真流底
      // 空白尾复用：冻结上游卡多垫的空白尾无法回收（空白行不可回吐），留着
      // 就是卡间永久大缝隙（真机 2026-09-30：三张卡每张之间约 6 行空白）。
      // 空白 run 连续到光标、pad 只追加流底，故把新卡 marker 钉到空白尾首行：
      // 预留区天然含复用语段，卡间缝隙归零。只认冻结槽——活卡还可能长高，
      // 那段空白是它的裕量，不许动。
      let reuse = 0;
      if (up && up.frozen && (up.reserved || 0) > (up.rows || 0)) {
        const buf = this.term.buffer.active;
        const cursorAbs = buf.baseY + buf.cursorY;
        const surplus = Math.min(
          up.reserved - up.rows,
          cursorAbs - (up.marker ? up.marker.line : cursorAbs));
        while (reuse < surplus) {
          const ln = buf.getLine(cursorAbs - 1 - reuse);
          const txt = ln ? ln.translateToString(true) : "";
          if (txt && txt.trim()) break;
          reuse++;
        }
        if (reuse > 0) {
          up.reserved -= reuse;
          // 让出的空白尾下面是新卡不是输出：冻结卡不再保留 +1 保险行，
          // 否则下次 settle 会替它在流底再垫一行
          up.need = Math.min(up.need || 0, up.rows);
        }
      }
      const marker = this.term.registerMarker(reuse ? -reuse : 0);
      if (!marker) return null;
      const slot = {
        id: cardId, marker, decoration: null, host: null,
        reserved: 0, need: 2, rows: 2, clamped: false, ro: null,
        reanchorT: null, mounted: false, pendingMount: false,
        pinnedRows: null,      // 夹紧态钉死的行数（null = 内容自撑 auto）
        forceReapply: false,   // resize 等需重贴 decoration 刷宽度
        // 宁藏不盖（spec §13.1 待办 B）：流式 phase 卡 fund 之前（reserved ≥
        // rows）整卡 visibility:hidden，思考徽标接班——出生 pad 往返窗口里
        // 不再露出「只有一条头」的细条（真机实测每张新卡 0.3~0.8s）
        kind,                  // 'phase' | 'summary' | 'approval'，隐藏只认 phase
        revealed: false,       // fund/盖帽/冻结阀放行后锁存为 true，不复隐
        frozen: false,         // 卡已定格（collapse/final/fail/审批）：不再参与隐藏
        frozenAt: 0,
        padOut: 0,             // 已发未落账的 pad 空行（防并发双垫，见 _ensurePad）
        padP: null,            // 本格 pad 发送链尾 promise（gap=0 waiter 等落地）
      };
      marker.onDispose(() => this._discardSlot(slot));
      // 同 id 防御：旧槽还占着 id 时先整体拆掉（装饰/RO/root）。孤儿槽的
      // decoration 活着就会每帧 onRender → feed.mount(id, el) 与新槽互抢
      // 宿主——React root 每帧在两个 el 间迁移拆建 = 卡片闪烁
      // （真机工具卡跨任务同 id 实锤：TaskRunner 的 index 每任务归 1）
      const stale = this._slots.get(cardId);
      if (stale) this._discardSlot(stale);
      this._slots.set(cardId, slot);
      this._applyDecoration(slot, 2);
      // xterm 按需渲染：task_start 落在「提交→首字节」的空闲间隙时没有缓冲
      // 变化、渲染循环不跑，decoration 的 onRender 不触发、host 拿不到（真机
      // 整卡不显示的根因）。_applyDecoration 尾部已强制刷视口一次，onRender
      // 空闲期即交 host，pad 才能趁光标还在 marker 行时把空行垫在正确位置。
      const t0 = Date.now();
      while (!slot.host && Date.now() - t0 < 500) await this._sleep(10);
      if (slot.host) {
        feed.mount(cardId, slot.host);
        slot.mounted = true;
        this._cardOnScreen(cardId);
        this._watchCardResize(slot);
        await new Promise(r => requestAnimationFrame(() => r()));
        this._watchCardResize(slot);   // React 子节点此时已挂，补观察
        this._fitNeed(slot);
        await this._ensurePad(slot);
        this._reanchor(slot);
      } else {
        // 终端此刻空闲（提交→首字节间隙）：xterm 按需渲染，无缓冲变化就不跑
        // 渲染循环，onRender 不触发、host 拿不到。旧实现在这里 discard+return
        // null → task_start 进不了 store、后续 token 全丢、整卡不显示（真机
        // 「思考界面没出来」）。改为挂起，等首笔输出引发渲染时 onRender 补挂载。
        slot.pendingMount = true;
      }
      return slot;
    } finally {
      this._releaseBytes();
    }
  }

  // 延迟补挂载：onRender 在首笔输出引发的渲染里才拿到 host 时走这里。
  // 与 _mountCard 快路径同一套收尾（feed.mount + RO + 量高 + 补差 + 重锚）。
  _finishMount(slot) {
    if (slot.mounted || !slot.host || this._dead) return;
    slot.pendingMount = false;
    slot.mounted = true;
    this._cardOnScreen(slot.id);
    if (this._feed) this._feed.mount(slot.id, slot.host);
    this._watchCardResize(slot);
    requestAnimationFrame(() => {
      if (!this._dead && slot.host) this._watchCardResize(slot);
    });
    this._fitNeed(slot);
    this._ensurePad(slot)
      .then(() => this._drainHeld())
      .then(() => this._reanchor(slot))
      .catch(() => {});
  }

  // RO 同时观察 host 与卡内 React 子节点：xterm 每帧把 host inline 高度写回
  // 登记行数、外盒不涨；子节点外盒随内容涨——折叠/展开等 UI 驱动的高度变化
  // 靠它抓住（流式长高另有事件通路钩子，双保险）。
  _watchCardResize(slot) {
    if (!slot.host) return;
    const child = slot.host.firstElementChild;
    // 记忆守卫：host/子节点没换就不重建 RO（onRender 每帧渲染都会路过）
    if (slot.ro && slot._roHost === slot.host && slot._roChild === child) return;
    if (slot.ro) { try { slot.ro.disconnect(); } catch (e) {} }
    slot.ro = new ResizeObserver(() => this._scheduleReanchor(slot));
    slot.ro.observe(slot.host);
    if (child) slot.ro.observe(child);
    slot._roHost = slot.host;
    slot._roChild = child || null;
  }

  // 贴/重贴 decoration。marker 不动——钉子在缓冲行上，贴纸可换。
  // 但**元素活着就不换贴纸**：xterm 的新元素要等下次渲染才诞生，而卡高于视口
  // 时 marker 转眼就在视口上方，_refreshStyle 走藏分支 → 新元素永不诞生、
  // slot.host 停在被 remove 的旧节点上 = 整卡消失（真机「总结卡位置不对/被遮」
  // 根因）。高度/宽度都是纯 CSS，改样式即可，无需 dispose+重注册。
  _applyDecoration(slot, heightRows) {
    if (this._dead || !slot.marker) return;
    if (slot.decoration && slot.host && this._hostAlive(slot.host)) {
      this._styleHost(slot, heightRows);
      return;
    }
    // marker 离屏时 vendored xterm **不建元素**（_refreshStyle 的藏分支只对已有
    // 元素 fire onRender）：此刻重贴会 dispose 旧元素而新元素永不诞生 → 卡片
    // 永久消失（真机「总结卡没了」）。改为挂 forceReapply 推迟，等 marker 滚回
    // 视口时由 onRender 补重贴；旧贴纸在位，_fixHostVisibility 仍按相交显示。
    if (slot.decoration && !this._markerOnScreen(slot)) {
      slot.forceReapply = true;
      return;
    }
    if (slot.decoration) {
      try { slot.decoration.dispose(); } catch (e) {}
      slot.decoration = null;
    }
    try {
      const deco = this.term.registerDecoration({
        marker: slot.marker,
        x: 0,
        width: this.term.cols,
        height: Math.max(1, heightRows | 0),
      });
      if (!deco) { this._fallbackPlain(slot); return; }
      deco.onRender(el => {
        slot.host = el;
        // 追加而非覆盖：xterm.css 靠 .xterm-decoration 类给装饰元素
        // position:absolute+z-index（叠在 marker 行上）；覆盖成 ot-card-host
        // 会抹掉该类 → 元素变 static 掉到屏幕块末尾、屏上不可见（真机根因#2）
        el.classList.add("ot-card-host");
        // 高度（钉死 px / 内容自撑 auto）、宽度、显隐与 top 统一在这里落：
        // xterm 只在创建时写一次盒高，且按 marker 行离屏把整元素 display:none
        // ——高卡顶行先出视口时整卡被误藏（正文还在屏上），故自管。
        this._styleHost(slot);
        // 重贴换 host：RO 观察目标跟着迁（记忆守卫防每帧重建）
        this._watchCardResize(slot);
        // 重贴会换新 host 元素：island 内部把 root 迁过去（main.jsx mount）
        if (slot.mounted && this._feed) { this._feed.mount(slot.id, el); return; }
        // 空闲期 refresh 没赶上、首笔输出才引发渲染：补挂载（pendingMount 路径）
        if (slot.pendingMount) this._finishMount(slot);
      });
      slot.decoration = deco;
      slot.forceReapply = false;   // 重贴已成，推迟原因消费掉（防 onRender 回环）
      // xterm 按需渲染：重贴后的新元素要等下次渲染 onRender 才交出；空闲期
      // 重贴（流停后钉死/解钉/resize）会等不到 → host 停在刚 dispose 的旧
      // 元素上（detached、rect 0、卡消失、量高归 1）。同挂载路径：强制刷视口。
      try { this.term.refresh(0, this.term.rows - 1); } catch (e) {}
    } catch (e) {
      this._fallbackPlain(slot);
    }
  }

  // marker 行是否落在视口内——vendored xterm 只为视口内的 marker 建/留元素
  // （_refreshStyle：t = line - ydisp，t<0 || t>=rows 就 display:none）。
  _markerOnScreen(slot) {
    try {
      const buf = this.term.buffer.active;
      if (buf !== this.term.buffer.normal) return false;
      const t = (slot.marker ? slot.marker.line : 0) - buf.viewportY;
      return t >= 0 && t < this.term.rows;
    } catch (e) { return true; }
  }

  // 宁藏不盖：流式 phase 卡 fund 之前整卡隐藏（visibility:hidden，不用
  // display:none——display 下无布局，_fitNeed 的 scrollHeight 恒 0、RO 静默，
  // need 冻结在出生值，解锁瞬间 auto 高度会先盖住下方文本一轮 150ms 批处理）。
  // 只认 phase：审批卡藏了就没法点（决策死锁），总结卡出生即完整。
  // revealed 锁存不复隐：复隐防不了闪烁，后续长高由既有夹紧钉死路径兜住。
  // 只读便宜字段、每帧经 _fixHostVisibility 调用，不得碰 _capped（遍历缓冲）。
  _slotHidden(slot) {
    return !!slot && slot.kind === "phase" && !slot.revealed &&
           !this._padFused && this._hostAlive(slot.host) &&
           slot.reserved < slot.rows;
  }

  _taskSlotHidden() {
    return this._taskCardId != null &&
           this._slotHidden(this._slots.get(this._taskCardId));
  }

  // 隐藏释放沿：fund（reserved 追上 rows）/盖帽/冻结阀。_cardOnScreen 自带
  // taskCardId 门卫（collapse 后自动 no-op，徽标按老语义接管命令空隙期）；
  // _styleHost 立即解除 visibility，不等下一帧 onRender。
  _revealSlot(slot) {
    if (!slot || slot.revealed) return;
    slot.revealed = true;
    this._cardOnScreen(slot.id);
    this._styleHost(slot);
  }

  // 高卡可见性：卡占 [marker+回显偏移, +max(rows,pinnedRows)) 行，与视口
  // [ydisp, ydisp+term.rows) 相交就显示；top 用顶行算（可为负 = 上部滚出、
  // 由 .term 的 overflow:hidden 裁掉，等同终端内容滚屏）。alt 屏保持 xterm 的藏。
  _fixHostVisibility(slot, el) {
    try {
      const buf = this.term.buffer.active;
      if (buf !== this.term.buffer.normal) return;
      // 宁藏不盖：fund 之前的流式 phase 卡整卡隐身（visibility 与 xterm 自己
      // 每帧写回的 display 通道正交，互不干扰），思考徽标接班
      if (this._slotHidden(slot)) {
        el.style.visibility = "hidden";
        return;
      }
      // 零空白盖帽：区内连一行空白都没有（回显/输出把预留区整段插死）——露出
      // 必压活文本，先藏（宁藏不盖）；pad 落地/空白出现后 top 与 maxHeight 自
      // 然放行。已钉死态按钉高走（钉者已保证不越 run）；熔断态不藏（保活优先）。
      // 审批卡豁免：藏了=按钮不可点=决策死锁（agent 等审批、审批等 pad 互为
      // 因果），改由 _floorRows 底线保按钮行可见（宁可短暂压提示符行）
      if (slot.revealed && slot.pinnedRows == null && slot.marker &&
          slot.kind !== "approval" &&
          !this._padFused && this._blankSpan(slot) === 0) {
        el.style.visibility = "hidden";
        return;
      }
      el.style.visibility = "visible";
      // 硬线几何守卫：盒底越过「当前」空白 run 就立刻钉死（实测渲染高，不信任
      // 账目滞后）——cover 的三个来源（账目 rows 滞后于渲染高、auto 自撑冲过
      // run、pad 擦自身回显行把下方内容整体上移）全都在这一步掐断，不等
      // 150ms 批量、也不等 heal 的 250ms 静默门（命令执行期 heal 被挡，真机
      // cover 持续 6s 全耗在这窗口）。100ms 节流：blankSpan/offsetHeight 逐帧
      // 量太贵。钉死后由 _reanchor 非 short 分支在垫够时解钉。
      if (slot.revealed && slot.pinnedRows == null &&
          Date.now() - (slot._guardAt || 0) > 100) {
        slot._guardAt = Date.now();
        // 审批卡底线抬高 safe：钉死也不许低于按钮行（见 _floorRows）
        const safe = Math.max(this._blankSpan(slot), this._floorRows(slot));
        const drawn = Math.max(slot.rows || 1,
          Math.ceil((el.offsetHeight || 0) / this._lineHeight()));
        if (safe >= 1 && drawn > safe) {
          this._clampCard(slot);
          slot.pinnedRows = Math.max(1, safe);
          slot.reserved = safe;
          this._styleHost(slot);
        }
      }
      const ydisp = buf.viewportY;
      // 视觉顶 = marker + 回显偏移：marker 钉在活回显行上时卡体从下一行起，
      // 不把 zsh 原位重画的提示符/回显行盖掉（锚点对齐空白 run，见 _echoSkip）
      const top = (slot.marker ? slot.marker.line : 0) + this._echoSkip(slot);
      const bot = top + Math.max(1, slot.rows || 1, slot.pinnedRows || 1) - 1;
      if (bot >= ydisp && top < ydisp + this.term.rows) {
        el.style.display = "block";
        el.style.top = (top - ydisp) * this._lineHeight() + "px";
      } else {
        el.style.display = "none";
      }
    } catch (e) {}
  }

  // 元素活着就只改样式（不 dispose+重注册）：盒高、宽度、显隐/top 全自管。
  // heightRows 省略时按当前账目（钉死态 pinnedRows，自撑态 auto）。
  _styleHost(slot, heightRows) {
    const el = slot.host;
    if (!this._hostAlive(el)) { slot.forceReapply = true; return; }
    const lh = this._lineHeight();
    const rows = Math.max(1, (heightRows != null ? heightRows
      : (slot.pinnedRows != null ? slot.pinnedRows : slot.rows)) | 0);
    // 硬线上盖：盒矩形任何一帧都不许越过当前空白 run（auto 自撑冲high、
    // 钉死高滞后于擦行上移、账目 rows 滞后渲染高——三个 cover 来源全靠这
    // 一道 maxHeight 在绘制前掐死；onRender 每帧路过，缓冲上移当帧生效）。
    // 内容超出部分盒内裁掉（宁矮不盖），垫够后 _reanchor 解钉/刷新即长回。
    // 编辑浮层开启期不盖：下拉框伸出盒外是本意（同 overflow 豁免口径）
    if (slot.marker && !this._padFused && !(typeof el.querySelector === "function"
      && el.querySelector(".edopen"))) {
      // 审批卡底线：盖帽高度不低过按钮行（空白不够时短暂压提示符行，
      // 好过按钮被裁=决策死锁）；phase/summary 底线 0，硬线不变
      const safe = Math.max(this._blankSpan(slot), this._floorRows(slot));
      el.style.maxHeight = Math.round(safe * lh) + "px";
      el.style.overflow = "hidden";
    } else if (slot.marker) {
      el.style.maxHeight = "none";
    }
    if (slot.clamped || slot.pinnedRows != null) {
      // 钉死截断：xterm 创建时写的盒高不随内容变，这里按已垫行数覆写
      el.style.height = Math.round(rows * lh) + "px";
      el.style.overflow = "hidden";
    } else {
      // 内容自撑：量高（scrollHeight）与流式增长（RO）才有真信号
      el.style.height = "auto";
    }
    const cw = this._cellWidth();
    if (cw > 0) el.style.width = Math.round(this.term.cols * cw) + "px";
    this._fixHostVisibility(slot, el);
    slot.forceReapply = false;
  }

  _hostAlive(el) {
    try { return !!el && el.isConnected; } catch (e) { return false; }
  }

  // 审批卡交互底线（行数）：问句+按钮行（.aphead）的实测高度。夹紧/钉死/
  // 盖帽高度都不许低过它——审批卡被压成细条时按钮不可点，agent 等审批、
  // 审批等 pad 互为因果=死锁（真机审批卡钉死 2 行 18s）。空白 run 不够时
  // 宁可短暂压住下方提示符行（pad 落地解钉即让开），功能优先于观感硬线；
  // 非审批卡恒 0（硬线 coveredTextRows 不变）。
  _floorRows(slot) {
    if (slot.kind !== "approval" || !this._hostAlive(slot.host)) return 0;
    try {
      const head = slot.host.querySelector(".aphead");
      if (!head || typeof head.getBoundingClientRect !== "function") return 0;
      const h = head.getBoundingClientRect().height;
      return h > 0 ? Math.ceil(h / this._lineHeight()) : 0;
    } catch (e) { return 0; }
  }

  // 字宽实测（同 _lineHeight，不拍脑袋）：resize 后刷卡宽用
  _cellWidth() {
    const rowsEl = this.term.element &&
      this.term.element.querySelector(".xterm-rows");
    if (rowsEl) {
      const w = rowsEl.getBoundingClientRect().width;
      if (w > 0 && this.term.cols) return w / this.term.cols;
    }
    return 0;
  }

  // 量高 → need = rows+1（+1 保险，卡与输出间 ≤1 空行）
  _fitNeed(slot) {
    if (!this._hostAlive(slot.host)) return;   // 元素未诞生/已移除：不量，账目不动
    // 编辑框开启期不计账：编辑框浮在卡下方行上、纯属临时 UI——否则 pad 会为
    // 编辑框高度预留空行，取消/拒绝后卡缩回而预留空行无法回收＝卡下大白空
    // （真机图二）。视窗撑高由 EditorCard 自管，与账目解耦
    if (slot.host.querySelector(".edopen")) return;
    let h = 0;
    try { h = slot.host.scrollHeight; } catch (e) {}
    // 量到 0（元素被藏/display:none 间隙）不动账目：rows 打回 1 会把已垫
    // 的空白判成「预留过量」，夹紧/截断误触发
    if (h <= 0) return;
    const n = rowsForPx(h, this._lineHeight());
    if (n > (slot.rows || 0)) {
      slot._growAt = Date.now();
      slot._grows = (slot._grows || 0) + 1;
    }
    slot.rows = n;
    // 流式增长裕量（真机反馈 2026-09-27：SSH 往返追不上 100ms 思考流批量，
    // 卡被钳到空白 run 高度、底部裁切直到换装才恢复）：近 1s 内有过**连续**
    // 长高才按 need+5 请求 pad。空白行不可回吐，落地的裕量尾留由下一张卡
    // 挂载时的空白尾复用收掉（见 _mountCard）。裕量止于增长停（含换装/冻结）。
    // 只认「流式连续长高」：挂载首测的单次跳变与定格后结账各带一次 +5，
    // 落地即不可回收＝每张卡下定格 6 行空白——卡间大缝隙根因（真机
    // 2026-09-30）；这两种场景已有 settle/夹紧解除兜底，不需要裕量。
    slot.need = n + 1 +
      (!slot.frozen && (slot._grows || 0) > 1 &&
       Date.now() - (slot._growAt || 0) < 1000 ? 5 : 0);
    // 编辑框浮层开启期宿主须 overflow visible（浮层伸出盒外），量高/夹紧不得
    // 把它钉回 hidden——否则下拉编辑框被裁（真机「修改后无法编辑」成因之一）
    if (!slot.host.querySelector(".edopen")) slot.host.style.overflow = "hidden";
  }

  // 重贴/decoration 高度策略：流底卡高度由内容自撑（host inline height=auto），
  // 长高只补 pad 不重贴（重贴换新元素=React 重挂载，流式期间会闪）；仅三种情况
  // 重贴：解除夹紧、上游夹紧钉高、resize 刷宽度（forceReapply）。
  _reanchor(slot) {
    if (this._dead || !slot.marker) return;
    this._fitNeed(slot);
    slot.reserved = this._blankSpan(slot);   // 落账只认缓冲，每步重数
    // 缺行就截断（宁矮不盖）：垫得进去的由 _ensurePad 补上后自动解除，
    // 垫不进去的（盖帽：下方已有输出/别的卡）就此钉死到已垫高度。
    // 钉死高度 = 预留空白 run 的行数：卡体顶行就是 run 首行（视觉 top 含
    // 回显偏移，见 _fixHostVisibility），run 有多长盒就多高，盒底恰好压在
    // run 末行上，不会越过它盖住下面的活提示符/输出。
    const short = slot.reserved < slot.rows;
    if (short) {
      const rows = Math.max(1, slot.reserved);
      this._clampCard(slot);
      if (slot.pinnedRows !== rows) {
        slot.pinnedRows = rows;
        this._applyDecoration(slot, rows);
      }
      // 已盖帽（下方被输出/别的卡占住）就别藏了：宁藏不盖只遮「等 pad 落地」
      // 的过渡期；盖帽卡按既有夹紧路径露出已垫部分（真机细条＝等 pad，不是
      // 盖帽），永久盖帽卡藏到冻结阀才放出会让徽标陪跑整段命令空隙
      if (this._capped(slot)) this._revealSlot(slot);
      else this._refreshThink();   // 显→隐沿：夹紧隐藏态让思考徽标接班
      return;
    }
    if (this._padFused) return;   // 熔断后保持钉死截断，不回升
    // 流底卡长高**不重贴**：重贴=dispose+新元素+React root 迁移重挂载，
    // 流式期间批量重贴就是一闪一闪。盒高靠 onRender 的 height:auto 自撑，
    // 长高的记账靠事件钩子+子节点 RO。仅解钉/钉死/resize 才换贴纸。
    if (slot.clamped || slot.pinnedRows != null || slot.forceReapply) {
      slot.clamped = false;
      slot.pinnedRows = null;
      slot.forceReapply = false;
      this._applyDecoration(slot, Math.max(1, slot.rows));
    }
    this._revealSlot(slot);   // reserved ≥ rows：fund 到位，放行（锁存）
    this._followBottom();
  }

  // 跟随滚动：卡长高/补差不产生新缓冲行，xterm 不会自动滚——视口原贴底时
  // 跟到底，否则流式内容藏在折下看不见（真机「分析卡触底还在输出、屏幕不滚」）
  _followBottom() {
    try {
      const b = this.term.buffer.active;
      if (b.viewportY >= b.baseY - 1) this.term.scrollToBottom();
    } catch (e) {}
  }

  // --- Agent 空提示符占位提示（幽灵文本）---
  // 终端是真 PTY、没有输入框：光标停在提示符行尾且一切安静时，挂一个灰字
  // decoration 当占位提示；任何输入痕迹立即藏，回车/控制键后静默窗重显。
  // 显示条件全显示态判定（内容回显进缓冲），shell 改提示符/cd 后依然成立。
  // 输入痕迹判据：含任何非 C0 控制字节即算（含 Backspace \x7f——编辑中也是
  // 痕迹）——见 term.onData 内注释
  _ghostTrace(d) { return /[^\x00-\x1f]/.test(d); }

  _updateGhost() {
    if (this._dead) return;
    let show = this.mode === "agent" && this.interactive &&
               !this._taskActive && !this._approvalOpen && !this._ghostHide;
    let line = -1, x = 0;
    if (show) {
      try {
        const buf = this.term.buffer.active;
        if (buf.type !== "normal") show = false;
        else {
          line = buf.baseY + buf.cursorY;
          x = buf.cursorX;
          const t = buf.getLine(line).translateToString(true);
          // 光标须在行尾（容尾随空白）、行非空（=提示符行）、PTY 字节静默
          show = t.trim() !== "" && x >= t.replace(/\s+$/, "").length &&
                 Date.now() - (this._lastByteAt || 0) > 400 &&
                 Date.now() >= this._ghostQuietUntil;
        }
      } catch (e) { show = false; }
    }
    if (!show) return this._hideGhost();
    const key = line + ":" + x;
    if (this._ghostDec && this._ghostKey === key) return;
    this._hideGhost();
    try {
      this._ghostMarker = this.term.registerMarker(0);   // 钉此刻光标行
      if (!this._ghostMarker) return;
      this._ghostDec = this.term.registerDecoration({
        marker: this._ghostMarker, x,
        width: Math.max(1, this.term.cols - x), height: 1,
      });
      if (!this._ghostDec) return this._hideGhost();
      this._ghostKey = key;
      this._ghostDec.onRender(el => {
        el.classList.add("ot-ghost");
        el.textContent = "输入自然语言任务，AI 帮你执行；? 前缀强制 AI，! 强制命令";
      });
      try { this.term.refresh(0, this.term.rows - 1); } catch (e) {}
    } catch (e) { this._hideGhost(); }
  }

  _hideGhost() {
    if (this._ghostDec) {
      try { this._ghostDec.dispose(); } catch (e) {}
      this._ghostDec = null;
    }
    if (this._ghostMarker) {
      try { this._ghostMarker.dispose(); } catch (e) {}
      this._ghostMarker = null;
    }
    this._ghostKey = "";
  }

  // 定格即结账：卡还在流底（垫得进去）时把最终高度一次垫满。等 React 把
  // 定格内容渲染完再量（两帧），否则量到半截高度，随后下层卡一锚定就永久
  // 盖帽、只能截断（真机分析卡底部切 "---" 即此）。同卡并发只跑一次。
  _settleCard(slot) {
    if (this._dead || !slot || !slot.marker) return Promise.resolve();
    if (slot.settling) return slot.settling;
    if (slot.reanchorT) { clearTimeout(slot.reanchorT); slot.reanchorT = null; }
    slot.settling = (async () => {
      this._holdBytes("card-settle");
      try {
        await new Promise(r => requestAnimationFrame(() => r()));
        await new Promise(r => requestAnimationFrame(() => r()));
        if (this._dead || !slot.marker) return;
        await this._drainHeld();
        this._fitNeed(slot);
        slot.reserved = this._blankSpan(slot);
        await this._ensurePad(slot);
        await this._drainHeld();   // 结账的空行落地了才算得准，否则白垫一轮
        this._reanchor(slot);
      } finally {
        this._releaseBytes();
        slot.settling = null;
      }
    })();
    return slot.settling;
  }

  // 放行决策前先给审批卡结账：worker 一收到决策就注入命令，输出随即从卡底
  // 流走——预留区被真实输出断开即永久盖帽，此后卡只能按已垫高度截断（真机
  // 审批卡 7 行内容只剩 2 行、"是否同意…" 切在半句）。此刻 shell 正阻塞等
  // 审批、字节静默，是最后一块垫得进去的窗口。垫不上也不许拖住决策：600ms
  // 兜底放行（审批响应速度优先于占位美观）。
  _releaseDecision(decision, cardId) {
    let sent = false;
    const once = () => {
      if (sent || this._dead) return;
      sent = true;
      this.sendJson({type: "decision", decision});
    };
    const slot = cardId == null ? null : this._slots.get(cardId);
    if (!slot || !slot.marker || this._padFused) { once(); return; }
    const timer = setTimeout(once, 600);
    Promise.resolve().then(() => this._settleCard(slot))
      .catch(() => {})
      .then(() => { clearTimeout(timer); once(); });
  }

  // 流式长高：攒 150ms 统一重贴（禁止逐 token 撕贴纸）。
  // 扣流窗口必须从「感知到长高」就开始：150ms 批量延迟 + pad 往返期间，
  // 命令回显/输出会写进未垫够的卡区，打破卡下空白连续区 → 卡被夹紧截断、
  // 多行输出更是永久盖帽（分析卡再也长不开，真机「输出遮挡分析卡」根因）。
  // 纯分析流式期间 PTY 本就静默（ai 走 JSON 事件），提前扣流无代价。
  _scheduleReanchor(slot) {
    if (this._dead) return;
    this._fitNeed(slot);
    if (slot.revealed && slot.rows > slot.reserved && !this._capped(slot)) {
      // 感知即钉盒到已垫高度：150ms 批量窗里 auto 盒会越过空白 run 盖住下方
      // 活提示符行（硬线 coveredTextRows）。垫够解钉后卡自己长回（_reanchor
      // 非 short 分支清 pinnedRows）；垫不够就维持钉死=截断，宁矮不盖。
      if (slot.pinnedRows == null) {
        this._clampCard(slot);
        // 审批卡钉死高度不低过按钮行（_floorRows）：细条态按钮不可点=死锁
        slot.pinnedRows = Math.max(1, slot.reserved, this._floorRows(slot));
        this._styleHost(slot);
      }
      this._holdBytes("card-grow");
      slot.growHolds = (slot.growHolds || 0) + 1;
    }
    if (slot.reanchorT) clearTimeout(slot.reanchorT);
    slot.reanchorT = setTimeout(async () => {
      slot.reanchorT = null;
      const grown = slot.growHolds || 0;
      slot.growHolds = 0;
      if (this._dead || !slot.marker) {
        for (let i = 0; i < grown; i++) this._releaseBytes();
        return;
      }
      this._holdBytes("card-reanchor");
      try {
        await this._ensurePad(slot);
        await this._drainHeld();
        this._reanchor(slot);
      } finally {
        this._releaseBytes();
        // 归还长高窗口的扣流（含卡被丢弃不再批量的情形）
        for (let i = 0; i < grown; i++) this._releaseBytes();
      }
    }, 150);
  }

  // 流式文本缓存（_fallbackPlain 兜底用）
  _trackText(id, text) {
    if (!this._cardsText) this._cardsText = new Map();
    this._cardsText.set(id, (this._cardsText.get(id) || "") + (text || ""));
  }

  // 夹紧：卡 DOM 截断，不给卡内滚动条——宁可矮，不许盖网格
  _clampCard(slot) {
    slot.clamped = true;
    if (slot.host && !slot.host.querySelector(".edopen")) {
      slot.host.style.overflow = "hidden";
    }
  }

  // --- pad 账本（先数后打 + 落账只认缓冲）---

  // 区界：光标行，但被「下方最近一张卡的 marker」夹紧——每卡账目独立，
  // 不借邻卡 pad 顶出来的空白。
  _zoneLimit(slot) {
    const buf = this.term.buffer.active;
    let end = buf.baseY + buf.cursorY;
    for (const o of this._slots.values()) {
      if (o !== slot && o.marker &&
          o.marker.line > slot.marker.line && o.marker.line < end) {
        end = o.marker.line;
      }
    }
    return end;
  }

  // 回显偏移：从 marker 扫到**首行空白** = 卡视觉顶/区顶对齐空白 run 首行，
  // 领头所有非空白行（活提示符/回显及其折行）整体跳过——盒体任何一帧都不压
  // 活文本行。旧判据只跳 1 行：回显折两行时第二行仍被盒顶盖住（真机 cover）。
  // 区内全无空白（被回显/输出整段插死）返回 0 + blankSpan=0 → 走隐藏路径
  // （宁藏不盖）；pad 落地擦掉回显行后自然对齐回空白 run 首行。
  _echoSkip(slot) {
    if (!slot.marker) return 0;
    try {
      const buf = this.term.buffer.active;
      for (let i = 0; i < 8; i++) {
        const line = buf.getLine(slot.marker.line + i);
        const s = line ? line.translateToString(true) : "";
        if (!s || !s.trim()) return i;
      }
      return 0;
    } catch (e) {
      return 0;
    }
  }

  // 预留区顶行 = marker + 回显偏移：账目与视觉都从卡真正压住的第一行起算，
  // marker 钉在活回显行上时不把那行非空白算进/盖进预留区（锚点对齐空白 run）。
  _regionStart(slot) {
    return slot.marker ? slot.marker.line + this._echoSkip(slot) : 0;
  }

  // 预留区 = 从区顶（marker+回显偏移）起的**连续**空白行数，遇真实输出/区界
  // 即停。唯一权威是缓冲；连续才作数——中间夹了输出，pad 就再也垫不进本区了。
  // 两种几何下含义一致：都等于「卡视觉顶行之下（含顶行若是空白）的连续空白」，
  // padGap(need=rows+1, 本值) 在两种几何里都恰好垫到卡底再留一行保险。
  _blankSpan(slot) {
    if (!slot.marker) return 0;
    try {
      return blankRun(this.term.buffer.active, this._regionStart(slot),
        this._zoneLimit(slot));
    } catch (e) {
      return 0;
    }
  }

  // 被盖帽：pad 只能追加在流底，垫不进本卡预留区。情形——下方已有别的卡
  // （区界被邻卡 marker 夹紧）、预留区下方已有真实输出/回显（连续空白断在
  // 那儿）、光标跑到 marker 上方（异常）。盖帽卡长高只许夹紧截断，不许再补差。
  // 容忍一行（仅当光标行非空白）：zsh 会把活提示符行原位重画到 pad 空白正
  // 下方、光标就停在这行非空白上，空白 run 结构上永远数不到光标行——旧判据
  // 「run 必须触到光标」在 zsh 下恒假，流底卡出生即永久盖帽（真机卡钉死 2 行
  // 不长高的根因）。放行「区尾 == 光标-1 且光标行非空白」不漏判真实输出：
  // run 只停在非空白行或区界（=光标行）上，区尾 == 光标-1 时断点就是光标自己
  // 站的那行（活提示符/半行输出），卡体（区尾之上）压不到它，pad 也只会注到
  // 光标处、落在这行之下；光标行是空白时仍走严格判据——那种几何下 run 要么
  // 本来就数到光标（距离 0），要么断在真实输出行（输出占住光标-1，必须盖帽）。
  _capped(slot) {
    if (!slot.marker) return true;
    try {
      const buf = this.term.buffer.active;
      const cursorAbs = buf.baseY + buf.cursorY;
      if (cursorAbs < slot.marker.line) return true;
      const limit = this._zoneLimit(slot);
      if (limit < cursorAbs) return true;               // 下方有别的卡
      const end = this._regionStart(slot) + this._blankSpan(slot);
      if (end >= cursorAbs) return false;
      if (end < cursorAbs - 1) return true;             // 输出断在更上方：盖帽
      let s = "";
      try {
        const cl = buf.getLine(cursorAbs);
        s = cl ? cl.translateToString(true) : "";
      } catch (e) { s = ""; }
      return !(s && s.trim());   // 光标行非空白=活提示符行 → 容忍；空白 → 盖帽
    } catch (e) {
      return true;
    }
  }

  // 补差：先数后打，只补真缺口；落账只认缓冲（应答只是唤醒）。
  // 扣流临界区内完成，输出插不进占位区。
  // padOut = 已发未落账的空行数：并发/连发的 _ensurePad（挂载 vs 150ms 批量 vs
  // 自愈）都按「旧缓冲」数缺口，各自发一轮 = 双倍空行落地 = 卡下永久大白空
  // （真机审批卡下 9 行空白根因：pad 往返 > 150ms 批量窗时两路并发）。在途
  // 计入后第二路看到缺口已填即 gap=0；整链收尾（所有排队发送 ack 完）落账重置。
  async _ensurePad(slot) {
    if (this._dead || !slot.marker || this._padFused) return;
    // 先灌已扣字节再数：外层临界区（挂载/结账/自愈）扣着时，pad 的空行可能
    // 已在队列里没落缓冲，按旧缓冲数会多垫一轮（垫过不能回吐 = 卡间空白）
    await this._drainHeld();
    let blank = this._blankSpan(slot);
    slot.reserved = blank;
    if (this._capped(slot)) {
      // 垫不进本区（下方已有输出/别的卡）：预留够高就原地不补；不够只能
      // 夹紧截断（宁可矮不许盖）。大头在 _mountCard 锚定新卡前的 settle
      // 窗口里提前补掉。
      if (blank < slot.rows) this._clampCard(slot);
      this._revealSlot(slot);   // 盖帽即放行，宁藏不盖只遮等 pad 的过渡期
      return;
    }
    const gap = padGap(slot.need, blank + (slot.padOut || 0));
    if (gap <= 0) {
      // 在途额已盖住缺口、但发送还在 _padQ 里排队等 ack：结账类调用方
      // （决策/边界门闩）若看 gap=0 就返回会立刻放行，回显抢在在途空行
      // 前面落进本区把连续空白打断 = 永久盖帽（真机审批卡 r5/n9 钉死根因）。
      // 等本格发送链收尾 + 空行灌进缓冲再返回，放行序才等于 PTY 序。
      if (slot.padOut > 0 && slot.padP) {
        await slot.padP.catch(() => {});
        await this._drainHeld();
      }
      return;
    }
    this._holdBytes("card-pad");
    try {
      this._padQ = this._padQ.then(async () => {
        if (this._dead || !slot.marker) return;
        this._padSlot = slot;
        slot.padOut = (slot.padOut || 0) + gap;
        // mirror：可信的半行镜像交给 worker 收纳/复原——pad 注入不再吞掉
        // 用户正在敲的输入（dirty 时省略，worker 走旧的丢弃路径）
        this.sendJson({type: "pad", pad: gap,
                       mirror: this._lineDirty ? undefined : this._lineBuf});
        let timedOut = true;
        await new Promise(r => {
          const done = () => { timedOut = false; r(); };
          this._padWait = done;
          setTimeout(done, 8000);
        });
        if (timedOut) {
          // 这轮空行不会落地：把在途额退回去，后续才敢再补（熔断另兜底）
          slot.padOut = Math.max(0, (slot.padOut || 0) - gap);
          this._padFailStreak++;
          if (this._padFailStreak >= 2) this._fusePads();
        } else {
          this._padFailStreak = 0;
        }
        this._padSlot = null;
      }).catch(() => {});
      slot.padP = this._padQ;   // 本格发送链尾：gap=0 waiter 用它等在途额落地
      await this._padQ;
    } finally {
      this._releaseBytes();
    }
    // 落账前把 pad 的空行真灌进 xterm 并等解析完：term.write 是异步的，外层
    // 还扣着流时 _releaseBytes 也不会放行（计数只减一层），立刻重数会按旧缓冲
    // 判「还缺行」而误夹紧（真机分析卡被截断的来源之一）
    await this._drainHeld();
    slot.padOut = 0;   // 整链发送都已 ack：在途额消费完，落账只认缓冲
    blank = this._blankSpan(slot);
    slot.reserved = blank;
    if (padGap(slot.need, blank) > 0) this._clampCard(slot);
  }

  // 等已提交的 write 被解析完（空串回调排在队尾）；回调不来则 120ms 兜底
  _flushWrites() {
    return new Promise(r => {
      let done = false;
      const fin = () => { if (!done) { done = true; r(); } };
      try { this.term.write("", fin); } catch (e) { fin(); }
      setTimeout(fin, 120);
    });
  }

  _onPadded() {
    if (this._padWait) {
      const r = this._padWait;
      this._padWait = null;
      r();
    }
    // 应答不作凭据只唤醒：落账是 _ensurePad/_reanchor 每步重数缓冲空白
    // pad 擦自身回显行把缓冲整体上移：各卡 es/视觉顶随即过时。若此后输出
    // 恰停（等审批/模型思考），不再路过 onRender → 旧 top 悬着压回显（真机
    // 剩的唯一 cover 类）。同步全卡重贴一次 top/显隐，不等下一笔字节。
    for (const sl of this._slots.values()) {
      if (sl.marker && sl.host) this._fixHostVisibility(sl, sl.host);
    }
  }

  _fusePads() {
    this._padFused = true;
    this.setStatus(this.status, "占位补差已熔断，卡片按已垫高度截断");
    for (const slot of this._slots.values()) {
      this._clampCard(slot);
      slot.padOut = 0;   // 熔断后不再补差：在途额清零，落账只认缓冲
      slot.padP = null;
      // 钉死到已垫高度：熔断后不再补差，auto 高度会压住后续输出
      // （钉死高度 = 预留空白 run 行数；卡体顶行即 run 首行，盒底不越过
      // run 末行，见 _reanchor）
      if (slot.marker) {
        slot.reserved = this._blankSpan(slot);
        const rows = Math.max(1, slot.reserved);
        slot.pinnedRows = rows;
        this._applyDecoration(slot, rows);
      }
    }
  }

  // ws 断开：放行在途 pad，不卡死队列（§5.9）
  _failPads() {
    if (this._padWait) {
      const r = this._padWait;
      this._padWait = null;
      r();
    }
  }

  // decoration 失败兜底：markdown 纯文本写进网格（唯一允许的前端 write 路径，
  // 写的是内容不是空行占位）
  _fallbackPlain(slot) {
    const md = this._cardsText && this._cardsText.get(slot.id);
    if (md) this._writePlain(md.replace(/[*`#>|]/g, ""));
    this.setStatus(this.status, "卡片渲染失败，已降级为纯文本");
  }

  _writePlain(text) {
    const s = String(text || "").replace(/\r/g, "");
    this._wp(s.endsWith("\n") ? s : s + "\n");
  }

  _discardSlot(slot) {
    if (slot.reanchorT) clearTimeout(slot.reanchorT);
    if (slot.ro) { try { slot.ro.disconnect(); } catch (e) {} }
    if (slot.decoration) { try { slot.decoration.dispose(); } catch (e) {} }
    // 同 id 被新槽顶替后，旧槽 marker 迟到 dispose 不得删掉新槽（unmount
    // 的是新槽的 React root = 卡片凭空消失）
    if (this._slots.get(slot.id) === slot) {
      if (this._feed) this._feed.unmount(slot.id);
      this._slots.delete(slot.id);
    }
  }

  _destroySlots() {
    if (this._healT) { clearTimeout(this._healT); this._healT = null; }
    for (const slot of [...this._slots.values()]) this._discardSlot(slot);
    this._slots.clear();
  }

  // 新会话（/clear）：销毁全部装饰钉并清空 island 卡片流
  _clearCards() {
    this._destroySlots();
    if (this._feed) this._feed.handle({kind: "clear"});
    this._phaseLive = false;
    this._summaryShown = false;
    this._approvalOpen = false;
    this._refreshThink();
  }

  // §5.6 重试门：补差重试以 _lastByteAt 不变为门（PTY 静默才能证明缓冲未被推进）。
  // 静默 250ms 后按计数缺口重试一次，仍失败进夹紧。Task 7 的 _healAll 落实此门：
  //   if (this._lastByteAt && Date.now() - this._lastByteAt < 250) continue;
  _remeasureCards() {
    if (this._dead) return;
    const buf = this.term.buffer.active;
    if (buf !== this.term.buffer.normal) {
      // vim/htop 备用缓冲期间推迟，回到主缓冲再补
      this._remeasurePending = true;
      return;
    }
    this._remeasurePending = false;
    // 只有最靠流底的卡能物理补差；上游卡一律夹紧（scrollback 中间插不进新行）
    const slots = [...this._slots.values()].filter(s => s.marker);
    slots.sort((a, b) => a.marker.line - b.marker.line);
    const bottom = slots[slots.length - 1] || null;
    for (const slot of slots) {
      slot.forceReapply = true;   // 列数/行高变了：重贴 decoration 刷宽度
      this._scheduleReanchor(slot);
      if (slot !== bottom) this._clampCard(slot);
    }
  }

  // §5.7 idle 自愈：字节静默 250ms 后，对流底卡重数空白区补差
  _scheduleHeal() {
    if (this._dead) return;
    if (this._healT) clearTimeout(this._healT);
    this._healT = setTimeout(() => {
      this._healT = null;
      this._healAll();
    }, 250);
  }

  _healAll() {
    if (this._dead || this._padFused) return;
    if (!this.term || !this.term.buffer) return;  // 测试桩/未初始化终端无 buffer
    const buf = this.term.buffer.active;
    if (buf !== this.term.buffer.normal) return;
    for (const slot of [...this._slots.values()]) {
      if (!slot.marker) continue;
      // 冻结阀：任务已定格（collapse/final/fail/审批）却一直没 fund 的隐藏卡
      // （既没盖帽、pad 又迟迟不落地的僵局），2s 后按夹紧路径放出，不留隐形卡
      if (slot.frozen && !slot.revealed && Date.now() - slot.frozenAt > 2000) {
        if (slot.reserved < slot.rows) {
          this._clampCard(slot);
          // 审批卡放出高度不低过按钮行（_floorRows），细条态按钮不可点=死锁
          const rows = Math.max(1, slot.reserved, this._floorRows(slot));
          if (slot.pinnedRows !== rows) {
            slot.pinnedRows = rows;
            this._applyDecoration(slot, rows);
          }
        }
        this._revealSlot(slot);
      }
      // §5.6 重试门：盖帽卡（下方已有输出/别的卡）垫不进差，不再发 pad。
      // 但钉死的高度会过时——下层卡的占位落地后，本卡预留区其实变宽了
      // （真机分析卡被钉在半截高度、要等内容再次变化才解开）。所以钉死/
      // 夹紧的盖帽卡仍要重锚一次：reserved ≥ rows 即解钉，卡自己长回来。
      const capped = this._capped(slot);
      if (capped && !slot.clamped && slot.pinnedRows == null) continue;
      // PTY 仍在输出时不重试（缓冲可能被推进）
      if (this._lastByteAt && Date.now() - this._lastByteAt < 250) continue;
      this._holdBytes("card-heal");
      Promise.resolve()
        .then(() => (capped ? null : this._ensurePad(slot)))
        .then(() => this._drainHeld())
        .then(() => this._reanchor(slot))
        .finally(() => this._releaseBytes());
    }
    // 欠账自循环：_scheduleHeal 只由字节（_writeTerm）/任务事件唤醒，PTY 静默
    // 期（等审批、模型思考）没人重试钉死卡——pad 在途时钉到半截、落地后无人
    // 解钉=永久细条（真机审批卡压 2 行 18s 根因）。仍有「未盖帽且钉死/夹紧/
    // 未 fund」的卡就 250ms 自排下一次；fund/盖帽/熔断任一达成即停（熔断在
    // 本函数开头早退）。每轮 _ensurePad 自带在途去重，不会重复发 pad。
    for (const s of this._slots.values()) {
      if (!s.marker) continue;
      const owed = s.pinnedRows != null || s.clamped || s.reserved < s.rows;
      // 盖帽且仍欠账：垫不进本区，夹紧是终态（宁矮不盖），不空转；
      // 盖帽但已 fund：_reanchor 非 short 分支解钉即可，不需要 pad，也要唤醒
      if (owed && (!this._capped(s) || s.reserved >= s.rows)) {
        this._scheduleHeal();
        break;
      }
    }
  }

  // 异步写：仅用于极少数不走 ConPTY 的系统提示（错误/关闭），卡片禁用
  _wp(data) {
    return new Promise(r => {
      if (this._dead) { r(); return; }
      this.term.write(data, r);
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 网格行高实测：字号×lineHeight 随 DPI 变化，不能拍脑袋（约束5）
  _lineHeight() {
    const rowsEl = this.term.element &&
      this.term.element.querySelector(".xterm-rows");
    if (rowsEl) {
      const h = rowsEl.getBoundingClientRect().height;
      if (h > 0 && this.term.rows) return h / this.term.rows;
    }
    return 15;   // 兜底：13px 字号常见行高
  }

  // --- AI 任务生命周期（状态栏/计时器）+ 事件转发 island ---

  async _onTaskStart() {
    this._taskActive = true;
    this._lastSummaryMd = null;
    this._summaryShown = false;   // 新一轮：总结卡未挂，思考徽标可接班空隙期
    this._setStopVisible(true);
    this._startTimer();
    this._openPhaseCard();
  }

  // 开一张新分析卡分区（任务启动 / 定格后的新阶段）。store 的 task_start 必须
  // 先于该卡后续 token 落地——_cardReady 链串行化（spec §3.1 多阶段叙事）
  _openPhaseCard() {
    const cardId = ++this._cardSeq;
    this._taskCardId = cardId;
    // 卡此刻未必上屏：终端空闲（无 PTY 字节）时 xterm 不跑渲染循环，host 拿不到、
    // 卡 pendingMount 不可见（模型纯推理空隙期）。上屏前思考徽标先接班，
    // 挂载完成由 _cardOnScreen 接班回卡本体——否则空隙期卡与徽标都不显＝假死
    this._phaseLive = false;
    this._refreshThink();
    // 链在在途开卡之后（工具卡/上一阶段卡可能还在挂载临界区内）：挂载全程
    // 扣流，两段并发会把 marker 钉错
    this._cardReady = this._cardReady.then(() => this._mountCard(cardId)).then(slot => {
      if (!slot) return null;
      return this._ensureFeed().then(f => f && f.handle({kind: "task_start", id: cardId}));
    });
    return cardId;
  }

  _onAiToken(text) {
    // 定格后到达的 token 在新流点开新卡（spec §3.1「卡—命令—卡」节奏）
    if (!this._taskCardId && this._taskActive) this._openPhaseCard();
    const id = this._taskCardId;
    if (!id) return;
    this._trackText(id, text);
    this._cardReady.then(() => this._ensureFeed())
      .then(f => f && f.handle({kind: "ai_token", text: text || ""}))
      // 流式长高不能只靠 RO：xterm 每帧把装饰元素 inline 高度写回登记行
      // 数，外盒不涨 RO 永久静默——事件通路自己挂补差钩子；视口原贴底时
      // 跟随滚到底（流式内容超出屏幕自动滚动显示最新，用户上翻则不打扰）
      .then(() => { const s = this._slots.get(id); if (s) this._scheduleReanchor(s); })
      .then(() => this._followBottom());
  }

  _onAiThink(text) {
    if (!this._taskCardId && this._taskActive) this._openPhaseCard();
    const id = this._taskCardId;
    if (!id) return;
    this._cardReady.then(() => this._ensureFeed())
      .then(f => f && f.handle({kind: "ai_think", text: text || ""}))
      .then(() => { const s = this._slots.get(id); if (s) this._scheduleReanchor(s); })
      .then(() => this._followBottom());
  }

  // 工具调用小卡（ai_tool start/end，worker 在 ai_collapse 定格分析卡后发）：
  // start 在流底挂 tool 卡（kind 同 phase——宁藏不盖/夹紧兜底全复用），end 经
  // store 同 id 置状态徽标（卡高不变，零 pad 往返）。不占 _taskCardId：工具卡
  // 不是流式分析卡，之后的模型输出由 _onAiToken/_onAiThink 开新分析卡。
  _onAiTool(ev) {
    const id = "tool" + ev.id;
    if (ev.phase === "start") {
      this._cardReady = this._cardReady.then(() => this._mountCard(id, "phase")
        .then(slot => {
          if (!slot) return null;
          return this._ensureFeed().then(f => f && f.handle({
            kind: "tool_start", id, name: ev.name || "", args: ev.args || "",
          }));
        }));
    } else {
      this._cardReady = this._cardReady.then(() => this._ensureFeed())
        .then(f => f && f.handle({kind: "tool_end", id, failed: !!ev.failed}));
    }
  }

  // 阶段边界前置结账：worker 在**执行命令前**发 ai_boundary 并等本片 ack
  // （700ms 兜底）——命令回显在 PTY 里必须落在 pad 空行**之后**，否则回显
  // 插进未垫够的卡区把连续空白打断 = 永久盖帽截断（真机分析卡末行被切、
  // 下条回显贴脸根因：旧序 ai_collapse 在 exec_start 才发，回显早已进区）。
  // 结账范围是**全部存活卡**而不只流底任务卡：待审批/已审批卡的在途 pad
  // 同样排在 _padQ 里，只结任务卡会漏掉它们 → 回显先落、审批卡永久钉死
  // （真机 r5/n9 审批卡）。此刻流底卡内容已终（模型消息以 tool_call 收尾，
  // token 批 flush 完即最终高），结账垫满后回显自然落在卡区下方。
  // 只结账不定格——定格仍沿 ai_collapse。
  _onBoundary() {
    const ack = () => {
      try { this.sendJson({type: "boundary_settled"}); } catch (e) {}
    };
    const slots = [];
    for (const s of this._slots.values()) if (s.marker) slots.push(s);
    if (!slots.length || this._padFused) { ack(); return; }
    this._ensureFeed()
      .then(f => { f && f.flush && f.flush(); })
      .then(() => Promise.all(slots.map(s => this._settleCard(s))))
      .catch(() => {})
      .then(ack);
  }

  _onAiCollapse() {
    // v5 语义「阶段边界」：定格当前卡，此后 token 开新卡由 store 负责
    // 先冲刷 100ms token 批再定格：尾批进卡后 settle 量到的才是最终高度，
    // 否则定格后尾批冲刷长高 → 预留区已闭合 → 卡底被下方输出切半行（真机）
    this._ensureFeed().then(f => {
      if (!f) return;
      f.flush && f.flush();
      f.handle({kind: "ai_collapse"});
    });
    const slot = this._taskCardId ? this._slots.get(this._taskCardId) : null;
    if (slot) { slot.frozen = true; slot.frozenAt = Date.now(); }
    this._taskCardId = null;
    // 阶段定格→流底无活卡：命令执行/等下一段模型输出期间由思考徽标接班
    this._phaseLive = false;
    this._refreshThink();
    // 定格即结账：此刻卡还在流底，把最终高度垫满；等下一条命令的输出流到
    // 卡下方就晚了（盖帽后只能截断）
    if (slot) this._settleCard(slot);
  }

  _onAiCard(markdown) {
    this._mountSummary(markdown, null, false);
  }

  _onFinal(text) {
    this._taskActive = false;
    this._endTimer();
    this._setStopVisible(false);
    this._refreshThink();
    const reuse = this._taskCardId;
    const slot = reuse != null ? this._slots.get(reuse) : null;
    if (slot) { slot.frozen = true; slot.frozenAt = Date.now(); }
    this._taskCardId = null;
    // 门闩（spec §3.3）：卡仍在流底（区内空白一直延伸到光标）→ 总结原地换装；
    // 下方已有命令输出/别的卡 → store 定格 + 裁掉流进本卡的总结正文尾
    // （trimMd），总结卡在流底新开分区。旧判据「快照后无新字节」太脆：
    // 用户敲键回显/read_file 等不走 ai_collapse 的 PTY 字节都会误判成
    // 跑过命令，换装退化成新开卡 = 分析卡与总结卡内容重复（真机）。
    const transform = !!slot && !this._capped(slot);
    this._ensureFeed().then(f => f && f.handle(
      transform ? {kind: "final", md: text || ""}
                : {kind: "ai_collapse", trimMd: text || ""}));
    this._mountSummary(text, transform ? reuse : null, transform);
    // 换装路径由 _mountSummary 自己结账；新开总结卡时把定格的分析卡垫满
    if (slot && !transform) this._settleCard(slot);
    this._scheduleHeal();
  }

  // 总结挂载：transform = 原地换装（store 的 final 已把同 id 卡改型，这里只按
  // 新内容重贴定高）；否则流底新开一张总结卡。
  async _mountSummary(md, reuseId, transform) {
    if (!md || md === this._lastSummaryMd) return;
    this._lastSummaryMd = md;
    this._summaryShown = true;   // 总结卡已挂：思考徽标退场（本轮叙事收束）
    this._phaseLive = false;
    this._refreshThink();
    if (transform && reuseId != null && this._slots.has(reuseId)) {
      const slot = this._slots.get(reuseId);
      await new Promise(r => requestAnimationFrame(() => r()));
      this._holdBytes("card-transform");
      try {
        await this._ensurePad(slot);
        this._reanchor(slot);
      } finally {
        this._releaseBytes();
      }
      return;
    }
    const cardId = ++this._cardSeq;
    this._cardsText && this._cardsText.set(cardId, md);
    const slot = await this._mountCard(cardId, "summary");
    if (!slot) return;
    this._ensureFeed().then(f => f && f.handle({kind: "ai_card", md, id: cardId}));
  }

  // 任务中止（denied/limit/error/interrupt）：island 定格失败态，文案只进
  // 状态栏（终端网格只留原生字节，不写系统提示——单管线约束）
  _onTaskFail(kind, text) {
    this._taskActive = false;
    this._endTimer();
    this._setStopVisible(false);
    this._refreshThink();
    const slot = this._taskCardId ? this._slots.get(this._taskCardId) : null;
    if (slot) { slot.frozen = true; slot.frozenAt = Date.now(); }
    this._taskCardId = null;
    this._ensureFeed().then(f => f && f.handle({kind: "task_fail", reason: kind}));
    this.setStatus(kind === "denied" ? "error" : this.status,
                   text || (kind === "denied" ? "✗ 已拒绝" : "任务已中止"));
    if (slot) this._scheduleReanchor(slot);
    this._scheduleHeal();
  }

  // 失败救援卡（reactive）：用户命令非零退出，worker 发 rescue 事件挂卡，
  // 一键交给 AI 判定原意/修复。worker 侧已保证 AI 任务不在跑（_ai_task 为空
  // 才发），这里无需定格活卡。挂载 kind 沿用 "approval"：救援卡同款
  // 「藏了就点不了」+ 夹紧保按钮行（_slotHidden/_floorRows 都按该 kind 认）
  _showRescue(ev) {
    this._ensureFeed().then(async feed => {
      if (!feed) return;
      const cardId = ++this._cardSeq;
      feed.handle({kind: "rescue", line: ev.line || "", ec: ev.ec,
                   output: ev.output || "", id: cardId});
      await this._mountCard(cardId, "approval");
    });
  }

  // 审批卡走 island；island 加载失败兜底 modal 弹窗收决策，不让审批死锁。
  // 落点：任务分区仍在流底就复用同区（卡片下紧跟提示符，阿里 图二），
  // 否则（用户已跑过命令）开新分区。
  showApproval(command, reasons, host, risk) {
    this._ensureFeed().then(async feed => {
      if (!feed) {
        modalShell("审批：" + (command || ""),
          `<p>${esc(reasons || "")}</p>`,
          [{label: "批准", primary: true, onClick: () => {
              this.sendJson({type: "decision", decision: {type: "approve"}});
            }},
           {label: "拒绝", onClick: () => {
              this.sendJson({type: "decision",
                             decision: {type: "reject", message: "用户拒绝了该命令"}});
            }}]);
        return;
      }
      // 审批到达＝本模型段已结束：先冲刷 token 缓冲、把活分析卡定格并结账垫满
      // 最终高度，再锚审批卡。否则分析卡在审批锚定后继续长高，而 pad 只能追加
      // 在流底、插不进流中——卡底被审批卡/随后输出切掉（真机「审批头压分析卡
      // 末行 / exec 行切分析卡半行」根因）。定格后尾段 token 由下一段新卡承接。
      if (this._taskCardId != null) {
        const up0 = this._slots.get(this._taskCardId);
        // 延迟挂载卡（空闲期无渲染循环拿不到 host）必须先上屏：否则 settle 按
        // 初始 2 行账目垫高，审批锚在其下，卡上屏即盖帽→夹紧成单行高「分析」
        // （真机「拒绝后分析卡显示不完全」根因）
        if (up0 && !up0.host) {
          try { this.term.refresh(0, this.term.rows - 1); } catch (e) {}
          const t0 = Date.now();
          while (!up0.host && Date.now() - t0 < 600) await this._sleep(10);
        }
        feed.flush && feed.flush();
        feed.handle({kind: "ai_collapse"});
        const up = this._slots.get(this._taskCardId);
        if (up) { up.frozen = true; up.frozenAt = Date.now(); }
        this._taskCardId = null;
        this._phaseLive = false;
        this._approvalOpen = true;   // 等用户决策期间不显思考徽标（球在用户侧）
        this._refreshThink();
        if (up) await this._settleCard(up);
      }
      const cardId = ++this._cardSeq;
      // 先入 store 再挂卡：host 一诞生就渲染出完整审批卡，_fitNeed 首测即真高，
      // 一轮 pad 垫够。旧序（先挂空卡再 handle）首测量到 0 → 只垫 2 行，内容
      // 随后长到 7 行再补一轮；那 150ms 窗口里卡是钉死截断的，若用户此刻已按
      // Ctrl+Enter 放行、输出随即从卡底流走，预留区断开就永久盖帽补不回来。
      feed.handle({kind: "approval", id: cardId, command, reasons, risk});
      const slot = await this._mountCard(cardId, "approval");
      if (!slot) return;
    });
  }

  // 审批快捷键路由（终端保持焦点）：island 的 approval_key 返回是否消费，
  // 消费才 preventDefault 并标记已处理（attachCustomKeyEventHandler 与
  // document 冒泡两条路径都可能到达，防 e/E 双翻折编辑框）。
  // 返回是否消费，供 xterm 钩子决定要不要把按键截下。
  approvalKeys(ev) {
    if (!ev.ctrlKey || !this._feed || ev._otApprovalDone) return false;
    let key = null;
    if (ev.key === "Enter") key = "Enter";
    else if (ev.key === "e" || ev.key === "E") key = "e";
    else if (ev.key === "Backspace") key = "Backspace";
    if (!key) return false;
    if (this._feed.handle({kind: "approval_key", key})) {
      ev.preventDefault();
      ev._otApprovalDone = true;
      return true;
    }
    return false;
  }

  focusCursor() {
    try { this.term.focus(); } catch (e) {}
  }

  fit() {
    if (!this.paneEl.classList.contains("active")) return;
    try { this.fitAddon.fit(); } catch (e) { /* 隐藏/零尺寸时忽略 */ }
  }

  activate() {
    this.fit();
    this.focusCursor();
  }

  // seg 仅作后端 hook 开关（__ot_off），显示不再分叉
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this._lineBuf = "";
    this._lineCur = 0;
    if (this.interactive) this.sendJson({type: "mode", text: mode});
    this.paneEl.querySelectorAll(".seg button").forEach(b =>
      b.classList.toggle("on", b.dataset.mode === mode));
    this.focusCursor();
  }

  setStatus(state, text) {
    this.status = state;
    if (text != null) this.statusText = text;
    const el = document.getElementById(`status-${this.tabId}`);
    if (el) el.textContent = this.statusText;
    // 连接中徽标+终端区浮层：ready/closed/error 一到即撤（浮层在 term.open
    // 后插入，初始 connecting 应显示）
    const conn = document.getElementById(`conn-${this.tabId}`);
    if (conn) conn.hidden = state !== "connecting";
    const ov = document.getElementById(`connov-${this.tabId}`);
    if (ov) ov.hidden = state !== "connecting";
    refreshSidebarStatus();
  }

  // 浮层两阶段文案：stage 事件来自 worker（open_session 完成 → agent 初始化）
  _setConnectStage(stage) {
    const ov = document.getElementById(`connov-${this.tabId}`);
    if (!ov) return;
    const t = ov.querySelector(".ctext");
    if (t) t.textContent = stage === "agent_init" ? "初始化 Agent" : "连接中";
  }

  _fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${s % 60}s`;
  }

  _startTimer() {
    this._stopTimer();
    this._taskStart = Date.now();
    const el = document.getElementById(`time-${this.tabId}`);
    if (el) el.textContent = "⏱ " + this._fmtDuration(0);
    this._timer = setInterval(() => {
      const e = document.getElementById(`time-${this.tabId}`);
      if (e) e.textContent = "⏱ " + this._fmtDuration(Date.now() - this._taskStart);
    }, 1000);
  }

  _stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _endTimer() {
    // 任务结束：停止计时，定格显示本次任务耗时
    const el = document.getElementById(`time-${this.tabId}`);
    if (el && this._taskStart) {
      el.textContent = "⏱ " + this._fmtDuration(Date.now() - this._taskStart);
    }
    this._stopTimer();
    this._taskStart = 0;
  }

  _renderModelSelect(models, current) {
    const sel = document.getElementById(`model-${this.tabId}`);
    if (!sel) return;
    sel.innerHTML = "";
    (models || []).forEach(m => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    });
    sel.value = current || "";
    sel.onchange = () => {
      this.sendJson({type: "change_model", model: sel.value});
    };
  }

  _renderTokens(inTok, outTok, estimated) {
    const el = document.getElementById(`tokens-${this.tabId}`);
    if (!el) return;
    // 网关不回传真实 usage 时为 tiktoken 估算口径，加 ≈ 标注
    const a = estimated ? "≈" : "";
    el.textContent = `in ${a}${inTok || 0} · out ${a}${outTok || 0}`;
  }

  // 连接后命令集进度:running 显示 i/total;paused 等用户在终端输入;
  // done 定格片刻后消隐
  _renderCmdset(msg) {
    const el = document.getElementById(`cs-${this.tabId}`);
    if (!el) return;
    clearTimeout(this._csTimer);
    if (msg.state === "paused") {
      el.innerHTML = '命令集暂停：请在终端输入密码 ' +
        '<button class="status-cmdset-resume" tabindex="-1">继续</button>';
      el.querySelector(".status-cmdset-resume").onclick = () =>
        this.sendJson({type: "cmdset_resume"});
      return;
    }
    if (msg.state === "done") {
      el.textContent = "命令集执行完毕";
      this._csTimer = setTimeout(() => { el.textContent = ""; }, 4000);
      return;
    }
    el.textContent = `命令集 ${msg.index || ""}/${msg.total || ""}`;
  }

  _setStopVisible(visible) {
    const btn = document.getElementById(`stop-${this.tabId}`);
    if (btn) btn.hidden = !visible;
  }

  // 「AI正在思考」任务条：任务未结束（task_start → final/task_fail）全程
  // 常显在状态栏左侧——思考、流式卡、命令执行、审批等待全程都有活动指示，
  // 右侧 ⏹ 随时可中断（用户诉求：只要对话没完结就一直显示）
  _refreshThink() {
    const el = document.getElementById(`think-${this.tabId}`);
    if (el) el.hidden = !this._taskActive;
    const bar = this.paneEl && this.paneEl.querySelector(".statusbar");
    if (bar) bar.classList.toggle("task-on", this._taskActive);
  }

  // 阶段卡真正挂载上屏：思考徽标接班结束、让位给卡本体。与 _openPhaseCard 的
  // 「开卡先显徽标」配对——空闲期 pendingMount 的卡不算上屏（真机假死窗口）。
  // 宁藏不盖：fund 之前卡是 visibility:hidden，不能算上屏（徽标继续接班），
  // fund 释放沿（_revealSlot→这里）再交班
  _cardOnScreen(cardId) {
    if (cardId !== this._taskCardId) return;
    if (this._slotHidden(this._slots.get(cardId))) return;
    this._phaseLive = true;
    this._refreshThink();
  }

  // --- WS JSON 事件 ---
  // 契约：ready/status/closed/usage/approval/ask_password/ask_host_key/
  // interrupt/mode/auth/change_model/task_start/final/denied/limit/error/
  // stage + 新增 ai_token/ai_think/ai_collapse/ai_card。
  handleMsg(msg) {
    switch (msg.type) {
      case "ready": {
        this.setStatus("connected",
          `已连接 ${msg.host}${msg.distro ? "（" + msg.distro + "）" : ""}`);
        this.interactive = !!msg.interactive;
        // 欢迎横幅：紧随 ready 的第一条 status 是横幅文案；落点锚在首个
        // 提示符文本上（OSC 133 标记被后端消费，不会到达前端）
        this._awaitWelcome = msg.interactive ? true : false;
        this._welcomeNeed = (msg.prompt || "").trim();
        // 尺寸同步：onResize 只在尺寸变化时触发，xterm 创建时即为此尺寸则
        // 永远不会发 resize、远端 PTY 停在默认 40×120——ready 后显式同步一次
        this.sendJson({type: "resize", cols: this.term.cols, rows: this.term.rows});
        const hostEl = document.getElementById(`host-${this.tabId}`);
        if (hostEl) hostEl.textContent = msg.host || "";
        this._renderModelSelect(msg.models, msg.model);
        // 集成失败回退 = 纯终端（无 AI），不显示模型信息
        const modelSel = document.getElementById(`model-${this.tabId}`);
        if (modelSel) modelSel.hidden = !this.interactive;
        if (this.interactive && this.mode !== "agent") this.setMode("agent");
        this.fit();
        this.focusCursor();
        break;
      }
      case "status":
        if (this._awaitWelcome) {   // ready 后第一条 status = 横幅文案
          this._awaitWelcome = false;
          this._welcomeText = msg.text || "";
          // 进入扣留态：PTY 字节扣到提示符落屏，先写横幅再重放（P0-3：
          // 此前 _welcomeHold 从未被赋值，横幅永不落屏、扣留机制全死）
          this._welcomeHold = {raw: null, cleared: 0, at: performance.now()};
        }
        this.setStatus(this.status, msg.text);
        break;
      case "stage":   // 连接两阶段：连接中 →（建连完成）→ 初始化 Agent
        this._setConnectStage(msg.text);
        break;
      case "cmdset":
        this._renderCmdset(msg);
        break;
      case "usage":
        this._renderTokens(msg.tokens_in, msg.tokens_out, msg.estimated);
        break;
      case "approval":
        this.showApproval(msg.command, msg.reasons, msg.host, msg.risk);
        break;
      case "ask_password":
        modalAsk("密码", msg.label, (value, remember) => {
          this.sendJson({type: "auth", auth_kind: msg.auth_kind || "password",
                         text: value, remember});
        }, {remember: msg.auth_kind !== "cmdset",
            rememberLabel: "记住密码（写入系统凭据库，不落数据库）"});
        break;
      case "ask_host_key":
        modalConfirm("主机密钥", msg.message, ok => {
          this.sendJson({type: "auth", auth_kind: "host_key", text: String(ok)});
        });
        break;
      case "interrupt":
        this._onTaskFail("interrupt", msg.text || "已中断");
        break;
      case "mode":
        // 后端 hook 开关确认
        if (msg.text === "ssh" || msg.text === "agent") {
          this.mode = msg.text;
          this.paneEl.querySelectorAll(".seg button").forEach(b =>
            b.classList.toggle("on", b.dataset.mode === this.mode));
        }
        break;
      case "auth":
        break;   // 应答确认，无 UI
      case "closed":
        this.setStatus("closed", msg.text || "连接已关闭");
        break;
      // --- AI 事件：新契约顶层直接下发；兼容旧 {type:"event"} 包装 ---
      case "event":
        this.handleEvent(msg.event);
        break;
      case "task_start":
        this._onTaskStart();
        break;
      case "ai_token":
        this._onAiToken(msg.text);
        break;
      case "ai_think":
        this._onAiThink(msg.text);
        break;
      case "ai_collapse":
        this._onAiCollapse();
        break;
      case "ai_card":
        this._onAiCard(msg.markdown);
        break;
      case "final":
        this._onFinal(msg.text);
        break;
      case "denied":
      case "limit":
      case "error":
        this._onTaskFail(msg.type, msg.text);
        break;
    }
  }

  // 旧事件包装（{type:"event", event:{kind:...}}）按 kind 路由到同一批处理器
  handleEvent(ev) {
    if (!ev) return;
    switch (ev.kind) {
      case "task_start": this._onTaskStart(); break;
      case "ai_token": this._onAiToken(ev.text); break;
      case "ai_think": this._onAiThink(ev.text); break;
      case "ai_boundary": this._onBoundary(); break;
      case "ai_collapse": this._onAiCollapse(); break;
      case "ai_tool": this._onAiTool(ev); break;
      case "ai_card": this._onAiCard(ev.markdown); break;
      case "final": this._onFinal(ev.text); break;
      case "interrupt": this._onTaskFail("interrupt", ev.text || "已中断"); break;
      case "rescue": this._showRescue(ev); break;
      case "denied":
      case "limit":
      case "error":
        this._onTaskFail(ev.kind, ev.text);
        break;
      case "session_cleared":
        this._clearCards();
        break;
      case "padded":
        this._onPadded();
        break;
      default:
        break;   // 未知事件静默忽略（此前 JSON.stringify 进终端是调试残留）
    }
  }

  close() {
    this._dead = true;
    if (this._healT) { clearTimeout(this._healT); this._healT = null; }
    if (this._ghostTimer) { clearInterval(this._ghostTimer); this._ghostTimer = null; }
    this._hideGhost();
    this._destroySlots();
    if (this._feed) { try { this._feed.destroy(); } catch (e) {} this._feed = null; }
    authFetch(`/api/tabs/${this.tabId}/close`, {method: "POST"}).catch(() => {});
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} }
    this._stopTimer();
    try { this.term.dispose(); } catch (e) {}
    this.tabEl.remove();
    this.paneEl.remove();
    if (this.status === "connected" || this.status === "connecting") {
      closedTargets.add(this.name);
    }
    delete sessions[this.tabId];
    refreshSidebarStatus();
  }
}

// --- tab / pane 管理 ---
function openTab(targetName) {
  authFetch("/api/tabs", {
    method: "POST",
    body: JSON.stringify({target: targetName}),
  })
    .then(r => r.json())
    .then(({tab_id}) => {
      const s = new Session(tab_id, targetName);
      sessions[tab_id] = s;
      activateTab(tab_id);
      s.connectWS();
    })
    .catch(err => console.error("openTab failed", err));
}

function activateTab(tabId) {
  activeTabId = tabId;
  document.querySelectorAll(".tab").forEach(b =>
    b.classList.toggle("active", b.id === `tabbtn-${tabId}`));
  document.querySelectorAll(".pane").forEach(p =>
    p.classList.toggle("active", p.id === `pane-${tabId}`));
  const s = sessions[tabId];
  if (s) s.activate();
}

function closeTab(tabId) {
  const s = sessions[tabId];
  if (!s) return;
  const wasActive = activeTabId === tabId;
  s.close();
  if (wasActive) {
    const rest = Object.keys(sessions);
    activeTabId = rest.length ? rest[rest.length - 1] : null;
    if (activeTabId) activateTab(activeTabId);
  }
}

// --- 侧栏 ---
function loadTargets() {
  authFetch("/api/targets")
    .then(r => r.json())
    .then(data => { targetsData = data; renderTargets(); })
    .catch(() => {});
}

function targetStatus(name) {
  let has = false;
  for (const s of Object.values(sessions)) {
    if (s.name !== name) continue;
    has = true;
    if (s.status === "connected") return "connected";
    if (s.status === "connecting") return "connecting";
  }
  return (has || closedTargets.has(name)) ? "closed" : "idle";
}

function refreshSidebarStatus() {
  document.querySelectorAll("#targets .target").forEach(btn => {
    const dot = btn.querySelector(".dot");
    if (dot) dot.className = "dot " + targetStatus(btn.dataset.name);
  });
}

function matchesQuery(t) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return [t.name, t.host, t.user].filter(Boolean)
    .some(v => String(v).toLowerCase().includes(q));
}

function renderTargets() {
  const nav = document.getElementById("targets");
  nav.innerHTML = "";
  const data = targetsData;
  if (!data) return;

  if (matchesQuery({name: "local"})) nav.appendChild(localEntry());

  const direct = (data.direct || []).filter(matchesQuery);
  if (direct.length) {
    nav.appendChild(sep("直接连接"));
    direct.forEach(t => nav.appendChild(entry(t)));
  }
}

function sep(text) {
  const d = document.createElement("div");
  d.className = "sep";
  d.innerHTML = `<span class="sep-caret">▾</span>${esc(text)}`;
  return d;
}

// 侧栏条目：默认显示主机名（name），副行 user@host:port；悬停出编辑/删除
function entry(t) {
  const b = document.createElement("button");
  b.className = "target";
  b.dataset.name = t.name;
  const sub = `${t.user || ""}@${t.host || ""}${t.port ? ":" + t.port : ":22"}`;
  const label = t.name;
  b.innerHTML =
    '<span class="dot idle"></span>' +
    `<span class="t-main"><span class="t-label">${esc(label)}</span>` +
    (sub.replace(/[@:]/g, "") ? `<span class="t-sub">${esc(sub)}</span>` : "") +
    "</span>" +
    '<span class="t-actions">' +
    '<button data-a="copy" title="复制为新的连接">⧉</button>' +
    '<button data-a="edit" title="编辑">✎</button>' +
    '<button data-a="del" title="删除">✕</button></span>';
  b.onclick = ev => {
    if (ev.target.closest(".t-actions")) return;
    openTab(t.name);
  };
  b.querySelector('[data-a="copy"]').onclick = ev => {
    ev.stopPropagation(); connForm({copy: t});
  };
  b.querySelector('[data-a="edit"]').onclick = ev => {
    ev.stopPropagation(); connForm({edit: t});
  };
  b.querySelector('[data-a="del"]').onclick = ev => {
    ev.stopPropagation(); connDelete(t);
  };
  return b;
}

function localEntry() {
  const b = document.createElement("button");
  b.className = "target";
  b.dataset.name = "local";
  b.innerHTML = '<span class="dot idle"></span>' +
    '<span class="t-main"><span class="t-label">local</span>' +
    '<span class="t-sub">本机终端</span></span>';
  b.onclick = () => openTab("local");
  return b;
}

// 连接表单：远程机器的新增与编辑；
// 密码只进系统凭据库（服务端保证不落 SQLite）
function connForm(opts = {}) {
  const edit = opts.edit || null;
  const copy = opts.copy || null;        // 复制模式：预填源连接信息，保存新建
  const src = copy || edit;              // 预填来源（复制=源连接，编辑=被编辑对象）
  const title = (copy ? "复制" : edit ? "编辑" : "添加") + "远程机器";
  // 复制默认名 = 原名 + 「 副本」：POST /api/saved 按 name upsert，同名保存会
  // 覆盖原连接而非新建，预加后缀保证落成独立新连接（用户可再改）
  const nameVal = copy ? ((copy.name || "").replace(/ 副本$/, "") + " 副本")
                       : (edit ? edit.name : "");
  // 连接后命令集:仅远程机器表单。密码写 > @名字=密码,保存后服务端
  // 抽取入凭据库并把该行改写为 > @名字 回传(弹窗即关,无需回显刷新)
  const cmdRow = `
      <label>连接后命令</label>
      <textarea id="f-commands" rows="4" spellcheck="false"
                placeholder="连接成功后自动逐行执行。自动应答写 &gt; @名字=密码（保存后转为引用）">${esc(src && src.commands ? src.commands : "")}</textarea>`;
  modalShell(title, `
    <div class="form-grid">
      <label>主机名</label>
      <input id="f-name" type="text" autocomplete="off"
             placeholder="如 web01，留空默认 user@IP" value="${esc(nameVal)}">
      <label>IP 地址</label>
      <input id="f-host" type="text" autocomplete="off"
             placeholder="如 192.168.1.10" value="${esc(src ? src.host : "")}">
      <label>端口</label>
      <input id="f-port" type="text" autocomplete="off"
             placeholder="默认 22" value="${src && src.port ? src.port : ""}">
      <label>用户名</label>
      <input id="f-user" type="text" autocomplete="off"
             placeholder="如 root" value="${src && src.user ? src.user : ""}">
      <label>密码</label>
      <input id="f-pass" type="password" autocomplete="new-password"
             placeholder="${copy || edit ? "留空则不修改" : "存入系统凭据库，不写数据库"}">
      ${cmdRow}
    </div>`, [
    {label: "确定", primary: true, onClick: () => {
      const hostEl = document.getElementById("f-host");
      const host = hostEl.value.trim();
      if (!host) {                    // IP/地址必填：标红、不关闭弹窗
        hostEl.classList.add("invalid");
        hostEl.focus();
        return false;
      }
      const payload = {
        name: document.getElementById("f-name").value.trim(),
        host,
        port: document.getElementById("f-port").value.trim(),
        user: document.getElementById("f-user").value.trim(),
        password: document.getElementById("f-pass").value,
      };
      const cmdEl = document.getElementById("f-commands");
      if (cmdEl) payload.commands = cmdEl.value;
      const url = edit ? "/api/saved/" + encodeURIComponent(edit.name) : "/api/saved";
      authFetch(url, {method: edit ? "PUT" : "POST",
                      body: JSON.stringify(payload)})
        .then(r => r.json().then(d => ({ok: r.ok, d}))
                      .catch(() => ({ok: r.ok, d: {}})))
        .then(({ok, d}) => {
          if (!ok) { alert("保存失败：" + (d.detail || "请检查表单内容")); return; }
          loadTargets();
          if (d.warning) alert(d.warning);
          // 新增远程机器：保存成功后直接开 tab 尝试连接；复制不自动开——先落列表
          // 让用户确认/改完再连，避免误连出多个重复 tab
          if (!edit && !copy) openTab(d.name || payload.name || host);
        })
        .catch(() => alert("保存失败：网络错误"));
      return true;
    }},
    {label: "取消", onClick: () => {}},
  ]);
  // 复制/编辑聚焦 IP 地址（最可能改动）；新增聚焦主机名
  const first = document.getElementById(copy || edit ? "f-host" : "f-name");
  if (first) first.focus();
}

function connDelete(t) {
  const sub = `${t.user ? t.user + "@" : ""}${t.host || ""}${t.port ? ":" + t.port : ":22"}`;
  modalConfirm(`删除连接`,
    `确定删除 ${t.name}（${sub}）吗？\n记住的密码将一并从系统凭据库清除。`,
    ok => {
      if (!ok) return;
      authFetch(`/api/saved/${encodeURIComponent(t.name)}`, {method: "DELETE"})
        .then(() => loadTargets());
    }, "删除", "取消");
}

// --- 全局事件 ---
document.getElementById("btn-add-remote").onclick = () => connForm({});

document.getElementById("sidebar-search").addEventListener("input", ev => {
  searchQuery = ev.target.value.trim();
  renderTargets();
});

document.getElementById("btn-toggle-sidebar").onclick = () => {
  document.body.classList.toggle("sidebar-collapsed");
  const s = sessions[activeTabId];
  if (s) setTimeout(() => s.fit(), 60);
};

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const s = sessions[activeTabId];
    if (s) s.fit();
  }, 120);
});

// 从其它窗口切回浏览器时恢复焦点：聚焦唯一终端，否则键盘输入会落到 body 上
// 全部失效（用户切屏后「无法输入」）
window.addEventListener("focus", () => {
  const s = sessions[activeTabId];
  if (s) s.focusCursor();
});

loadTargets();

// 全局快捷键：Ctrl+Shift+I 切换 seg（后端 hook 开关）；审批卡快捷键路由
document.addEventListener("keydown", ev => {
  const s = sessions[activeTabId];
  if (!s) return;
  if (ev.ctrlKey && ev.shiftKey && (ev.key === "i" || ev.key === "I")) {
    ev.preventDefault();
    s.setMode(s.mode === "ssh" ? "agent" : "ssh");
    return;
  }
  s.approvalKeys(ev);
});
