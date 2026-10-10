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
// mac 用 Cmd+C/Cmd+V 原生路径；Windows/Linux 的裸 Ctrl+C/Ctrl+V 需特殊路由
const IS_APPLE = /Mac|iPhone|iPad/.test(navigator.userAgent);
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
function modalShell(title, bodyHtml, buttons, opts = {}) {
  const root = document.getElementById("modal-root");
  delete root.dataset.pw;   // 新模态顶掉密码模态标记：代关只认密码模态
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
  root.onmousedown = ev => {
    if (ev.target === root) {
      opts.onDismiss && opts.onDismiss();
      close();
    }
  };
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
      {label: "取消", onClick: () => { opts.onCancel && opts.onCancel(); }},
    ],
    {onDismiss: opts.onCancel});
  document.getElementById("modal-root").dataset.pw = "1";
  const v = document.getElementById("modal-value");
  if (v) v.focus();
}

// 后端代关陈旧密码模态（密码提示符已被终端手输消费）：只关带 pw 标记的
// 密码模态，审批/主机密钥等其他模态不受影响
function modalDismissPassword() {
  const root = document.getElementById("modal-root");
  if (root && root.dataset.pw) {
    delete root.dataset.pw;
    root.innerHTML = "";
  }
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
    this._lastMsgAt = 0;        // 最近任意服务端帧（字节/JSON/心跳）到达时间
    this._lastSendAt = 0;       // 最近一次上行（按键/JSON）时间——看门狗判无响应用
    this._holdSince = 0;        // 扣流持续起点（泄漏 watchdog：超阈强制放行）
    this._holdDepth = 0;        // 字节扣流嵌套深度（welcome + card 临界区）
    this._holdBuf = null;       // 扣住的 PTY 字节队列
    this._welcomeHold = null;   // 连接横幅扣留态（先横幅后提示符，见 _holdWelcome）
    this._welcomeTimer = null;  // 扣留到点自放行的定时器（见 _armWelcomeDeadline）
    this._taskActive = false;   // 任务进行中（task_start → final/denied/limit/error）
    this._phaseLive = false;    // 有活分析卡在流底（task_start/新段 token → ai_collapse/ai_card）
    this._summaryShown = false; // 本轮总结卡已挂（挂出即不再显示思考徽标）
    this._approvalOpen = false; // 有未决策审批卡（球在用户侧，不显思考徽标）
    this._approvalCmd = null;   // 未决审批的命令（补发去重：同命令不叠第二张卡）
    this._approvalGraceMs = 3000; // 审批卡可点性看门狗：fund 未到限内转模态兜底
    this._approvalResolved = false; // 本令决策已发：看门狗/模态不得再发第二发
    this._runningTool = "";      // 在跑的工具（徽标说人话：执行中: docker ps）
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
    tabBtn.innerHTML = `<span class="dot tab-dot connecting" title="连接状态"></span><span class="tab-name">${esc(this.name)}</span><span class="tab-x" title="关闭">×</span>`;
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
      // 卡片 island 的 DOM 选区优先原生复制：返回 false 让 xterm 不吞键
      // （否则 Cmd/Ctrl+C 会变成 ^C 发进 PTY，中断正在跑的命令）
      if (ev.type === "keydown" && (ev.metaKey || ev.ctrlKey) &&
          ev.key.toLowerCase() === "c") {
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) return false;
      }
      // 复制：mac=Cmd+C（原样）；Win/Linux=Ctrl+C 终端有选区时复制（无选中
      // 不拦，照发 ^C 中断）与 Ctrl+Shift+C。Windows 习惯选区后 Ctrl+C 复制，
      // 旧行为把 Ctrl+C 一律译成 ^C——选区被中断、复制永不发生，粘贴自然
      // 无物可粘（真机「复制后 Ctrl+V 无效」的复制半边根因）
      if (ev.type === "keydown" &&
          (ev.metaKey || (ev.ctrlKey && ev.shiftKey) ||
           (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && !IS_APPLE)) &&
          (ev.key === "c" || ev.key === "C" || ev.keyCode === 67) &&
          term.hasSelection()) {
        this._copyText(term.getSelection());
        return false;
      }
      // Windows/Linux 裸 Ctrl+V 粘贴：xterm 会把 Ctrl+V 译成 \x16（quoted-insert）
      // 发进 PTY 并 cancel 事件，浏览器原生 paste 永不发生（真机 Windows 粘贴
      // 无效根因）。返回 false 让 xterm 跳过该键且不 cancel，默认动作产生的
      // paste 事件由 xterm 挂在 textarea/element 上的监听接管送进 PTY——
      // http 局域网下也走得通，不依赖 clipboard.readText 权限。keyCode 86 兜底
      // 中文 IME 下 key 报 "Process" 的机型。mac 的 Cmd+V 原生路径不受影响。
      if (ev.type === "keydown" && !IS_APPLE && ev.ctrlKey && !ev.shiftKey &&
          !ev.altKey && !ev.metaKey && !ev.isComposing &&
          (ev.key === "v" || ev.key === "V" || ev.keyCode === 86)) {
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
    // 连接/扣流看门狗：服务端心跳 10s 一帧，输入无响应 8s 即判死重连；
    // 扣流超 10s 未归零＝临界区泄漏，强制放行复活回显（真机「卡死无法输入」）
    this._wdTimer = setInterval(() => this._watchdog(), 5000);
  }

  _watchdog() {
    if (this._dead) return;
    const now = Date.now();
    if ((this._holdDepth || 0) > 0 && this._holdSince &&
        now - this._holdSince > 10000) {
      console.warn("[ot] 扣流泄漏强制放行:", (this._holdTags || []).join(","));
      this._holdDepth = 1;
      this._releaseBytes();
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    // 发过东西却久无回音（回显/事件/心跳全断）：传输层可能假活（服务端
    // sender 卡死/sink 僵尸），等 onclose 永不触发——主动close走退避重连
    if (this._lastSendAt > this._lastMsgAt &&
        now - this._lastSendAt > 8000 && now - this._lastMsgAt > 15000) {
      console.warn("[ot] 连接无响应，主动重连");
      this.setStatus("closed", "连接无响应，正在重连");
      this._failPads();
      try { ws.close(); } catch (e) { this.connectWS(); }
    }
  }

  // --- 密码内联捕获（真实终端 ssh 讨密码语义）---
  // 提示符落屏前光标不在行首才补换行（空终端首次讨密码不甩首行空白）
  _pwNewline() {
    try {
      const b = this.term.buffer.active;
      if (b.type === "normal" && b.cursorX > 0) this._writeTerm("\r\n");
    } catch (e) {}
  }

  // 无回显收集：退格删末字符（无回显、无 ^H，远端 echo 已关），回车提交
  // （空密码照发——与真实终端一致，远端失败后重讨），Ctrl+C 取消整个连接
  // 尝试（password_cancel → 后端中止认证等待）。方向键等转义序列整体跳过
  // （只滤 ESC 本体会把 CSI 的参数字符当口令收进去），其余控制键忽略。
  _pwFeed(d) {
    const cap = this._pwCapture;
    const sc = Array.from(d);
    for (let i = 0; i < sc.length; ) {
      const ch = sc[i];
      if (ch === "\r") {
        const text = cap.buf;
        cap.buf = "";
        cap.submitted = true;
        // 留档待问：ready 后凭它弹「是否记住密码」（错密会在重讨时被覆盖）
        this._pwEntered = text;
        this._writeTerm("\r\n");
        this.sendJson({type: "auth", auth_kind: cap.kind, text, remember: false});
        return;
      }
      if (ch === "\x1b") {
        // CSI：参数字节 0x20–0x3F 后接终字节 0x40–0x7E；SS3：ESC O + 一字节
        if (sc[i + 1] === "[" || sc[i + 1] === "O") {
          i += 2;
          while (i < sc.length && (sc[i] < "@" || sc[i] > "~")) i++;
          i++;   // 跳过终字节
        } else {
          i += 2;   // 两字节转义（ESC x）
        }
        continue;
      }
      if (ch === "\x7f" || ch === "\x08") {
        if (cap.buf) cap.buf = cap.buf.slice(0, -1);
        i++;
        continue;
      }
      if (ch === "\x03") {
        this._writeTerm("^C\r\n");
        this._pwCapture = null;
        this._pwEntered = null;
        this.sendJson({type: "auth", auth_kind: "password_cancel", text: ""});
        return;
      }
      if (ch >= " ") cap.buf += ch;
      i++;
    }
  }

  // onData 主体（WS 就绪后走这里）：submit 拦截链 + 按键透传
  _feedData(d) {
    // 密码内联捕获（初始连接讨密码）：按键不进 submit 拦截链、不发 PTY
    if (this._pwCapture && !this._pwCapture.submitted) {
      this._pwFeed(d);
      return;
    }
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
          !this._pwPromptLine() &&
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
    // 上行记账（看门狗判「发过却无回音」）：send 有两个直调点（raw 字节与
    // sendJson），统一在包装里记，避免漏记
    const rawSend = ws.send.bind(ws);
    ws.send = d => { this._lastSendAt = Date.now(); return rawSend(d); };
    // 开连（或重连）后按序回放 WS 未就绪期缓存的按键（onData 不丢键）
    ws.onopen = () => {
      this._wsRetries = 0;
      const bl = this._keyBacklog;
      this._keyBacklog = null;
      if (bl) for (const d of bl) this._feedData(d);
      // 退避重连成功的回连：worker 宽限期内 PTY 还活着，不会再发 ready，
      // 自行把状态翻回已连接（若 PTY 已死，首个键走 worker 重连链再纠正）
      if (this._everRetried && !this._dead) this.setStatus("connected", "连接已恢复");
    };
    // PTY 原始字节走二进制帧直写唯一 xterm（契约），JSON 控制事件走 handleMsg
    ws.onmessage = ev => {
      this._lastMsgAt = Date.now();   // 心跳 ping 也走这里：看门狗的存活基线
      if (ev.data instanceof ArrayBuffer) {
        this._lastByteAt = Date.now();
        const u8 = new Uint8Array(ev.data);
        this._ingestBytes(u8);
      } else this.handleMsg(JSON.parse(ev.data));
    };
    ws.onclose = ev => {
      this._pwCapture = null;   // 断线终结登录期密码捕获，重连后不残留
      this._pwEntered = null;
      this.setStatus("closed", "连接已关闭");
      this._failPads();
      // 断线自动重连（指数退避）；4401/4404（鉴权失败/worker 已回收）重试无意义
      if (!this._dead && ev.code !== 4401 && ev.code !== 4404) {
        this._scheduleWsRetry();
      }
    };
  }

  // ws 断线自动重连：0.5s 起指数退避、封顶 10s，**不限次数**。旧实现 8 次
  // （约 50s）后彻底停手，页面就此冻结在「连接已关闭」——终端打不进字、
  // 「AI 正在思考」徽标永远收不到收尾（真机截图二）。服务端 worker 宽限期
  // 5 分钟，网络/服务抖动回来即自动续上；4401/4404 仍在 onclose 判死不重试。
  _scheduleWsRetry() {
    if (this._wsRetryT) return;
    this._everRetried = true;
    const delay = Math.min(10000, 500 * 2 ** (this._wsRetries || 0));
    this._wsRetries = (this._wsRetries || 0) + 1;
    if (this._wsRetries === 1 || this._wsRetries % 8 === 0)
      console.warn(`[ot] 第 ${this._wsRetries} 次重连，${delay}ms 后`);
    this._wsRetryT = setTimeout(() => {
      this._wsRetryT = null;
      if (!this._dead) this.connectWS();
    }, delay);
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
    if (this._holdDepth === 1) this._holdSince = Date.now();
  }

  _releaseBytes() {
    if (!this._holdDepth) return;
    this._holdDepth -= 1;
    if (this._holdTags && this._holdTags.length) this._holdTags.pop();
    if (this._holdDepth > 0) return;
    this._holdSince = 0;
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
        return true;   // 缓冲里已含本块 u8，别再写一遍
      }
    }
    if (performance.now() - h.at > 1500) {
      this._releaseWelcome();
      return true;     // 同上
    }
    return true;
  }

  // 扣留期到点自放行：_holdWelcome 只在新字节到达时被调用，而提示符之后
  // 本来就没有输出——静默期就永远走不到超时判定，横幅扣着整屏永不落字、
  // 打字也不回显（真机：本地目标终端全空白、「无法输入任何文字」）。与密码
  // 验证窗口的 _pw_verify_expiry 同类：超时不能靠输出驱动。
  _armWelcomeDeadline() {
    if (this._welcomeTimer) clearTimeout(this._welcomeTimer);
    this._welcomeTimer = setTimeout(() => {
      this._welcomeTimer = null;
      if (this._welcomeHold) {
        console.warn("[ot] 欢迎横幅扣留到点，强制放行");
        this._releaseWelcome();
      }
    }, 1600);
  }

  _releaseWelcome() {
    if (this._welcomeTimer) { clearTimeout(this._welcomeTimer); this._welcomeTimer = null; }
    const h = this._welcomeHold;
    this._welcomeHold = null;
    if (this._dead || !h) return;
    if (this._welcomeText) {
      this._writeTerm("\x1b[2m" + this._welcomeText + "\x1b[0m\r\n");
    }
    // 静默期定时器放行时 h.raw 可能还是 null（一块字节都没到）——
    // 这里不判就会在 setTimeout 回调里抛 uncaught
    const tail = !h.raw ? null : (h.cleared ? h.raw.subarray(h.cleared) : h.raw);
    if (tail && tail.length) this._writeTerm(tail);
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

  // 光标行是否密码提示符（ssh/sudo 讨密码）：整行原样透传、幽灵提示隐藏。
  // 前端本地判定 + 后端 _pw_prompt_seen 兜底，两层任一命中都不拦。
  _pwPromptLine() {
    try {
      const buf = this.term.buffer.active;
      if (buf.type !== "normal") return false;
      const line = buf.baseY + buf.cursorY;
      const t = buf.getLine(line).translateToString(true);
      return /passwo?r?d\s*[:：]?\s*$/i.test(t) ||
             /密码\s*[:：]?\s*$/.test(t) || /口令\s*[:：]?\s*$/.test(t);
    } catch (e) { return false; }
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
    this._toastCopied();
    // 右键菜单复制后菜单按钮已 remove、焦点落 body——拉回终端让用户直接
    // 继续打字（Cmd/Ctrl+Shift+C 路径焦点本就在终端，此处为无害 no-op）
    this.focusCursor();
  }

  _execCopy() {
    try { document.execCommand("copy"); } catch (e) {}
  }

  // 「已复制」小提示：常显 1s 后淡出（.copy-toast 样式，opacity 过渡）。
  // 复用同一节点并重置计时，连按复制不叠影、不缩短上一条寿命。
  _toastCopied() {
    let el = this.paneEl.querySelector(".copy-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "copy-toast";
      el.textContent = "已复制";
      this.paneEl.appendChild(el);
    }
    clearTimeout(this._toastTimer);
    el.classList.add("show");
    this._toastTimer = setTimeout(() => el.classList.remove("show"), 1000);
  }

  _pasteText() {
    const done = t => {
      if (t) { try { this.term.paste(t); } catch (e) {} }
      // 粘贴后焦点仍在（已 remove 的）菜单按钮上落回 body，键盘输入失效
      // （真机「粘贴后要再点一下才能打字」）——还焦点给终端，可直接继续输入
      this.focusCursor();
    };
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
            this._approvalCmd = null;
            this._approvalResolved = true;   // 卡内快捷键路径也算已决策
            this._refreshThink();
            this._releaseDecision(decision, cardId);
            this.focusCursor();   // 卡内 mousedown 不冒泡：焦点显式还给终端
          },
          onRescue: accept => {
            // 失败救援卡决策回传（true = 交给 AI）
            this.sendJson({type: "rescue", accept});
            this.focusCursor();
          },
          onNewSession: cardId => {
            // 总结卡「开启新会话」：后端只重置模型上下文（不清屏）；PTY 发
            // 一个回车等效换行出新鲜提示符——界面上就像按了一下 Enter
            this.sendJson({type: "new_session"});
            this._sendInput("\r");
            this.focusCursor();
          },
          // store 整卡移除（interrupt 收束/sweep/drop）：布局槽同步丢弃——
          // island 与 decoration 一起消失，不留无主半截卡
          onDrop: ids => {
            for (const id of ids || []) {
              const s = this._slots && this._slots.get(id);
              if (s) this._dropSlot(s);
            }
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

  // 锚定临界区串行化：_cardReady 只串了走链的调用方（task_start/ai_tool），
  // showApproval/_showRescue/_mountSummary 不走它——tool_start 与 approval
  // 同包到达时两个 _mountCard 并发跑到底，registerMarker 都钉在同一光标行
  // ＝两张 island 叠同行、后贴纸者盖住先者；被盖的是审批卡时按钮点不到，
  // 看门狗又视 mounted+未夹紧为健康不转模态＝决策死锁（真机「工具卡盖审批
  // 卡、界面干等审批」）。锁必须落在 _mountCard 内部才罩得住所有调用方；
  // 范围含尾部 _ensurePad——下张卡的 marker 必须钉在本卡预留空行落地、光标
  // 下移之后，否则空行落进新卡区、新卡出生即盖帽夹紧。
  async _mountCard(cardId, kind = "phase") {
    const run = () => this._runMountCard(cardId, kind);
    // 前卡挂载抛错不得堵住后卡锚定（onRejected 同样排队放行）
    this._mountQ = (this._mountQ || Promise.resolve()).then(run, run);
    return this._mountQ;
  }

  // 挂载一张卡：marker 钉流底，decoration 贴纸盖在 pad 预留行上。
  // 整段在扣流临界区内完成，输出不可能插进占位区。失败返回 null。
  async _runMountCard(cardId, kind = "phase") {
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
      // 换钉（_stealBlankBelow 把下层卡锚点下移）会 dispose 旧 marker：旧钉的
      // 迟到 dispose 不得删槽——只认「仍是本槽当前钉」的那次 dispose
      marker.onDispose(() => {
        if (slot.marker === marker) this._discardSlot(slot);
      });
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
        // 卡内 mousedown 不冒泡到 xterm：拖选卡内文字会同时启动终端选区并
        // 抢焦点（选完字粘贴态错乱）。click 事件独立于冒泡链——按钮照点；
        // 终端焦点由各决策回调显式 focusCursor 补回
        if (!el._otMD && typeof el.addEventListener === "function") {
          el._otMD = true;
          el.addEventListener("mousedown", ev => ev.stopPropagation());
        }
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
      // 必压活文本/被输出切成半行细条，整卡藏（宁藏不盖）；pad 落地/空白出现后
      // top 与 maxHeight 自然放行。钉死态同样按零空白藏：钉高只保证钉那一刻的
      // run，输出随后把 run 吃掉后钉高就压在活文本上（工具卡「✓ 完成」细条被
      // 输出切半行的根因）；blankSpan ≥ 1 维持现状露出已垫部分。任务定格
      // （collapse/final/fail，frozen）后不再藏：冻结阀/收束结账是「不留隐形卡」
      // 的放出档。熔断态不藏（保活优先）；审批卡豁免（按钮不可点=决策死锁）。
      if (slot.marker && slot.kind !== "approval" && !slot.frozen &&
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
      // 已盖帽（下方被输出/别的卡占住）：blankSpan ≥ 1 按夹紧路径放出、露出
      // 已垫部分（宁藏不盖只遮「等 pad 落地」的过渡期）；盖帽零垫（一行空白
      // 都没有）的非审批卡不走「盖帽即放行」——露出必被输出切成半行细条，
      // 整卡藏到定格/冻结阀放出。权衡：永久盖帽卡徽标陪跑观感差于细条，故
      // 只藏零空白档，≥1 行档维持现状
      if (this._capped(slot)) {
        if (slot.kind !== "approval" && this._blankSpan(slot) === 0) {
          this._refreshThink();   // 卡不放行：徽标继续接班
        } else {
          this._revealSlot(slot);
        }
      } else {
        this._refreshThink();   // 显→隐沿：夹紧隐藏态让思考徽标接班
      }
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
          // 光标须在行尾（容尾随空白）、行非空（=提示符行）、PTY 字节静默；
          // 密码提示符行永远不显（正讨密码，与自然语言无关）
          show = t.trim() !== "" && x >= t.replace(/\s+$/, "").length &&
                 !this._pwPromptLine() &&
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
        // 空闲期补 host：PTY 静默窗里槽可能还 pendingMount（无 host、React 内容
        // 没落地、高度停在出生值）——按出生高结账等于没结：等真高度量出来时
        // 下层卡/命令回显已锚定，pad 只追加在流底、垫不进已闭合的区＝卡永久
        // 截断在出生高、下层卡贴着切边压脸（真机 2026-10-06：工具卡只剩半截
        // 头、分析卡紧贴其下）。强制刷视口让 onRender 空闲期交 host，再按真高
        // 结账。离屏 marker xterm 不建元素，不等空（_markerOnScreen 门卫）
        if (!slot.host && this._markerOnScreen(slot)) {
          try { this.term.refresh(0, this.term.rows - 1); } catch (e) {}
          const t0 = Date.now();
          while (!slot.host && !this._dead && Date.now() - t0 < 300) {
            await this._sleep(10);
          }
        }
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

  // 紧下方还没露面的卡（未 reveal 未冻结）：视觉零存在——锚点下移用户无感。
  // 盖帽判据不区分「下方被真输出/已露面的卡占住」与「下方只是张没露面卡的
  // 未 fund 空白尾」，后者其实可以让（见 _stealBlankBelow）
  _unrevealedBelow(slot) {
    if (!slot || !slot.marker) return null;
    let low = null;
    for (const o of this._slots.values()) {
      if (o !== slot && o.marker && o.marker.line > slot.marker.line &&
          (!low || o.marker.line < low.marker.line)) low = o;
    }
    if (!low || low.revealed || low.frozen) return null;
    return low;
  }

  // 盖帽欠账回收：真高度量出来时区已被下层 marker 闭合（React 慢flush/徽标
  // 折行/离屏迟到量高），pad 只追加流底、垫不进本区＝永久截断（真机 2026-10-06
  // 工具卡半截头）。下层卡若还没露面（_unrevealedBelow），把它锚点下移到本卡
  // 真高之后：让出的空白本是无主 run，下层缺的行它自己在流底补；重贴它的
  // decoration（host 随 onRender 迁移，React root 同换贴纸路径）。下层已露面
  // 则不动——宁截不跳。500ms 节流防连发撕贴纸
  async _stealBlankBelow(slot) {
    if (this._dead || !slot.marker || this._padFused) return false;
    if ((slot.reserved || 0) >= (slot.rows || 0)) return false;
    if (Date.now() - (slot._stoleAt || 0) < 500) return false;
    slot._stoleAt = Date.now();
    const buf = this.term.buffer.active;
    if (buf !== this.term.buffer.normal) return false;
    const low = this._unrevealedBelow(slot);
    if (!low || !low.marker) return false;
    const cursorAbs = buf.baseY + buf.cursorY;
    const want = this._regionStart(slot) + Math.max(1, slot.rows || 1);
    if (want <= low.marker.line || want > cursorAbs) return false;
    // [下层旧锚, want) 必须整段空白才敢移锚：夹了真输出就不是无主 run
    if (low.marker.line + blankRun(buf, low.marker.line, want) < want) {
      return false;
    }
    const m = this.term.registerMarker(want - cursorAbs);
    if (!m) return false;
    const old = low.marker;
    low.marker = m;
    try { old.dispose(); } catch (e) {}   // 身份守卫下旧钉 dispose 不删槽
    if (low.decoration) {
      try { low.decoration.dispose(); } catch (e) {}
      low.decoration = null;
    }
    low.host = null;
    low.pinnedRows = null;
    low.clamped = false;
    low.reserved = 0;
    low.forceReapply = false;
    this._applyDecoration(low, 2);   // 新钉重贴；onRender 交 host 并迁 React root
    this._holdBytes("card-steal");
    try {
      slot.reserved = this._blankSpan(slot);
      this._reanchor(slot);          // reserved 追上 rows → 解钉/放行/长回
      await this._ensurePad(low);    // 下层让出的行它自己在流底补回
      await this._drainHeld();
      this._reanchor(low);
    } finally {
      this._releaseBytes();
    }
    return true;
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
      // 盖帽者是「还没露面的下层卡的未 fund 空白尾」时移锚收回本区（宁矮不盖
      // 只对已被占住的区成立）；收回成功内部已重锚双方，直接返回
      if (blank < slot.rows && await this._stealBlankBelow(slot)) return;
      // 垫不进本区（下方已有输出/别的卡）：预留够高就原地不补；不够只能
      // 夹紧截断（宁可矮不许盖）。大头在 _mountCard 锚定新卡前的 settle
      // 窗口里提前补掉。
      if (blank < slot.rows) this._clampCard(slot);
      // 盖帽零垫（一行空白都没有）的非审批卡不走「盖帽即放行」：露出必被
      // 输出切成半行细条，整卡藏到定格/冻结阀放出。权衡：徽标陪跑观感差于
      // 细条，故只藏零空白档；blankSpan ≥ 1 照旧放行露出已垫部分
      if (slot.kind !== "approval" && this._blankSpan(slot) === 0) {
        this._refreshThink();   // 卡不放行：徽标继续接班（显→隐沿同款）
        return;
      }
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
        slot.ackDeferred = false;   // _onPadded 按 ack 事件的 deferred 置位
        slot.padOut = (slot.padOut || 0) + gap;
        // mirror：可信的半行镜像交给 worker 收纳/复原——pad 注入不再吞掉
        // 用户正在敲的输入（dirty 时省略，worker 走旧的丢弃路径）
        this.sendJson({type: "pad", pad: gap,
                       mirror: this._lineDirty ? undefined : this._lineBuf});
        const blankBefore = this._blankSpan(slot);
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
        } else if (!slot.marker) {
          // 等待期间卡已散场：无从对账，也不冤枉通道
        } else if (!slot.ackDeferred && slot.marker) {
          // ack 不作凭据只唤醒（_onPadded），这里对账：空白一行没长 =
          // 通道谎报——su - 换壳后嵌套壳标记流还在、hook 函数已空，后端
          // 把 pad 行敲进裸壳只换来 command not found + 新提示符而 ack 照
          // 发，超时熔断永远够不着，pad 请求循环把提示符敲成横排墙（真机
          // 101.33 su - 后截图）。与超时同账：先灌在途字节再数，连败 2 次
          // 熔断，宁截断不空转。deferred（重注入在途窗口）不计：痊愈后
          // 下一轮 pad 自会补齐
          await this._drainHeld();
          if (this._blankSpan(slot) <= blankBefore) {
            this._padFailStreak++;
            if (this._padFailStreak >= 2) this._fusePads();
          } else {
            this._padFailStreak = 0;
          }
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

  _onPadded(ev) {
    // deferred：重注入在途窗口的 ack——空白没长是暂时现象，不计熔断连败
    if (this._padSlot) this._padSlot.ackDeferred = !!(ev && ev.deferred);
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
    if (this._cardsText) this._cardsText.delete(slot.id);
    // 同 id 被新槽顶替后，旧槽 marker 迟到 dispose 不得删掉新槽（unmount
    // 的是新槽的 React root = 卡片凭空消失）
    if (this._slots.get(slot.id) === slot) {
      if (this._feed) this._feed.unmount(slot.id);
      this._slots.delete(slot.id);
    }
  }

  // 整卡丢弃（收束扫尾/中止移除）：marker 一并 dispose，锚点不留尸体钉。
  // 先摘身份再 dispose——onDispose 的身份守卫（slot.marker === marker）不再
  // 触发二次删槽，收尾统一走 _discardSlot
  _dropSlot(slot) {
    if (!slot) return;
    const m = slot.marker;
    slot.marker = null;
    if (m) { try { m.dispose(); } catch (e) {} }
    this._discardSlot(slot);
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
    this._approvalResolved = false;
    this._runningTool = "";
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
        // 盖帽卡也过一遍回收：盖帽者若只是没露面的下层卡空白尾，移锚收回
        // 本区（节流 500ms）；真被占住的区 steal 自会空手返回
        .then(() => (capped ? this._stealBlankBelow(slot) : this._ensurePad(slot)))
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
      // 盖帽但已 fund：_reanchor 非 short 分支解钉即可，不需要 pad，也要唤醒；
      // 盖帽者还没露面：steal 可能收回本区，欠账也要唤醒重试（节流在 steal 内）
      if (owed && (!this._capped(s) || s.reserved >= s.rows ||
                   this._unrevealedBelow(s))) {
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
    this._taskClosed = false;   // 新任务起跑：收束门卫复位（迟到宣告照常挂）
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
    // 徽标同步说人话：模型在跑哪条命令。旧实现全程「AI 正在思考」，
    // 长命令/多轮排查时用户看到的就是假死（真机 bug2 的观感根因之一）。
    if (ev.phase === "start") {
      // 收束后迟到的工具宣告不再挂卡（事件队列尾残迹）——半截卡只减不增
      if (this._taskClosed) return;
      this._runningTool = (ev.name === "execute"
        ? String(ev.args || "") : String(ev.name || "")).trim();
      this._refreshThink();
      this._cardReady = this._cardReady.then(() => this._mountCard(id, "phase")
        .then(slot => {
          if (!slot) return null;
          return this._ensureFeed().then(f => f && f.handle({
            kind: "tool_start", id, name: ev.name || "", args: ev.args || "",
          }));
        }));
    } else {
      this._runningTool = "";
      this._refreshThink();
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
    // ai_card 与 final 同文连发时本调用会去重早退；final 空文本时总结挂载
    // 在这条路上——扫尾同样等挂载完再查完整性
    this._endSweepSoon(this._mountSummary(markdown, null, false));
  }

  _onFinal(text) {
    this._taskActive = false;
    this._taskClosed = true;   // 收束：迟到的工具宣告不再挂卡
    this._approvalOpen = false;   // 任务收束：未决审批窗（若有）一并释放
    this._approvalCmd = null;
    this._approvalResolved = false;
    this._runningTool = "";
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
    const mp = this._mountSummary(text, transform ? reuse : null, transform);
    // 换装路径由 _mountSummary 自己结账；新开总结卡时把定格的分析卡垫满
    if (slot && !transform) this._settleCard(slot);
    this._scheduleHeal();
    // 收束扫尾等总结卡挂完：总结/残留卡要么垫满完整显示、要么整卡消失
    this._endSweepSoon(mp);
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
  // 状态栏（终端网格只留原生字节，不写系统提示——单管线约束）。
  // interrupt（Ctrl+C/⏹）例外：流式**未渲染完毕**的卡整卡移除——store
  // task_fail 撤内容、onDrop 丢槽（用户诉求：不显示半截/中断态尸块，
  // 要么不显示要么显示完整），活流卡不做失败定格。任何收束都过
  // _endSweepSoon：仍不完整的卡垫不满就整卡消失。
  _onTaskFail(kind, text) {
    this._taskActive = false;
    this._taskClosed = true;   // 收束：迟到的工具宣告不再挂卡
    this._approvalOpen = false;   // 中止即收束：审批窗释放，徽标归位
    this._approvalCmd = null;
    this._approvalResolved = false;
    this._runningTool = "";
    this._endTimer();
    this._setStopVisible(false);
    this._refreshThink();
    const interrupted = kind === "interrupt";
    const slot = this._taskCardId ? this._slots.get(this._taskCardId) : null;
    if (slot && !interrupted) { slot.frozen = true; slot.frozenAt = Date.now(); }
    this._taskCardId = null;
    this._ensureFeed().then(f => f && f.handle({kind: "task_fail", reason: kind}));
    this.setStatus(kind === "denied" ? "error" : this.status,
                   text || (kind === "denied" ? "✗ 已拒绝" : "任务已中止"));
    if (slot && !interrupted) this._scheduleReanchor(slot);
    this._scheduleHeal();
    this._endSweepSoon();
  }

  // 收束扫尾编排：串行防重入（fail 紧跟 final 两连发不交错），等在途挂载链、
  // 挂载串行队列与 extra（总结挂载）全部落定再查完整性
  _endSweepSoon(extra) {
    const run = async () => {
      try {
        await Promise.all([
          this._cardReady || Promise.resolve(),
          this._mountQ || Promise.resolve(),
          extra || Promise.resolve(),
        ]);
        await this._endSweep();
      } catch (e) {}
    };
    this._sweepQ = (this._sweepQ || Promise.resolve()).then(run, run);
    return this._sweepQ;
  }

  // 收束不变量：中断/任务结束后卡片要么完整显示、要么整卡消失——不留半截。
  // ① store 扫迟到补挂的未完毕内容卡（sweep）；② 逐槽结账一次给「垫得进去」
  // 的卡补齐机会；仍不完整的（盖帽垫不进/夹紧/pendingMount）整卡丢弃。
  // 审批/救援卡豁免：按钮行底线夹紧是功能（可点性优先），不算半截尸块。
  async _endSweep() {
    if (this._dead) return;
    const feed = await this._ensureFeed();
    if (feed) feed.handle({kind: "sweep"});
    // React 把定格内容渲一帧再量高（_settleCard 自带 host 补挂），否则量到半截
    await new Promise(r => requestAnimationFrame(() => r()));
    const settle = [...this._slots.values()]
      .filter(s => s.marker && s.kind !== "approval");
    await Promise.all(settle.map(s => this._settleCard(s).catch(() => {})));
    await new Promise(r => requestAnimationFrame(() => r()));
    const drop = [];
    for (const slot of [...this._slots.values()]) {
      if (!slot.marker || slot.kind === "approval") continue;
      const full = slot.mounted && !slot.pendingMount &&
                   slot.pinnedRows == null && !slot.clamped &&
                   (slot.reserved || 0) >= (slot.rows || 1);
      if (full) {
        if (!slot.revealed) this._revealSlot(slot);
      } else {
        drop.push(slot.id);
        this._dropSlot(slot);
      }
    }
    if (drop.length && feed) feed.handle({kind: "drop", ids: drop});
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
    // 补发去重（WS 重连/刷新重挂时 attach 会再投一次未决审批）：同命令
    // 的未决卡/模态已在，不叠第二张（core 的 _pending_approval 只记一条）
    if (this._approvalOpen && this._approvalCmd === command) return;
    // 未决态必须同步记账，不能等卡片层落定：_ensureFeed() 一卡（脚本加载
    // 慢、promise 不落），徽标就停在「AI 正在思考」、审批 UI 一张不出，而
    // core 侧在干等决策——真机看就是任务卡死（bug2 截图）。球此刻已在用户侧。
    this._approvalOpen = true;
    this._approvalCmd = command;
    this._approvalResolved = false;   // 新一令：上一令的已决策态不带到本令
    this._refreshThink();
    this._ensureFeed().then(async feed => {
      // 慢到的卡片层：决策已下 / 命令已换就别再挂旧卡
      if (this._dead || this._approvalCmd !== command) return;
      if (!feed) return this._approvalModal(command, reasons);
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
        this._refreshThink();
        if (up) await this._settleCard(up);
      }
      const cardId = ++this._cardSeq;
      // 先入 store 再挂卡：host 一诞生就渲染出完整审批卡，_fitNeed 首测即真高，
      // 一轮 pad 垫够。旧序（先挂空卡再 handle）首测量到 0 → 只垫 2 行，内容
      // 随后长到 7 行再补一轮；那 150ms 窗口里卡是钉死截断的，若用户此刻已按
      // Ctrl+Enter 放行、输出随即从卡底流走，预留区断开就永久盖帽补不回来。
      feed.handle({kind: "approval", id: cardId, command, reasons, risk});
      // 挂载不加塞：并行 tool_calls 会让 core 在消息到达时一次发齐全部
      // tool_start（工具卡＝调用宣告，不是已执行），approval 消息随后才到。
      // showApproval 不走 _cardReady 就会抢在「已宣告未挂载」的工具卡前面
      // 锚定＝审批卡居中、下面挂一排未决策的宣告卡（真机 2026-10-08「还没
      // 审批工具卡已经在审批卡下面」）。排进链尾：审批卡落在这批工具卡之
      // 下，决策前屏底不再长新卡。
      const slotP = this._cardReady.then(() => this._mountCard(cardId, "approval"));
      this._cardReady = slotP.then(() => {}, () => {});   // 链不断：挂载失败也放行后续
      const slot = await slotP;
      // 排队等链扩出了窗口：挂载返回时命令可能已决策/被下一令顶掉（WS 重连
      // 补发、卡内快捷键在 handle 后即生效）——迟到的审批卡上屏＝给已决的
      // 命令再摆一扇按钮。void 进 store + 出清槽，与看门狗同口径。
      if (this._dead || this._approvalResolved ||
          this._approvalCmd !== command) {
        if (slot) {
          feed.handle({kind: "approval_void", id: cardId});
          this._discardSlot(slot);
        }
        return;
      }
      if (!slot) return this._approvalModal(command, reasons);
      // 可点性看门狗：mounted 且未夹紧（pinnedRows == null）才等于用户真点
      // 得到。pad 未落账/盖帽 → pinnedRows 钉死；审批期终端静默 → xterm 不跑
      // 渲染循环、pendingMount 永无 host——两者都等于「用户点不到」（真机
      // 2026-10-06：审批卡不可见、core 干等决策假死 25min）。grace 内不达标
      // 即 void 终端卡转模态，审批永远有可点的入口。
      const t0 = Date.now();
      while ((!slot.mounted || slot.pinnedRows != null) &&
             Date.now() - t0 < this._approvalGraceMs) await this._sleep(100);
      if (!slot.mounted || slot.pinnedRows != null) {
        // grace 期内用户可能已按 Ctrl+Enter 放行：再转模态就是给已决策的
        // 命令再开一扇「批准」，点下去第二发决策会落到 core 下一次
        // ask_decision 头上＝幽灵批准（真机 B1：卡被夹紧→Ctrl+Enter 放行
        // →3s 后模态又冒出来，再点一次就双决策）。
        if (this._dead || this._approvalResolved ||
            this._approvalCmd !== command) return;
        feed.handle({kind: "approval_void", id: cardId});
        this._discardSlot(slot);
        this._approvalModal(command, reasons);
      }
    }).catch(e => {
      // 卡片层中途抛错也不能让审批静默死掉——core 在等决策，任务会假死。
      // 转模态兜底，决策永远有可点入口；已有模态就不叠第二张。
      console.error("[ot] 审批卡渲染失败，转模态兜底:", e);
      if (this._dead || this._approvalResolved ||
          this._approvalCmd !== command) return;
      if (!document.querySelector("#modal-root .modal")) {
        this._approvalModal(command, reasons);
      }
    });
  }

  // 审批模态兜底（feed 缺失 / 挂载失败 / 看门狗超时共用）：决策直发 WS、不经
  // store——此刻终端卡已 void 或根本不存在，键盘快捷键路径无未决卡可双决策。
  _approvalModal(command, reasons) {
    modalShell("审批：" + (command || ""),
      `<p>${esc(reasons || "")}</p>`,
      [{label: "批准", primary: true,
        onClick: () => this._sendDecision({type: "approve"}, command)},
       {label: "拒绝",
        onClick: () => this._sendDecision(
          {type: "reject", message: "用户拒绝了该命令"}, command)}]);
  }

  // 决策单发出口：卡内 Ctrl+Enter（feed onDecision）与模态按钮都会到，
  // 只放一发。第二发决策会落到 core 下一次 ask_decision 头上，等于替用户
  // 批准一条根本没看过的命令（真机 B1 的幽灵模态双决策）。
  _sendDecision(decision, command) {
    if (this._dead || this._approvalResolved) return false;
    // 命令串对不上＝本令已决策或已被下一令顶掉
    if (command != null && this._approvalCmd !== command) return false;
    this._approvalResolved = true;
    this._approvalOpen = false;
    this._approvalCmd = null;
    this._refreshThink();
    this.sendJson({type: "decision", decision});
    return true;
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
    // tab 标签页上的状态点（每 tab 独立）：绿=已连接、红=断开、黄闪=连接中
    const td = this.tabEl && this.tabEl.querySelector(".tab-dot");
    if (td) td.className = "dot tab-dot " + state;
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
    // 状态栏说清在跑哪条:只报 1/3 计数时用户看不出第 2、3 条到底执行了
    // 没有(真机反馈「只显示了第 1 条命令的执行记录」)。应答行不带内容
    // (core 对 `>` 行传空串),防密码泄进状态栏。
    const cmd = msg.cmd ? String(msg.cmd) : "";
    const short = cmd.length > 40 ? cmd.slice(0, 40) + "…" : cmd;
    el.textContent = `命令集 ${msg.index || ""}/${msg.total || ""}` +
      (short ? "：" + short : "");
    el.title = cmd ? "正在执行：" + cmd : "";
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
    if (el) {
      el.hidden = !this._taskActive;
      // 等审批期间球在用户侧：徽标文案说实话（旧实现照转「AI 正在思考」，
      // 真机假死 25min 无人知晓在等决策）
      const tt = el.querySelector ? el.querySelector(".ttext") : null;
      // 徽标三态说实话：等审批 > 在跑命令 > 在思考。长命令/多轮排查时
      // 不能一路「AI 正在思考」——用户看到的就是假死（bug2 观感根因）。
      let text = "AI 正在思考";
      let title = "任务未结束：AI 正在分析或执行";
      if (this._runningTool) {
        const t = this._runningTool.length > 36
          ? this._runningTool.slice(0, 36) + "…" : this._runningTool;
        text = "执行中: " + t;
        title = "正在执行: " + this._runningTool;
      }
      if (this._approvalOpen) {
        text = "等待审批";
        title = "命令等待你的决定（Ctrl+Enter 执行 / Ctrl+Backspace 拒绝）";
      }
      if (tt) tt.textContent = text;
      el.title = title;
    }
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
  // 契约：ready/status/closed/usage/approval/ask_password/ask_password_dismiss/ask_host_key/
  // interrupt/mode/auth/change_model/task_start/final/denied/limit/error/
  // stage + 新增 ai_token/ai_think/ai_collapse/ai_card/ping。
  handleMsg(msg) {
    switch (msg.type) {
      case "ping":
        break;   // 心跳：存活基线已在 onmessage 记 _lastMsgAt，这里无需动作
      case "ready": {
        this._pwCapture = null;   // 登录成功：退出密码内联捕获
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
        // 本次是手输密码登录成功 → 询问是否记住（错密不会走到 ready，
        // 凭据库只进验证过的密码；记住后下次连接自动填充、免提示直进）
        if (this._pwEntered) {
          this._pwEntered = null;
          modalConfirm("记住密码",
            "已成功登录。记住该主机的密码？下次连接将自动登录" +
            "（写入系统凭据库，不落数据库）",
            ok => {
              if (ok) this.sendJson({type: "auth",
                                     auth_kind: "password_remember",
                                     text: ""});
            }, "记住", "不记住");
        }
        break;
      }
      case "status":
        if (this._awaitWelcome) {   // ready 后第一条 status = 横幅文案
          this._awaitWelcome = false;
          this._welcomeText = msg.text || "";
          // 进入扣留态：PTY 字节扣到提示符落屏，先写横幅再重放（P0-3：
          // 此前 _welcomeHold 从未被赋值，横幅永不落屏、扣留机制全死）
          this._welcomeHold = {raw: null, cleared: 0, at: performance.now()};
          this._armWelcomeDeadline();
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
        if (!msg.auth_kind || msg.auth_kind === "password") {
          // 初始连接讨密码：与真实终端一致——提示符直接落进终端，无回显
          // 收集输入（不弹模态）；错密后端重讨时补 OpenSSH 的 denied 行。
          // 取消=Ctrl+C（发 password_cancel，中止整个连接尝试）
          if (this._pwCapture && this._pwCapture.submitted)
            this._writeTerm("\r\nPermission denied, please try again.");
          this._pwNewline();
          this._writeTerm(msg.label || "密码: ");
          // 撤连接浮层让提示符可见（ready/closed 自会撤，无需恢复）
          const ov = document.getElementById(`connov-${this.tabId}`);
          if (ov) ov.hidden = true;
          this._pwCapture = {kind: "password", buf: "", submitted: false};
          break;
        }
        modalAsk("密码", msg.label, (value, remember) => {
          this.sendJson({type: "auth", auth_kind: msg.auth_kind || "password",
                         text: value, remember});
        }, {remember: msg.auth_kind !== "cmdset",
            rememberLabel: "记住密码（写入系统凭据库，不落数据库）",
            // 嵌套密码模态取消/点遮罩：改终端手输，通知 core 立即退出验证
            // 窗口（否则手输的密码被 hold 到超时才放行）
            onCancel: msg.auth_kind === "nested_password" ? () => {
              this.sendJson({type: "auth", auth_kind: "nested_password_cancel",
                             text: ""});
            } : null});
        break;
      case "ask_password_dismiss":
        // 密码提示符已被终端手输消费：后端防抖代关陈旧模态
        modalDismissPassword();
        break;
      case "ask_remember":
        // 手输密码验证成功后的「记住」询问（嵌套 ssh/sudo，P1-3/P1-4）：
        // 同意 → remember_yes 按后端留档键写 keyring；拒绝 → remember_no
        // 只清档。文案对齐 ready 后的「记住密码」确认框
        modalConfirm("记住密码",
          msg.text || "已成功登录。记住该密码？下次自动填充" +
                      "（写入系统凭据库，不落数据库）",
          ok => {
            this.sendJson({type: "auth",
                           auth_kind: ok ? "remember_yes" : "remember_no",
                           text: ""});
          }, "记住", "不记住");
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
        this._pwCapture = null;   // 连接终结：退出密码内联捕获
        this._pwEntered = null;   // 失败的连接不弹「记住密码」
        this.setStatus("closed", msg.text || "连接已关闭");
        break;
      case "reconnected":
        this.setStatus("connected", msg.text || "已重新连接");
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
        this._onPadded(ev);
        break;
      default:
        break;   // 未知事件静默忽略（此前 JSON.stringify 进终端是调试残留）
    }
  }

  close() {
    this._dead = true;
    if (this._healT) { clearTimeout(this._healT); this._healT = null; }
    if (this._wsRetryT) { clearTimeout(this._wsRetryT); this._wsRetryT = null; }
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
    delete sessions[this.tabId];
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
  b.innerHTML =
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

// Windows/Linux Ctrl+V 焦点抢救：焦点不在 xterm textarea 时（右键菜单点过后
// 焦点落 body、点过边距/状态栏等），keydown 到不了 xterm，原生 paste 也无从
// 发生——单靠 xterm 钩子放行救不了这种场景。这里把当前 tab 的终端同步拉回
// 焦点，随后的默认 paste 动作即落进 xterm 的 textarea 走其粘贴监听。焦点本
// 就在某个输入框（xterm 的 textarea、弹窗/审批编辑器等 UI 输入框）时不抢，
// 各自保留原生粘贴语义。
document.addEventListener("keydown", ev => {
  if (IS_APPLE || !ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey ||
      (ev.key !== "v" && ev.key !== "V" && ev.keyCode !== 86)) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" ||
             ae.isContentEditable)) return;
  const s = sessions[activeTabId];
  if (s && !s._dead) { try { s.term.focus(); } catch (e) {} }
});

// 卡片 island 内的浏览器原生复制（选区在卡内按 Cmd/Ctrl+C / 右键复制）：同样弹
// 「已复制」。仅当选区锚点落在 .ot-card-host 里才弹——终端复制路径走 _copyText
// 已有自己的提示，这里不会重复弹（xterm 选区不是 DOM 选区，卡外 copy 事件不命中）
document.addEventListener("copy", ev => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (el && el.closest && el.closest(".ot-card-host")) {
    const s = sessions[activeTabId];
    if (s) s._toastCopied();
  }
}, true);

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
