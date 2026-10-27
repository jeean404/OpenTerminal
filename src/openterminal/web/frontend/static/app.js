"use strict";

function _t(key, ...args) {
  // node 测试单独 require 本文件时全局 t 不存在：回落原文，但占位符仍要替换，
  // 否则断言会拿到带 {0} 的键
  const text = (typeof t === "function") ? t(key) : key;
  if (!args.length) return text;
  return String(text).replace(/\{(\d+)\}/g, (whole, n) =>
    args[Number(n)] === undefined ? whole : String(args[Number(n)]));
}

// OpenTerminal Web 前端：左侧服务器列表 + 右侧多 tab 终端。
// 单管线架构（docs/design-single-pipeline.md）：一个全屏连续 xterm 是唯一渲染
// 管线，PTY 字节直写（SSH/Agent 统一）——Tab 补全、历史、Ctrl+R、vim/top、
// 嵌套 shell、clear 全部走终端原生；AI 卡片以 React island 分区挂载（阿里
// workbench 同款）：卡片占 pad 打孔预留的空白行，输出永远从卡片下方流走。
// 分析卡（流式）、总结卡（mdLite 表格）、审批卡（按钮/编辑/快捷键）。

// HTML 转义（与 md_lite.js 的 esc 同实现；island 的 md_lite 打包进了 ui.js，
// index.html 不再全局装载 md_lite.js，这里本地补一份给 modal/tab 等用）
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
    {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

// otdbg 调试仪表：localStorage.otdbg 置位才输出（生产零成本）。
// 用 performance.now() 打时间戳——真机排「卡顿/回显迟到」必须能和 WS 帧
// 到达、term.write 对齐到同一时钟。
function otdbg(...a) {
  if (typeof localStorage !== "undefined" && localStorage.getItem("otdbg"))
    console.log("[otdbg]", performance.now().toFixed(1), ...a);
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
    modalShell(_t("访问令牌"), `<input type="password" id="modal-value" autofocus>`, [
      {label: _t("确定"), primary: true, onClick: () => {
        setToken(document.getElementById("modal-value").value);
        resolve();
        return true; // close
      }},
    ]);
    document.getElementById("modal-value").focus();
  });
}

// 带 token 的 fetch：**只有真的是令牌问题**才问 token 再重试。
// 401 不等于令牌失效——业务错误（如级联密码错误）也可能用它，误弹「访问令牌」
// 会让用户莫名其妙（真机反馈：点 📁 被要求填访问令牌）。判据：响应体带
// 业务 code（unauthorized 除外）就不是令牌问题，原样交回调用方。
function authFetch(url, opts = {}) {
  // FormData 自带 boundary，强塞 application/json 会毁掉整次上传
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  opts.headers = Object.assign(isForm ? {} : {"Content-Type": "application/json"},
    opts.headers || {});
  const t = getToken();
  if (t) opts.headers["x-ot-token"] = t;
  return fetch(url, opts).then(async r => {
    if (r.status === 401 && !opts._retried && (await _isTokenProblem(r))) {
      await promptForToken();
      const o2 = Object.assign({}, opts, {_retried: true});
      const t2 = getToken();
      if (t2) o2.headers["x-ot-token"] = t2;
      return fetch(url, o2);
    }
    return r;
  });
}

async function _isTokenProblem(r) {
  try {
    const j = await r.clone().json();
    return !(j && j.code && j.code !== "unauthorized");
  } catch (e) {
    return true;      // 读不出 body：按令牌问题处理（旧行为）
  }
}

function wsUrl(tabId) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let url = `${proto}://${location.host}/ws/${tabId}`;
  const t = getToken();
  if (t) url += `?token=${encodeURIComponent(t)}`;
  return url;
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: "rgba(0, 0, 0, 0)",
    foreground: styles.getPropertyValue("--text").trim() || "#e6e8ea",
  };
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

function modalConfirm(title, message, onOk, yesLabel = _t("信任"), noLabel = _t("拒绝")) {
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
    this._toolMountQ = [];      // 待挂工具卡（串行弹出，见 _pumpToolMounts）
    this._toolMounting = false;
    this._feed = null;          // React island 句柄 {handle, mount, unmount, destroy}
    this._feedPromise = null;   // island 懒加载 Promise（失败置空可重试）
    this._lastSummaryMd = null;   // final/ai_card 双发同文的前端去重
    this._padQ = Promise.resolve();  // pad 请求串行队列（应答不串位）
    this._padWait = null;       // 在途 pad 请求的应答 resolver
    this._padSlot = null;       // 在途 pad 请求归属的卡
    this._slots = new Map();    // cardId -> Slot
    this._cardSeq = 0;          // 卡号计数（island 单卡 root 的 key）
    this._cardReady = Promise.resolve();  // 挂载串行链：卡 handle 先于 mount，出生即完整
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
    this._approvalOpen = false; // 有未决策审批（球在用户侧，不显思考徽标）
    this._approvalCmd = null;   // 未决审批的命令（回执/回退显示用）
    this._approvalKey = null;   // 去重键 (卡 id, 命令串)：同串并行命令不互挡
    this._toolCards = new Map(); // ai_tool id(数字 tool_card_seq) → 卡 id（类型统一）
    this._approvalGraceMs = 6000; // 审批卡可点性看门狗：fund 未到限内转模态兜底
    // （挂载链含 pad 串行，慢机 3s 不够——审批先到卡还在挂载＝误转模态）
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
    this._followStream = true;   // 跟流意愿：用户翻走即停（见 _onStageScroll）
    this._userScrolling = false; // 用户手势进行中（滚轮/触摸/拖滚动条）
    this._userScrollT = 0;
    this._buildDom();
    this._buildTerm();
    // 监听可视区而非终端内容：卡片增多只增加滚动长度，不递归撑高终端。
    const stage = this.paneEl.querySelector(".ot-stage");
    // 跟流意愿：跟着滚；用户一往上翻就停住，回到流底自动再跟
    if (stage) {
      const mark = () => this._markUserScroll();
      stage.addEventListener("scroll", () => this._onStageScroll(), { passive: true });
      stage.addEventListener("wheel", mark, { passive: true });
      stage.addEventListener("touchmove", mark, { passive: true });
      // 只认真正的滚动手势。pointerdown 不算：点一下卡片/终端也是 pointerdown，
      // 若把那次点击当手势，随后卡片 scrollIntoView 的原生滚动就会被误判成
      // 「用户翻走」把跟流关掉（真机⑤）。拖滚动条是 pointermove+按键，够用。
      stage.addEventListener("pointermove", ev => {
        if (ev.buttons) mark();
      }, { passive: true });
      stage.addEventListener("keydown", ev => {
        if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown)$/.test(ev.key)) mark();
      }, { passive: true });
    }
    if (stage && typeof ResizeObserver !== "undefined") {
      this._layoutObserver = new ResizeObserver(() => {
        cancelAnimationFrame(this._layoutFrame);
        this._layoutFrame = requestAnimationFrame(() => {
          if (!this._dead) {
            this.fit();
            this._followBlockStream();
          }
        });
      });
      this._layoutObserver.observe(stage);
      const blocks = stage.querySelector(".ot-blocks");
      if (blocks) {
        this._stageContentObserver = new ResizeObserver(() => {
          this._followBlockStream();
        });
        this._stageContentObserver.observe(blocks);
      }
    }
  }

  // ── 跟流（已定决策：跟着滚；用户一往上翻就停住）──────────────────
  // 几何与意愿判定见 static/follow_intent.js。这里只量几何、按意愿补滚动。
  _stageEl() {
    return this.paneEl ? this.paneEl.querySelector(".ot-stage") : null;
  }

  // 意愿只由**用户手势**改：滚轮 / 触摸 / 拖滚动条 / 翻页键。
  // 为什么不能听 scroll 事件：那条流里混着浏览器 scroll anchoring、
  // scrollIntoView、聚焦滚入视口——全是原生滚动，分不出是谁滚的。当成用户滚
  // 就会把跟流误关（真机⑤：跑任务时每张卡 scrollIntoView 一次，尾巴越飘越远）；
  // 反过来当成程序滚又会跟用户抢滚动条（真机图一→图二）。
  _markUserScroll() {
    this._userScrolling = true;
    clearTimeout(this._userScrollT);
    // 拖滚动条会持续 pointermove；停手 400ms 后结束本次手势
    this._userScrollT = setTimeout(() => { this._userScrolling = false; }, 400);
  }

  // 用户手势进行中的滚动才重算跟流意愿：一往上翻（光标离开视口）就停跟，
  // 回到流底自动再跟（不锁存，无需额外按钮也能恢复跟流）。
  // 不在手势里的滚动一律不动意愿——那是内容在动，不是人在翻；我们主动把人带去
  // 别处的地方（_keepApprovalInView）自己声明停跟，不拿几何猜。
  _onStageScroll() {
    if (!this._userScrolling) return;
    const stage = this._stageEl();
    if (!stage) return;
    this._followStream = this._atStreamTail(stage);
  }

  _atStreamTail(stage) {
    const st = stage || this._stageEl();
    if (!st) return false;
    const cursor = this.paneEl.querySelector(".xterm-cursor");
    const c = cursor ? cursor.getBoundingClientRect() : null;
    return atStreamTail({
      cursor: (c && c.height > 0)
        ? { top: c.top, bottom: c.bottom, height: c.height } : null,
      stage: {
        top: st.getBoundingClientRect().top,
        bottom: st.getBoundingClientRect().bottom,
      },
      scrollTop: st.scrollTop,
      scrollHeight: st.scrollHeight,
      clientHeight: st.clientHeight,
    });
  }

  // 跟流补滚动。force=用户主动提交（回车/执行）：无条件对齐并重新武装；
  // 否则只在用户仍看着活尾巴时补，翻走就一动不动（真机图一→图二的跳变根治点）。
  _followLiveTail(force) {
    if (this._dead || !this.paneEl) return;
    if (force) this._followStream = true;
    else if (!this._followStream) return;
    this._ensureTerminalCursorVisible();
  }

  // 重排/块流变高后的跟流入口（stage RO 与 .ot-blocks RO 都走这里）。
  // 跟的目标是活动终端光标（活尾巴），不是块流底边——贴块流底边会把活动终端
  // 整块挤出视口（真机图二：命令行整块消失，只剩总结卡底）。
  _followBlockStream() {
    this._followLiveTail(false);
  }

  _ensureTerminalCursorVisible() {
    const stage = this._stageEl();
    const cursor = this.paneEl && this.paneEl.querySelector(".xterm-cursor");
    if (!stage || !cursor) return;
    const nudge = cursorNudge(stage.getBoundingClientRect(),
                              cursor.getBoundingClientRect());
    if (!nudge) return;
    stage.scrollTop += nudge;
  }

  _buildDom() {
    const tabBtn = document.createElement("button");
    tabBtn.className = "tab";
    tabBtn.id = `tabbtn-${this.tabId}`;
    tabBtn.innerHTML = `<span class="dot tab-dot connecting" title="${_t("连接状态")}"></span><span class="tab-name">${esc(this.name)}</span><span class="tab-x" title="${_t("关闭")}">×</span>`;
    tabBtn.querySelector(".tab-name").onclick = () => activateTab(this.tabId);
    tabBtn.querySelector(".tab-x").onclick = ev => { ev.stopPropagation(); closeTab(this.tabId); };
    const runTextBtn = () => this._openRunTextDialog();
    document.getElementById("tabs").appendChild(tabBtn);
    this.tabEl = tabBtn;

    const pane = document.createElement("div");
    pane.className = "pane";
    pane.id = `pane-${this.tabId}`;
    pane.innerHTML = `
      <div class="pane-head">
        <div class="seg" role="tablist">
          <button data-mode="ssh">Shell</button>
          <button data-mode="agent" class="on">Agent</button>
        </div>
        <div class="pane-host" id="host-${this.tabId}"></div>
        <button class="files-toggle" id="filesbtn-${this.tabId}" tabindex="-1" title="${_t("远程文件：登录该主机的家目录（上传/下载）")}">${_t("📁 文件")}</button>
      </div>
      <div class="ot-stage" id="stage-${this.tabId}">
        <div class="ot-blocks" id="blocks-${this.tabId}"></div>
        <div class="term" id="term-${this.tabId}"></div>
      </div>
      <div class="statusbar">
        <span class="status-connect" id="conn-${this.tabId}" title="${_t("正在建立连接")}"><i class="cspin"></i><span>${_t("连接中")}</span><span class="cdots"></span></span>
        <span class="status-think" id="think-${this.tabId}" hidden title="${_t("任务未结束：AI 正在分析或执行")}"><i class="tspin"></i><span class="ttext">${_t("AI 正在思考")}</span><span class="tdots"></span></span>
        <span class="status-text" id="status-${this.tabId}"></span>
        <span class="status-meta">
          <span class="status-cmdset" id="cs-${this.tabId}"></span>
          <button class="run-text-btn" id="runtext-${this.tabId}" tabindex="-1" title="${_t("粘贴长文本并作为一条命令执行")}">${_t("执行长文本")}</button>
          <button class="status-newtask" id="newtask-${this.tabId}" tabindex="-1" title="${_t("开启新会话（/clear）：清掉本轮 AI 卡片与任务上下文")}">${_t("新会话")}</button>
          <button class="status-stop" id="stop-${this.tabId}" hidden tabindex="-1" title="${_t("停止当前任务（Ctrl+C）")}">⏹</button>
          <span class="status-tokens" id="tokens-${this.tabId}" title="${_t("累计 token 消耗（输入/输出）")}"></span>
          <select class="status-model" id="model-${this.tabId}" tabindex="-1" title="${_t("切换模型")}"></select>
          <span class="status-time" id="time-${this.tabId}" title="${_t("任务耗时")}"></span>
          <span class="status-size" id="size-${this.tabId}"></span>
        </span>
      </div>`;
    document.getElementById("panes").appendChild(pane);
    pane.querySelector(".run-text-btn").onclick = runTextBtn;
    this.paneEl = pane;

    this.filesPanel = new FilePanel(this);
    document.getElementById(`filesbtn-${this.tabId}`).onclick = () => this.filesPanel.toggle();

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
    // 通用设置里的终端偏好（字号/缓冲/光标）在这里落地；缺省值与设置页一致
    const termOpts = window.__otTermOptions || {};
    const term = new Terminal({
      cursorBlink: termOpts.cursorBlink !== false,
      fontSize: Number(termOpts.fontSize) || 13,
      scrollback: Number(termOpts.scrollback) || 5000,
      cursorStyle: termOpts.cursorStyle || "block",
      convertEol: true,
      scrollOnUserInput: true,
      // registerMarker（卡片层锚定）在 xterm 5+ 为稳定 API；
      // allowProposedApi 保留以防后续接入装饰类扩展
      allowProposedApi: true,
      // 透明默认底色让终端透出工作区背景；前景跟随界面主题。
      theme: terminalTheme(),
    });
    this.term = term;
    this.fitAddon = new FitAddon.FitAddon();
    term.loadAddon(this.fitAddon);
    term.open(this.paneEl.querySelector(`#term-${this.tabId}`));
    // 选中即复制：监听常驻，开关只在触发时判断（免得反复注册/注销）
    term.onSelectionChange(() => {
      if ((window.__otTermOptions || {}).copyOnSelect) {
        const sel = term.getSelection();
        if (sel) this._copyText(sel);
      }
    });
    // 连接中浮层：盖在终端区中央，两阶段文案（连接中 → 初始化 Agent，由
    // worker 的 stage 事件切换），ready/closed/error 即撤（setStatus 统一
    // 切换）；须在 term.open 之后插入，xterm 接管容器
    const termEl = this.paneEl.querySelector(`#term-${this.tabId}`);
    termEl.insertAdjacentHTML("beforeend",
      `<div class="connect-overlay" id="connov-${this.tabId}">` +
      `<i class="cspin"></i><span class="ctext">${_t("连接中")}</span>` +
      `<span class="cdots"></span></div>`);
    // 键盘字节直发 PTY（契约：input 保留）。外部分类触发链：agent 模式下
    // 整行带自然语言特征（CJK/? 前缀）时不发回车，改送 submit 让 worker 直接
    // 起任务——触发不再依赖 shell hook（sudo su - 等 login shell 重置后仍可用）；
    // 其余按键原样透传，命令执行/英文自然语言仍由 shell hook 分类（行为不变）。
    // 全屏应用（vim/htop 走 alternate buffer）不拦截，Enter 照常送达。
    let imeCommit = null;
    let imeDuplicate = null;
    let imeComposing = false;
    let imeEndedAt = 0;
    let imeSuppressTabUntil = 0;
    const forwardInput = d => {
      if ((imeComposing || Date.now() < imeSuppressTabUntil) &&
          d.includes("\t")) {
        d = d.replace(/\t/g, "");
        if (!d) return;
      }
      if (imeDuplicate && Date.now() < imeDuplicate.until) {
        const i = d.indexOf(imeDuplicate.text);
        if (i >= 0) {
          d = d.slice(0, i) + d.slice(i + imeDuplicate.text.length);
          imeDuplicate = null;
          if (!d) return;
        }
      }
      if (imeCommit && d.includes(imeCommit.text)) imeCommit.sent = true;
      if (d.includes("\r")) {
        term.scrollToBottom();
        this._followLiveTail(true);
      }
      // WS 未就绪（连接中/重连间隙）不丢键：缓存待开连后按序回放。旧实现
      // 静默丢弃——刚开页就打字时前几个 IME 提交整段消失（「整行只剩尾巴」
      // 嫌疑之一；回放走 _feedData 同一条 submit 拦截链，语义不旁路）
      if (!this.ws || this.ws.readyState !== 1) {
        this._keyBacklog = this._keyBacklog || [];
        this._keyBacklogBytes = (this._keyBacklogBytes || 0) + d.length;
        if (this._keyBacklogBytes <= 65536) this._keyBacklog.push(d);
        else if (!this._keyBacklogWarned) {
          this._keyBacklogWarned = true;
          this.setStatus("closed", _t("连接未就绪，输入缓存已满，后续按键被丢弃"));
        }
        return;
      }
      this._feedData(d);
    };
    term.onData(forwardInput);
    const queueImeCommit = text => {
      if (!text || imeCommit && imeCommit.text === text) return;
      const commit = {text, sent: false};
      imeCommit = commit;
      setTimeout(() => {
        if (imeCommit !== commit) return;
        imeCommit = null;
        if (commit.sent) return;
        forwardInput(text);
        const duplicate = {text, until: Date.now() + 250};
        imeDuplicate = duplicate;
        setTimeout(() => {
          if (imeDuplicate === duplicate) imeDuplicate = null;
        }, 250);
      }, 20);
    };
    const input = termEl.querySelector(".xterm-helper-textarea");
    if (input) {
      input.addEventListener("compositionstart", () => {
        imeComposing = true;
        imeEndedAt = 0;
        imeSuppressTabUntil = 0;
        imeDuplicate = null;
      });
      input.addEventListener("beforeinput", ev => {
        if (ev.inputType === "insertFromComposition") queueImeCommit(ev.data);
      });
      input.addEventListener("compositionend", ev => {
        imeComposing = false;
        imeEndedAt = Date.now();
        imeSuppressTabUntil = imeEndedAt + 150;
        queueImeCommit(ev.data);
      });
    }
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
      // IME 用 Tab 选中文候选时不是 shell 补全；不能把候选键透传为
      // \t，否则 Bash 会弹出 "Display all possibilities?"。
      if (ev.type === "keydown" &&
          (ev.key === "Tab" || ev.code === "Tab" || ev.keyCode === 9) &&
          (ev.isComposing || imeComposing ||
           Date.now() - imeEndedAt < 100)) {
        imeSuppressTabUntil = Date.now() + 100;
      }
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
      console.warn(_t("[ot] 扣流泄漏强制放行:"), (this._holdTags || []).join(","));
      this._holdDepth = 1;
      this._releaseBytes();
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    // 发过东西却久无回音（回显/事件/心跳全断）：传输层可能假活（服务端
    // sender 卡死/sink 僵尸），等 onclose 永不触发——主动close走退避重连
    if (this._lastSendAt > this._lastMsgAt &&
        now - this._lastSendAt > 8000 && now - this._lastMsgAt > 15000) {
      console.warn(_t("[ot] 连接无响应，主动重连"));
      this.setStatus("closed", _t("连接无响应，正在重连"));
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
          !this._forceCmd &&          // 长文本弹框明确要「作为一条命令」
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
    this._wsOpened = false;   // 本次连是否握过手：分「没连上」与「连上又断」
    // 上行记账（看门狗判「发过却无回音」）：send 有两个直调点（raw 字节与
    // sendJson），统一在包装里记，避免漏记
    const rawSend = ws.send.bind(ws);
    ws.send = d => { this._lastSendAt = Date.now(); return rawSend(d); };
    // 开连（或重连）后按序回放 WS 未就绪期缓存的按键（onData 不丢键）
    ws.onopen = () => {
      this._wsOpened = true;
      this._wsRetries = 0;
      const bl = this._keyBacklog;
      this._keyBacklog = null;
      this._keyBacklogBytes = 0;
      this._keyBacklogWarned = false;
      if (bl) for (const d of bl) this._feedData(d);
      // 退避重连成功的回连：worker 宽限期内 PTY 还活着，不会再发 ready，
      // 自行把状态翻回已连接（若 PTY 已死，首个键走 worker 重连链再纠正）
      if (this._everRetried && !this._dead) this.setStatus("connected", _t("连接已恢复"));
    };
    // PTY 原始字节走二进制帧直写唯一 xterm（契约），JSON 控制事件走 handleMsg
    ws.onmessage = ev => {
      this._lastMsgAt = Date.now();   // 心跳 ping 也走这里：看门狗的存活基线
      if (ev.data instanceof ArrayBuffer) {
        this._lastByteAt = Date.now();
        const u8 = new Uint8Array(ev.data);
        this._ingestBytes(u8);
      } else {
        let m;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m && typeof m === "object") this.handleMsg(m);
      }
    };
    ws.onclose = ev => {
      this._pwCapture = null;   // 断线终结登录期密码捕获，重连后不残留
      this._pwEntered = null;
      this._failPads();
      // 4401/4404（鉴权失败 / worker 已回收）重试无意义。这两个码能到得了
      // 这里，是因为服务端 _reject_ws 先 accept 再 close；旧行为在 accept
      // 前 close，被 uvicorn 翻成握手 403，客户端只拿到 1006，下面的判死
      // 条件永不生效，于是拿旧 tabId 无限重连、每次被拒（真机三连 403）。
      if (ev.code === 4401 || ev.code === 4404) {
        this.setStatus("closed", ev.code === 4401
          ? _t("访问令牌无效，请刷新页面")
          : _t("会话已失效，请从左侧重新连接"));
        return;
      }
      this.setStatus("closed", _t("连接已关闭"));
      if (!this._dead) this._scheduleWsRetry();
    };
  }

  // 服务端还在吗：**任何 HTTP 响答都算活着**（401 也算），只有网络层失败
  // 才算不在。别用 authFetch——它撞上 401 会弹「访问令牌」模态，后台探测
  // 弹框会莫名其妙打断用户（真机反馈同款）。
  async _serverAlive() {
    try {
      const t = getToken();
      await fetch("/api/targets", {
        cache: "no-store",
        headers: t ? {"x-ot-token": t} : {},
      });
      return true;
    } catch (e) {
      return false;
    }
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
      console.warn(_t("[ot] 第 {0} 次重连，{1}ms 后", this._wsRetries, delay));
    this._wsRetryT = setTimeout(async () => {
      this._wsRetryT = null;
      if (this._dead) return;
      // 上一次压根没握上手（不是断线）：先探服务端死活。活着却拒绝握手 ＝
      // 这个 tab 已随服务重启消失，再连多少次都是被拒（真机三连 403）；
      // 服务端无响应才是真·断线，按上面「不限次数」继续退避重连。
      if (!this._wsOpened && (await this._serverAlive())) {
        this.setStatus("closed", _t("会话已失效，请从左侧重新连接"));
        return;
      }
      this.connectWS();
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
    otdbg("hold+", tag, "depth=" + this._holdDepth);
    if (!this._holdBuf) this._holdBuf = [];
    this._holdTags = this._holdTags || [];
    this._holdTags.push(tag || "");
    if (this._holdDepth === 1) this._holdSince = Date.now();
  }

  _releaseBytes() {
    if (!this._holdDepth) return;
    this._holdDepth -= 1;
    otdbg("hold-", "depth=" + this._holdDepth, "held=" + ((this._holdBuf || []).length));
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
    this.term.write(u8, () => {
      if (this._dead) return;
      // 用户翻过 xterm 自己的滚动条就不再拽回（同一「不跟用户抢滚动条」口径）
      let atBottom = true;
      try {
        const b = this.term.buffer && this.term.buffer.active;
        atBottom = !b || b.viewportY >= b.baseY;
      } catch (e) { atBottom = true; }
      if (atBottom) this.term.scrollToBottom();
      this._followLiveTail(false);
    });
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
        console.warn(_t("[ot] 欢迎横幅扣留到点，强制放行"));
        this._releaseWelcome();
      }
    }, 1600);
  }

  _releaseWelcome() {
    if (this._welcomeTimer) { clearTimeout(this._welcomeTimer); this._welcomeTimer = null; }
    const h = this._welcomeHold;
    this._welcomeHold = null;
    if (this._dead || !h) return;
    // 必须走 _ingestBytes 而不是 _writeTerm：卡片挂载/pad 的扣流闸（_holdBytes）
    // 要罩住横幅与重放字节。旧实现直接 _writeTerm 绕过闸门，字节落进正在预留
    // 的卡片区、把连续空白打断 → blankRun=0 → 卡永久夹紧（真机图一根因）。
    // _ingestBytes 会先过 _holdWelcome（此刻已置空，直接放行），再按扣流计数
    // 入 _holdBuf，顺序天然保持：横幅仍在前、提示符仍在后。
    const enc = new TextEncoder();
    if (this._welcomeText) {
      this._ingestBytes(enc.encode("\x1b[2m" + this._welcomeText + "\x1b[0m\r\n"));
    }
    // 静默期定时器放行时 h.raw 可能还是 null（一块字节都没到）——
    // 这里不判就会在 setTimeout 回调里抛 uncaught
    const tail = !h.raw ? null : (h.cleared ? h.raw.subarray(h.cleared) : h.raw);
    if (tail && tail.length) this._ingestBytes(tail);
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
      el.textContent = _t("已复制");
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
    mk(_t("复制"), !sel, () => this._copyText(sel));
    mk(_t("粘贴"), false, () => this._pasteText());
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

  // 等 PTY **入流**沉降（到达静默 >= ms，最多等 maxMs）：用于「先扣流、后锚定」。
  // 扣流只挡字节进 xterm，不挡到达——_lastByteAt 照常更新，故这个静默判据可靠。
  async _waitInputQuiet(ms = 350, maxMs = 2500) {
    const t0 = Date.now();
    while (!this._dead && Date.now() - t0 < maxMs) {
      if (Date.now() - (this._lastByteAt || 0) >= ms) return;
      await this._sleep(30);
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
            this._approvalKey = null;
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
        // 块流布局（Phase 1）：卡片块是流式 DOM 节点，不是 xterm decoration。
        // feed.mount(id, hostEl) 只要一个 DOM 元素，本来就与 xterm 解耦——
        // cards.jsx / island.css 一行不改，观感原样。
        try {
          this._blocks = new BlockStream();
          const host = this.paneEl && this.paneEl.querySelector(
            `#blocks-${this.tabId}`);
          if (host && typeof BlockView === "function") {
            this._blockView = new BlockView(host, { feed: this._feed, follow: false });
          }
        } catch (e) {
          console.error(_t("[ot] 块流初始化失败，回退 decoration 路径:"), e);
          this._blocks = null;
          this._blockView = null;
        }
        return this._feed;
      }).catch(e => {
        console.error(_t("[ot] 卡片层加载失败:"), e);
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
  // 待审批的卡必须始终在视野里：窗口变窄/变矮会把它顶出可视区，而按钮仍然
  // 「在盒内」——用户看不到就等于点不到（真机 800x600 按钮落在折叠线之下）。
  _keepApprovalInView() {
    try {
      for (const slot of (this._slots ? this._slots.values() : [])) {
        if (!slot || !slot.host) continue;
        const el = slot.host.closest ? slot.host.closest(".ot-blk") : null;
        if (!el || typeof el.scrollIntoView !== "function") continue;
        const interactive = slot.host.querySelector(
          ".cmdacts button, .apbtns button");
        if (interactive) {
          el.scrollIntoView({ block: "nearest" });
          // 主动把人带去审批卡：这里之后就别再跟流把人拽回终端尾巴
          this._followStream = false;
          return;
        }
      }
    } catch (e) {}
  }

  // ── 文本分块：冻结当前输出 ─────────────────────────────────────────
  // 卡片要和输出交错，就必须把「已经跑完的输出」从活动终端里搬成一个文本块，
  // 卡片才能落在它下面、新输出再落在卡片下面。搬完 xterm 清屏继续收新输出。
  //
  // 这样得到的顺序正是图二那张效果图：文本 / 卡片 / 文本 / 卡片 / 活动输出。
  // 代价：块与块之间不能跨选（用户已定「不允许跨卡选」）；块内选中复制正常。
  _snapshotTermText(styled = false) {
    try {
      const b = this.term.buffer.active;
      if (styled) return bufferToAnsi(b);
      const out = [];
      for (let i = 0; i < b.length; i++) {
        const ln = b.getLine(i);
        out.push(ln ? ln.translateToString(true) : "");
      }
      return out.join("\n").replace(/\s+$/, "");
    } catch (e) {
      return "";
    }
  }

  // 冻结：当前活动终端的内容 → 文本块，然后清屏继续。内容为空就不切
  // （切出空块只会留下大白空）。
  // afterId：这段输出该挂在谁后面（输出归属）。给了就插到它后面——四张卡并行
  // 时输出按**抢锁序**回来，不贴回自己那张卡就会整坨落到所有卡之后（真机
  // 「四张卡只看得见一条输出」）；不给则流末尾追加（横幅/用户输入这类「卡片
  // 之前」的内容）。afterId 认不出时 BlockStream 自己落到末尾，宁粗不乱插。
  _cutBlock(kind, afterId, echo) {
    if (!this._blocks || !this._blockView) return null;
    const text = this._snapshotTermText(true);
    if (!text || !text.trim()) return null;
    // 搬走即清屏：先 reset 再落位。反过来（落位失败就 return）会把同一段
    // 留在活动终端里，下一次切块再冻一遍 = 同一段输出重复两遍。
    try { this.term.reset(); } catch (e) {}
    return this._placeText(ensureCmdEcho(text, echo), kind, afterId);
  }


  // 落位一段已冻结的输出。afterId = 它归属的那张卡。
  _placeText(text, kind, afterId) {
    // 卡还没落进块流（挂载是异步链，term_close 常抢在它前面）：先存着，
    // 卡一落位就补插到它后面。直接 insertAfter 会因认不出 afterId 退回末尾
    // 追加——那正是「四条输出整坨落在所有卡之后」的症状本身。
    if (afterId != null && !this._blocks.has(afterId)) {
      if (!this._pendingTextByCard) this._pendingTextByCard = new Map();
      const q = this._pendingTextByCard.get(afterId) || [];
      q.push({ kind, text });
      this._pendingTextByCard.set(afterId, q);
      return null;
    }
    const blk = this._blocks.insertAfter(afterId, {
      id: this._blocks.nextId(kind === "transition" ? "trans" : "txt"),
      kind: kind === "transition" ? "transition" : "term",
      state: "frozen",
      payload: { text },
    });
    if (!blk) return null;
    this._blockView.sync(this._blocks.list());
    return blk;
  }

  // ── 输出归属：执行边界括号（term_open / term_close）──────────────────
  //
  // 并行 tool_call 一次宣告 N 张卡，而挂载是异步链（_ensureFeed 加载 React
  // island + scrollIntoView）：N 张卡在第一字节输出到达前就全挂完了，于是
  // 「挂卡时切块」次次切空、一个文本块都生不出来，N 条输出全堆在活动终端，
  // 直到下一张卡（往往是总结卡）才被整段冻成一坨、落在所有工具卡之后。
  //
  // 所以归属不能绑挂载时刻，要绑**执行边界**：后端在 C/D 标记处发
  // term_open/term_close（谁在跑就是谁的），收束时 insertAfter 它自己的卡。
  // 顺序与宣告序无关——抢锁序乱了也贴得对。
  // 归属/切块全部走这条链，且每次快照前等 xterm 把在途 write 解析完：
  // xterm.write 是异步解析的，而 D 标记与最后一段输出常在同一块字节里到达
  // ——不同步等就快照，尾巴会漏给下一次切块（真机 nproc 的「6」被后续挂载
  // 切走、落到流末尾）。链本身保证 open/close/挂载 三者互斥，不互相偷字节。
  _outOp(fn) {
    this._outOpQ = (this._outOpQ || Promise.resolve()).then(fn, fn);
    return this._outOpQ;
  }

  _claimCmdCard(command) {
    const key = String(command || "");
    const q = this._cmdCardQ && this._cmdCardQ.get(key);
    if (!q || !q.length) return null;
    return q.shift();
  }

  // 归位排队的输出：term_close 抢在挂载前到时先存着，卡落位后补插到它后面
  _flushPendingFor(cardId) {
    const pend = this._pendingTextByCard && this._pendingTextByCard.get(cardId);
    if (!pend || !pend.length) return;
    this._pendingTextByCard.delete(cardId);
    for (const t of pend) {
      this._blocks.insertAfter(cardId, {
        id: this._blocks.nextId(t.kind === "transition" ? "trans" : "txt"),
        kind: t.kind === "transition" ? "transition" : "term",
        state: "frozen",
        payload: { text: t.text },
      });
    }
    this._blockView.sync(this._blocks.list());
  }

  _onTermOpen(ev) {
    this._outOp(async () => {
      if (!this._blocks || !this._blockView) return;
      await this._flushWrites();
      // 上一个括号没关（D 标记丢了）：先把它的输出归位，别混进这条
      if (this._outOpen) this._closeOutAnchor();
      this._outOpen = true;
      // 记下回显行：Readline 的「上移一格+擦行」会随机啃掉它，收束时丢了
      // 就用这行补回去。优先用后端拼好的（确定），读缓冲只作兜底
      this._outEcho = styleCmdEcho((ev && ev.echo) ||
        pickCmdEcho(this._snapshotTermText(), ev && ev.command), ev && ev.command);
      this._outAnchor = this._claimCmdCard(ev && ev.command);
    });
  }

  // 收束一段在途输出：冻成文本块贴到它自己的卡后面（认不出卡就落末尾）
  _closeOutAnchor() {
    this._cutBlock(null, this._outAnchor == null ? undefined : this._outAnchor,
                   this._outEcho);
    this._outOpen = false;
    this._outAnchor = null;
    this._outEcho = null;
  }

  _onTermClose(ev) {
    this._outOp(async () => {
      if (!this._blocks || !this._blockView) return;
      await this._flushWrites();
      // 没开过括号（hook 降级 / 事件丢失）：退回原行为（流末尾追加），不乱贴
      if (!this._outOpen) { this._cutBlock(); return; }
      this._closeOutAnchor();
    });
  }

  // ── 块流挂载（Phase 1）──────────────────────────────────────────────
  // 卡片是流式 DOM 块：高度由内容自撑，后面的块自然下推。于是「不遮挡 /
  // 不裁切 / 无大空白」是结构属性，不需要 pad、不需要夹紧、不需要扣流记账。
  // 多卡并发也撞不到一起——insertAfter 按 id 插入，不是抢坐标。
  async _runMountCardBlocks(cardId, kind = "phase") {
    if (!this._blocks || !this._blockView) return null;
    const feed = this._feed;
    if (!feed) return null;
    // 落块走归属链：与 term_open/term_close 互斥，不互相偷走缓冲里的字节
    await this._outOp(async () => {
      if (!this._blocks.get(cardId)) {
        // 把「卡片之前」的内容冻成文本块，卡片才落在它下面（输出/卡片交错）。
        // **归属括号开着时不要切**：那是别的命令正在收输出，切走就把它从
        // 自己的卡下偷走；它的归位由 term_close 落到它自己那张卡后面。
        if (!this._outOpen) this._cutBlock();
        this._blocks.append({
          id: cardId, kind: "card", state: "frozen",
          payload: { cardType: kind },
          keepAlive: kind === "approval",   // 待审批的卡永不被收束/虚拟化删掉
        });
      }
      this._flushPendingFor(cardId);
      this._blockView.sync(this._blocks.list());
    });
    // 幂等：同 id 已在块流里就直接取宿主（重连补挂不许重复落块）
    const blk = this._blocks.get(cardId);
    const slot = {
      id: cardId, marker: null, decoration: null, host: null,
      reserved: 0, need: 0, rows: 0, clamped: false, ro: null,
      reanchorT: null, mounted: false, pendingMount: false,
      pinnedRows: null, forceReapply: false,
      kind, gen: this._taskGen || 0,
      revealed: true, frozen: true, frozenAt: Date.now(),
      padOut: 0, padP: null, blockMode: true,
    };
    const el = this._blockView.nodes.get(cardId);
    const host = el && el._host;
    if (!host) return null;
    slot.host = host;
    slot.mounted = true;
    // 揭示类必须打上：island.css 把 .ablk 的 opacity 钉在 0、动画 paused，
    // 只有 .ot-reveal/.ot-revealed 才放行。漏了就是「正文有内容但看不见」——
    // 分析卡/总结卡整段空白（工具卡不走 .ablk 所以看不出问题）。
    // 只加 ot-reveal，**不要**换成 ot-revealed：ot-revealed 会把动画关掉
    // （animation:none），流式后到的块就再也不逐块揭示＝打字机效果消失。
    // 块布局下宿主不会被重建，不存在「滚动重播」的问题，无需终态锁存。
    try { host.classList.add("ot-reveal"); } catch (e) {}
    if (this._slots) this._slots.set(cardId, slot);
    // 卡必须真在视野里：单一滚动面下块多了会把新卡顶出可视区，而
    // getBoundingClientRect 仍给正常坐标 → 真鼠标点不到（真机 C2 hit=null）
    try {
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "nearest" });
      }
    } catch (e) {}
    return slot;
  }

  async _runMountCard(cardId, kind = "phase") {
    // 块流路径：卡片不占网格行，直接挂流式块（不走 marker/decoration/pad）
    if (this._blocks && this._blockView) {
      const s = await this._runMountCardBlocks(cardId, kind);
      if (s) return s;
    }
    // 欢迎横幅扣留期不挂卡：横幅与其后的重放字节随后才落屏，会写进 marker
    // 行、把预留区的连续空白打断（blankRun 遇非空即停）→ bspan 恒 0，卡被
    // 永久夹紧成只有一条头的细条、并盖住横幅折行（真机图一：横幅右端被截断
    // + ⚠ 系统警告只剩标题）。等横幅落屏重放完再锚定，marker 才钉在真流底。
    // 有界等待：横幅超时自放行（_armWelcomeDeadline），不许把挂载卡死。
    const w0 = Date.now();
    while (this._welcomeHold && !this._dead && Date.now() - w0 < 2500) {
      await this._sleep(20);
    }
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
      // 先扣流、再等**入流**沉降，然后才灌缓冲钉 marker——marker 必须钉在真流底。
      // 旧序是「settle 后才扣流」：连接期的登录横幅/命令输出随后才到、落进 marker
      // 之下，把预留区的连续空白挤断（真机图一：卡钉在 ssh 回显行上，_echoSkip
      // 跳到第 9 行而第 10 行就是登录横幅文本 → 区里只剩 1 行空白，need=7 却
      // 只能垫 1 行，卡被夹紧成只剩卡头的细条）。
      await this._waitInputQuiet(350, 2500);
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
        gen: this._taskGen || 0,   // 任务代数：收束扫尾只清旧代槽
        revealed: false,       // fund/盖帽/冻结阀放行后锁存为 true，不复隐
        frozen: false,         // 卡已定格（collapse/final/fail/审批）：不再参与隐藏
        frozenAt: 0,
        padOut: 0,             // 已发未落账的 pad 空行（防并发双垫，见 _ensurePad）
        padP: null,            // 本格 pad 发送链尾 promise（gap=0 waiter 等落地）
      };
      // 旧钉的迟到 dispose 不得删槽（同 id 顶替/重贴换钉场景）——只认
      // 「仍是本槽当前钉」的那次 dispose
      marker.onDispose(() => {
        if (slot.marker === marker) this._discardSlot(slot);
      });
      // 同 id 防御：旧槽还占着 id 时先整体拆掉（装饰/RO/root）。孤儿槽的
      // decoration 活着就会每帧 onRender → feed.mount(id, el) 与新槽互抢
      // 宿主——React root 每帧在两个 el 间迁移拆建 = 卡片闪烁
      // （真机工具卡跨任务同 id 实锤：TaskRunner 的 index 每任务归 1）
      const stale = this._slots.get(cardId);
      if (stale) {
        this._discardSlot(stale);
      }
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
        this._watchCardResize(slot);
        await new Promise(r => requestAnimationFrame(() => r()));
        this._watchCardResize(slot);   // React 子节点此时已挂，补观察
        this._fitNeed(slot);
        await this._ensurePad(slot);
        // 预留被随后落下的输出挤断（连接期典型）：一发搬到流底再垫一次
        if ((slot.reserved || 0) < Math.max(1, Math.ceil((slot.rows || 1) / 2))) {
          if (await this._relocateToBottom(slot)) {
            this._fitNeed(slot);
            await this._ensurePad(slot);
          }
        }
        this._reanchor(slot);
        // 出生即冻结（Phase 1）：内容完整挂载，此后高度永不再涨——空白尾
        // 复用/零空白藏/冻结阀全按此态判
        slot.frozen = true;
        slot.frozenAt = Date.now();
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
    if (this._feed) this._feed.mount(slot.id, slot.host);
    this._watchCardResize(slot);
    requestAnimationFrame(() => {
      if (!this._dead && slot.host) this._watchCardResize(slot);
    });
    this._fitNeed(slot);
    this._ensurePad(slot)
      .then(() => this._drainHeld())
      .then(() => {
        this._reanchor(slot);
        // 出生即冻结（Phase 1）：内容完整挂载，此后高度永不再涨
        slot.frozen = true;
        slot.frozenAt = Date.now();
      })
      .catch(() => {});
  }

  // RO 同时观察 host 与卡内 React 子节点：xterm 每帧把 host inline 高度写回
  // 登记行数、外盒不涨；子节点外盒随内容涨——折叠/展开等 UI 驱动的高度变化
  // 靠它抓住（流式长高另有事件通路钩子，双保险）。
  _watchCardResize(slot) {
    if (slot.blockMode) return;
    if (!slot.host) return;
    const child = slot.host.firstElementChild;
    // 记忆守卫：host/子节点没换就不重建 RO（onRender 每帧渲染都会路过）
    if (slot.ro && slot._roHost === slot.host && slot._roChild === child) return;
    if (slot.ro) { try { slot.ro.disconnect(); } catch (e) {} }
    slot.ro = new ResizeObserver(() => this._scheduleDrift(slot));
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
        // 打字机揭示类随重贴迁移：已 reveal 的卡新 host 补加（不补＝动画停在
        // paused 初始态 opacity:0，卡隐形）。揭示完走终态类（动画不重播）
        if (slot.revealed) {
          el.classList.add(slot.revealDone ? "ot-revealed" : "ot-reveal");
        }
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

  // 隐藏释放沿：fund（reserved 追上 rows）/盖帽/冻结阀。打字机揭示类
  // （ot-reveal）此刻落上，块动画从 paused 起跑；_styleHost 立即解除
  // visibility，不等下一帧 onRender。
  _revealSlot(slot) {
    if (!slot || slot.revealed) return;
    slot.revealed = true;
    if (slot.host && slot.host.classList) slot.host.classList.add("ot-reveal");
    this._styleHost(slot);
    // 徽标同步（任务全程常显不变量）：揭示不退徽标，只同步三态文案
    this._refreshThink();
    // 揭示完成后锁存终态（ot-revealed）：动画只跑一次，滚动/重贴不得重播
    // ——真机「滑动时总结卡刷新加载一次」＝打字机动画随 host 迁移重跑
    setTimeout(() => {
      slot.revealDone = true;
      const h = slot.host;
      if (h && h.classList && typeof h.classList.remove === "function") {
        h.classList.remove("ot-reveal");
        h.classList.add("ot-revealed");
      }
    }, 1200);   // 250ms 动画 + 逐块延迟（块多时约 1s）留足余量
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
      const inView = bot >= ydisp && top < ydisp + this.term.rows;
      const wantDisp = inView ? "block" : "none";
if (inView) {
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
    // 块流槽：位置与高度由流式布局决定（CSS 高度自撑），不许用 marker/top/
    // clamp 那套去钉——那正是「卡片占网格行」的几何，会把块拽回浮层。
    if (slot.blockMode) return;
    try {
      el.dataset.mline = slot.marker ? slot.marker.line : -1;
      el.dataset.bspan = this._blankSpan(slot);
      el.dataset.rows = slot.rows;
      el.dataset.pinned = slot.pinnedRows == null ? -1 : slot.pinnedRows;
      el.dataset.need = slot.need;
    } catch (e) {}
    const lh = this._lineHeight();
    // 钉死高每帧兜底到交互底线：pinnedRows 是 clamp 那一刻记的，按钮在窗口
    // 变窄/系统缩放后会换行长高、或 clamp 时按钮还没布局完量矮了一行——
    // 按旧值钉死就把按钮行裁出盒 = 真鼠标点不到 = 决策死锁（红线⑨）。只在
    // 武装时抬一次底线不够，必须每次 _styleHost 都取当前 _floorRows。
    const floor = this._floorRows(slot);
    const rows = Math.max(1, floor, (heightRows != null ? heightRows
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

  // 审批交互底线（行数）：夹紧/钉死/盖帽高度都不许低过它——按钮不可点＝
  // 决策死锁（红线⑨）。底线量到「按钮簇底」为准（夹紧只裁底，裁掉的不得
  // 是按钮簇）：
  //   命令卡（Phase 2 二合一，kind='phase'）：按钮簇 .cmdacts 在**卡头右侧**
  //    （还原原版布局），底线=卡头高——夹紧裁底只丢状态行，按钮恒可点。
  //   救援卡（kind='approval'）：按钮在 .aphead（首行），底线是首行高。
  // 空白 run 不够时宁可短暂压住下方提示符行（pad 落地解钉即让开），功能
  // 优先于观感硬线；无交互行的卡恒 0（硬线 coveredTextRows 不变）。
  // 只认**真有按钮**的卡：旧实现把任何 .aphead 都当交互行，AlertCard/
  // ToolCard 的卡头恰是它们唯一的定高行，于是夹紧恒钉在卡头高、正文永远
  // 被裁出盒（真机图一「⚠ 系统警告」只剩标题、错误正文整段不可见）。
  _floorRows(slot) {
    if (slot.blockMode) return 0;
    if (!this._hostAlive(slot.host)) return 0;
    try {
      const lh = this._lineHeight();
      const acts = slot.host.querySelector(".cmdacts");
      if (acts && typeof acts.getBoundingClientRect === "function" &&
          typeof slot.host.getBoundingClientRect === "function") {
        const hostTop = slot.host.getBoundingClientRect().top;
        const bottom = acts.getBoundingClientRect().bottom;
        const rows = Math.ceil((bottom - hostTop) / lh);
        return rows > 0 ? rows : 0;
      }
      const head = slot.host.querySelector(".aphead");
      if (!head || typeof head.getBoundingClientRect !== "function") return 0;
      // 卡头里没有按钮 = 不是交互行（警告/工具卡头只有标签与徽标）
      if (!head.querySelector("button")) return 0;
      const h = head.getBoundingClientRect().height;
      return h > 0 ? Math.ceil(h / lh) : 0;
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
    if (slot.blockMode) return;
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
    slot.rows = n;
    // 出生即定型（Phase 4）：内容完整才挂载、挂后高度钉死，不存在「流式长高」
    // ——need 就是量高 + 1 保险行。旧 +5 长高裕量只服务流式时代（空白行不可
    // 回吐，落地即卡间大缝隙根因，真机 2026-09-30），已随长高机械一并拆除。
    slot.need = n + 1;
    // 编辑框浮层开启期宿主须 overflow visible（浮层伸出盒外），量高/夹紧不得
    // 把它钉回 hidden——否则下拉编辑框被裁（真机「修改后无法编辑」成因之一）
    if (!slot.host.querySelector(".edopen")) slot.host.style.overflow = "hidden";
  }

  // 一发搬移：预留区被随后落下的输出挤断时，把**本卡自己**的锚搬到流底。
  //
  // 连接期的典型时序：卡在横幅后、命令集执行前挂载，marker 钉在提示符行；
  // pad 要过 _runner_lock（命令集的注入正持着），往返期间命令回显 + 登录输出
  // 已经落进 marker 行之下，把预留区的连续空白挤断——_echoSkip 跳到第一处
  // 空白，区里只剩 1 行，need=7 却只能垫 1 行，卡被夹紧成只剩卡头的细条
  // （真机图一「⚠ 系统警告只剩标题」）。pad 只能追加流底，垫不进被挤断的区。
  //
  // 搬移只动自己的锚：换 marker 后再 dispose 旧钉（onDispose 的
  // `slot.marker === marker` 守卫认的是当前钉，故不会误触发 _discardSlot），
  // 不碰别的卡、不偷别人的预留——与已拆除的 _stealBlankBelow 不同。
  // 只在「预留不足一半」时一发：搬移换贴纸、React root 迁移，不宜反复。
  async _relocateToBottom(slot) {
    if (this._dead || !slot.marker || !slot.host) return false;
    try {
      const buf = this.term.buffer.active;
      const cursorAbs = buf.baseY + buf.cursorY;
      if (cursorAbs <= slot.marker.line) return false;   // 没有下方空间
      // 流底往下要真有成片空白才值得搬（越界行视为空白，故上限放开）
      const free = blankRun(buf, cursorAbs + 1, cursorAbs + 1 + (slot.rows || 1) + 2);
      if (free < (slot.rows || 1)) return false;
      const old = slot.marker;
      const m = this.term.registerMarker(0);
      if (!m) return false;
      slot.marker = m;
      m.onDispose(() => { if (slot.marker === m) this._discardSlot(slot); });
      try { old.dispose(); } catch (e) {}
      if (slot.decoration) { try { slot.decoration.dispose(); } catch (e) {} }
      slot.decoration = null;
      slot.host = null;
      slot.clamped = false;
      slot.pinnedRows = null;
      slot.reserved = 0;
      slot.padOut = 0;
      this._applyDecoration(slot, 2);
      const t0 = Date.now();
      while (!slot.host && Date.now() - t0 < 500) await this._sleep(10);
      if (slot.host && this._feed && slot.mounted) this._feed.mount(slot.id, slot.host);
      // 新 host：RO 观察目标要跟着迁，否则后续长高不再感知
      if (slot.host) this._watchCardResize(slot);
      return !!slot.host;
    } catch (e) {
      return false;
    }
  }

  // 重贴/decoration 高度策略：流底卡高度由内容自撑（host inline height=auto），
  // 长高只补 pad 不重贴（重贴换新元素=React 重挂载，流式期间会闪）；仅三种情况
  // 重贴：解除夹紧、上游夹紧钉高、resize 刷宽度（forceReapply）。
  _reanchor(slot) {
    if (slot.blockMode) return;
    if (this._dead || !slot.marker) return;
    this._fitNeed(slot);
    slot.reserved = this._blankSpan(slot);   // 落账只认缓冲，每步重数
    // 缺行就截断（宁矮不盖）：垫得进去的由 _ensurePad 补上后自动解除，
    // 垫不进去的（盖帽：下方已有输出/别的卡）就此钉死到已垫高度。
    // 钉死高度 = 预留空白 run 的行数（审批卡例外：不低于按钮行 _floorRows，
    // 宁短暂压提示符行也不许决策死锁）：卡体顶行就是 run 首行（视觉 top 含
    // 回显偏移，见 _fixHostVisibility），run 有多长盒就多高，盒底恰好压在
    // run 末行上，不会越过它盖住下面的活提示符/输出。
    const short = slot.reserved < slot.rows;
    if (short) {
      // 钉死高度不低于交互底线（_floorRows）：审批卡被钉到按钮行之下＝
      // 按钮不可点＝决策死锁（红线⑨）。非审批卡 floorRows 恒 0，行为不变。
      const rows = Math.max(1, slot.reserved, this._floorRows(slot));
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
        el.textContent = _t("输入自然语言任务，AI 帮你执行；? 前缀强制 AI，! 强制命令");
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
      // 定格接管结账＝漂移批量窗被取消（只清定时器，无长高扣流记账）
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

  // 高度漂移处理（Phase 4，长高机械已拆除）：卡出生即定型，RO 只报
  // 「内容高 ≠ 预留」的漂移（典型来源：resize 折行变化、字体加载）。
  // 处置只有两条路，永不长高：
  //   ① 立即夹紧钉死到已垫高度（防 auto 盒越过预留区盖住下方活文本）；
  //   ② 流底卡给一次性重垫机会（pad 只追加流底；_ensurePad 自带 card-pad
  //      扣流窗，与旧「长高扣流」记账无关），垫上自动解钉、垫不上维持截断。
  // 上游卡（非流底）夹紧即终态——scrollback 中间物理插不进新行。
  // 150ms 节流：夹紧自身也触发 RO，防抖会饿死、连发会撕贴纸。
  _scheduleDrift(slot) {
    if (this._dead) return;
    this._fitNeed(slot);
    // 感知即钉盒（只改样式不动贴纸）：漂移窗里 auto 盒会越过空白 run 盖住
    // 下方活提示符行（硬线 coveredTextRows）
    if (slot.revealed && slot.rows > slot.reserved && slot.pinnedRows == null) {
      this._clampCard(slot);
      // 审批卡钉死高度不低过按钮行（_floorRows）：细条态按钮不可点=死锁
      slot.pinnedRows = Math.max(1, slot.reserved, this._floorRows(slot));
      this._styleHost(slot);
    }
    if (slot.reanchorT) return;
    slot.reanchorT = setTimeout(async () => {
      slot.reanchorT = null;
      if (this._dead || !slot.marker) return;
      if (this._capped(slot) || this._padFused) { this._reanchor(slot); return; }
      // 一次性重垫只给流底卡：pad 只追加在流底，上游垫不进（盖帽即终态）
      const bottom = [...this._slots.values()].filter(o => o.marker)
        .sort((a, b) => a.marker.line - b.marker.line).pop();
      if (bottom !== slot) { this._reanchor(slot); return; }
      this._holdBytes("card-drift");
      try {
        await this._ensurePad(slot);
        await this._drainHeld();
        this._reanchor(slot);
      } finally {
        this._releaseBytes();
      }
    }, 150);
  }

  // 夹紧：卡 DOM 截断，不给卡内滚动条——宁可矮，不许盖网格
  _clampCard(slot) {
    if (slot.blockMode) return;
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

  // （_stealBlankBelow/_unrevealedBelow 移锚回收已随 Phase 4 拆除：盖帽欠账
  // 回收靠出生事务的「锚定前 settle 上游 + 空白尾复用」，中途不再挪别人的锚）

  // 补差：先数后打，只补真缺口；落账只认缓冲（应答只是唤醒）。
  // 扣流临界区内完成，输出插不进占位区。
  // padOut = 已发未落账的空行数：并发/连发的 _ensurePad（挂载 vs 150ms 批量 vs
  // 自愈）都按「旧缓冲」数缺口，各自发一轮 = 双倍空行落地 = 卡下永久大白空
  // （真机审批卡下 9 行空白根因：pad 往返 > 150ms 批量窗时两路并发）。在途
  // 计入后第二路看到缺口已填即 gap=0；整链收尾（所有排队发送 ack 完）落账重置。
  async _ensurePad(slot) {
    if (slot.blockMode) return;
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
      // padOut **入队当刻**就记账（不是任务跑起来才记）：并发/连发的
      // _ensurePad（挂载 vs 漂移 vs 结账 vs 自愈）各自「drain 后算 gap」，
      // 若都等进队执行才 +padOut，两路都在 padOut=0 时算出同一缺口、各发
      // 一轮 = 双倍空行落地 = 卡下永久大白空（评审 MEDIUM；真机审批卡下
      // 9 行空白同族）。入队即记，后到者 gap 归 0 / 只补差额。
      slot.padOut = (slot.padOut || 0) + gap;
      this._padQ = this._padQ.then(async () => {
        if (this._dead || !slot.marker) {
          // 发送被取消（会话死/卡散场）：在途额就地退回，不然 padOut 永久
          // 虚高、真缺口再也垫不进
          slot.padOut = Math.max(0, (slot.padOut || 0) - gap);
          return;
        }
        this._padSlot = slot;
        slot.ackDeferred = false;   // _onPadded 按 ack 事件的 deferred 置位
        this._padSentAt = Date.now();
        const blankBefore = this._blankSpan(slot);
        // mirror：可信的半行镜像交给 worker 收纳/复原——pad 注入不再吞掉
        // 用户正在敲的输入（dirty 时省略，worker 走旧的丢弃路径）
        otdbg("pad-send", "gap=" + gap, "need=" + slot.need, "blank=" + blankBefore);
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
    otdbg("pad-ack", ev && ev.deferred ? "deferred" : "ok",
          "waited=" + (this._padSentAt ? (Date.now() - this._padSentAt) : "?"));
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
    this.setStatus(this.status, _t("占位补差已熔断，卡片按已垫高度截断"));
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
    this.setStatus(this.status, _t("卡片渲染失败，已降级为纯文本"));
  }

  _writePlain(text) {
    const s = String(text || "").replace(/\r/g, "");
    this._wp(s.endsWith("\n") ? s : s + "\n");
  }

  _discardSlot(slot) {
    if (slot.reanchorT) { clearTimeout(slot.reanchorT); slot.reanchorT = null; }
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
    // 块流槽：整块移除（「完整或消失」的消失侧）。force：中断/收束是显式终态，
    // 越过 keepAlive 闸门（待审批卡只有在这里才允许被清）
    if (slot.blockMode && this._blocks && this._blockView) {
      this._blocks.remove(slot.id, {force: true});
      this._blockView.sync(this._blocks.list());
    }
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
    if (this._blocks && this._blockView) {
      this._blocks.clear();
      this._blockView.sync(this._blocks.list());
    }
    if (this._feed) this._feed.handle({kind: "clear"});
    this._approvalOpen = false;
    this._approvalKey = null;
    this._approvalResolved = false;
    this._toolCards.clear();
    if (this._cmdCardQ) this._cmdCardQ.clear();
    // 收束时括号还开着就先归位再清账——顺序反了会把刚存下的归属一并抹掉。
    // _pendingTextByCard 刻意不清：它的卡可能还挂在队列里没落位。
    if (this._outOpen) this._closeOutAnchor();
    this._outEcho = null;
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
      this._scheduleDrift(slot);
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
        // 盖帽卡不再移锚回收（Phase 4）：夹紧是终态（宁矮不盖），仍走
        // _reanchor 只为「预留区事后变宽」的解钉（reserved ≥ rows 即长回）
        .then(() => (capped ? Promise.resolve() : this._ensurePad(slot)))
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
    this._taskClosed = false;   // 新任务起跑：收束门卫复位（迟到宣告照常挂）
    this._taskGen = (this._taskGen || 0) + 1;   // 任务代数：收束扫尾按代过滤
    // 同步给 store：store._gen 递增 + 清跨任务残留（_pendingArms/_lastSummaryMd）。
    // 漏发＝store._gen 恒 0 → sweep 代数过滤失效（真机 2026-10-17：新任务
    // 审批卡被上代收束当未完毕摘掉 → 按钮永不出生转模态）
    this._ensureFeed().then(f => f && f.handle({kind: "task_start"}))
      // Enter 后立即弹「AI 思考中」占位卡（id 与后续 ai_result 同一张）
      .then(f => {
        if (!f) return null;
        const cid = ++this._cardSeq;
        f.handle({kind: "analysis_boot", id: cid});
        return this._mountCard(cid, "phase");
      });
    this._lastSummaryMd = null;
    // Phase 3 徽标进度：progress 心跳（1s）累计，任务起跑清零
    this._progress = {chars: 0, tokensIn: 0, tokensOut: 0};
    this._taskStartedAt = Date.now();
    this._setStopVisible(true);
    this._startTimer();
    // 思考徽标即刻接班（_refreshThink 按 _taskActive 解隐）：纯推理空隙期
    // 卡未挂前不得假死（旧 _openPhaseCard 的解隐职责移到这里）
    this._refreshThink();
    // Phase 1「定格一发入魂」：不预开流式分析卡——分析段由 ai_result 成卡
  }

  // 任务收束公共账（final/task_end/task_fail 幂等共用）：状态栏/计时器/审批态
  _taskTeardown() {
    this._taskActive = false;
    this._taskClosed = true;   // 收束：迟到的工具宣告不再挂卡
    this._approvalOpen = false;   // 任务收束：未决审批窗（若有）一并释放
    this._approvalCmd = null;
    this._approvalKey = null;
    this._approvalResolved = false;
    this._toolCards.clear();
    this._runningTool = "";
    this._endTimer();
    this._setStopVisible(false);
    this._refreshThink();
  }

  // 一次性分析段（Phase 1）：内容完整才成卡——handle 先入 store（量高时内容
  // 已完整），再挂出生即完整的卡，挂载后高度永不再涨。空段不发不成卡。
  _onAiResult(ev) {
    const text = (ev && ev.text) || "";
    const reason = (ev && ev.think) || "";
    if (!text && !reason) return;
    const cardId = ++this._cardSeq;
    this._cardsText.set(cardId, reason ? reason + "\n" + text : text);
    // 链在在途开卡之后（工具卡/上一段卡可能还在挂载临界区内）：挂载全程
    // 扣流，两段并发会把 marker 钉错
    this._cardReady = this._cardReady
      .then(() => this._ensureFeed())
      .then(f => f && f.handle({
        kind: "ai_result", id: cardId, text, reason,
        failed: !!(ev && ev.failed),
      }))
      .then(() => this._mountCard(cardId, "phase"))
      .then(slot => { if (slot) this._followBottom(); });
  }

  // 红色警告卡：配置错误（协议二选一冲突/都缺）与系统异常（模型/工具超时等）。
  // kind='phase' 复用宁藏不盖/夹紧兜底；出生即完整（done 恒真）不进收束扫尾。
  _onAlert(ev) {
    const text = (ev && ev.text) || "";
    if (!text) return;
    // 状态栏兜底：卡被夹紧（预留不足，宁可矮不许盖）时正文可能整段裁出盒，
    // 但系统警告必须始终读得到——状态栏常驻一行，且不占网格、不与卡争预留。
    this.setStatus(this.status, text);
    const cardId = ++this._cardSeq;
    this._cardsText.set(cardId, text);
    this._cardReady = this._cardReady
      .then(() => this._ensureFeed())
      .then(f => f && f.handle({kind: "alert", id: cardId, text}))
      .then(() => this._mountCard(cardId, "phase"))
      .then(slot => { if (slot) this._followBottom(); });
  }
  // start 在流底挂 tool 卡（kind 同 phase——宁藏不盖/夹紧兜底全复用），end 经
  // store 同 id 置状态徽标（卡高不变，零 pad 往返）。工具卡不是流式分析卡，
  // 之后的模型输出由 _onAiResult 另开新卡。
  // 工具卡串行挂载队列：并行 tool_call 一次宣告 N 张，逐张落地。
  // pri=true（要审批）插队——审批卡必须立刻可点，等前一张收束就是决策死锁。
  _pumpToolMounts(pri) {
    // 惰性建：测试用 Object.create(原型) 不跑构造器，字段不一定在
    if (!this._toolMountQ) this._toolMountQ = [];
    if (this._toolMounting) return;
    let item = null;
    if (pri) {
      const i = this._toolMountQ.findIndex(x => x.pri);
      if (i >= 0) item = this._toolMountQ.splice(i, 1)[0];
    }
    if (!item) item = this._toolMountQ.shift();
    if (!item) return;
    this._toolMounting = true;
    const { cardId, ev } = item;
    this._cardReady = this._cardReady
      .then(() => this._ensureFeed())
      .then(f => f && f.handle({
        kind: "tool_start", id: cardId, name: ev.name || "", args: ev.args || "",
        command: ev.command || "", needs_approval: !!ev.needs_approval,
        reasons: ev.reasons || "", risk: ev.risk || "",
      }))
      .then(() => this._mountCard(cardId, "phase"))
      .then(slot => { if (slot) this._followBottom(); })
      .catch(() => {})
      .then(() => {
        this._toolMounting = false;
        if (this._toolMountQ.length) this._pumpToolMounts();
      });
  }

  // 审批帧到时该卡还在队列里 → 插队立即挂（按钮出不来就是决策死锁）
  _flushToolMountFor(cardId) {
    try {
      if (!this._toolMountQ) return;
      const i = this._toolMountQ.findIndex(x => x.cardId === cardId);
      if (i >= 0) {
        this._toolMountQ[i].pri = true;
        this._toolMountQ[i].ev.needs_approval = true;
        this._pumpToolMounts(true);
      }
    } catch (e) {}
  }

  _onAiTool(ev) {
    // id 统一：ev.id 是后端数字 tool_card_seq，与前端 _cardSeq 是两个序列，
    // 映射表解耦（审批消息的 card_id 也从这里反查命令卡）。
    if (ev.phase === "start") {
      // 收束后迟到的工具宣告不再挂卡（事件队列尾残迹）——半截卡只减不增
      if (this._taskClosed) return;
      const cardId = ++this._cardSeq;
      this._toolCards.set(ev.id, cardId);
      // 输出归属索引：execute 的 term_open 只带命令串，据此反查它该贴哪张卡。
      // 同名命令同轮出现多次时按宣告序排队取（抢锁序会变，队列不会乱）。
      if (ev.name === "execute" && (ev.command || ev.args)) {
        if (!this._cmdCardQ) this._cmdCardQ = new Map();
        const k = String(ev.command || ev.args);
        const q = this._cmdCardQ.get(k) || [];
        q.push(cardId);
        this._cmdCardQ.set(k, q);
      }
      // 徽标同步说人话：模型在跑哪条命令。旧实现全程「AI 正在思考」，
      // 长命令/多轮排查时用户看到的就是假死（真机 bug2 的观感根因之一）。
      this._runningTool = (ev.name === "execute"
        ? String(ev.command || ev.args || "") : String(ev.name || "")).trim();
      this._refreshThink();
      // handle 先于 mount（对齐 _onAiResult 的出生事务）：量高时内容已完整，
      // 命令卡出生即定型。旧序 mount→handle 有两个真机后果：①量到空卡再靠
      // 漂移补垫（夹紧竞态窗）；②审批帧可以抢在 tool_start 入店前到 →
      // command_card_waiting 找不到卡 → 按钮永不出生转模态（冒烟 2026-10-16）
      // 串行弹出（真机反馈）：并行 tool_call 会一次发齐全部 tool_start，旧序
      // 一次挂满一屏卡。改成入队逐张挂——上一张 tool_end 才弹下一张，观感是
      // 「一张卡 + 它的输出」依次出现。要审批的卡插队立即挂，否则按钮出不来。
      if (!this._toolMountQ) this._toolMountQ = [];
      this._toolMountQ.push({ cardId, ev });
      this._pumpToolMounts();
    } else {
      this._runningTool = "";
      this._refreshThink();
      const cardId = this._toolCards.get(ev.id);
      // 上一张收束了：弹队列里的下一张（串行观感）
      this._pumpToolMounts();
      this._cardReady = this._cardReady.then(() => this._ensureFeed())
        .then(f => f && f.handle({kind: "tool_end", id: cardId, failed: !!ev.failed}));
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
  // 出生垫行排水（Phase 4）：先等在途挂载链/挂载串行队列落定——命令回显
  // 必须落在出生 pad 空行之后，否则插进预留区＝永久盖帽。结账范围排水后
  // 重扫（含刚出生的卡）。
  _onBoundary() {
    const ack = () => {
      try { this.sendJson({type: "boundary_settled"}); } catch (e) {}
    };
    if (this._padFused) { ack(); return; }
    this._ensureFeed()
      .then(() => this._cardReady || Promise.resolve())
      .then(() => this._mountQ || Promise.resolve())
      .then(() => {
        const slots = [];
        for (const s of this._slots.values()) if (s.marker) slots.push(s);
        if (!slots.length) return null;
        return Promise.all(slots.map(s => this._settleCard(s)));
      })
      .catch(() => {})
      .then(ack);
  }

  // ai_collapse 已随流式契约退役（Phase 1）：事件仍留在线上（CLI 依赖），
  // Web 侧 dispatch 两处 case 直接 no-op，无折叠/裁尾/定格语义。

  _onAiCard(markdown) {
    // ai_card 与 final 同文连发时本调用会去重早退（_mountSummary/_lastSummaryMd）
    // ——扫尾同样等挂载完再查完整性
    this._endSweepSoon(this._mountSummary(markdown || ""));
  }

  _onFinal(text) {
    this._taskTeardown();
    // 总结卡一次性挂载（出生即完整，无换装/裁尾）
    const mp = this._mountSummary(text || "");
    this._scheduleHeal();
    // 收束扫尾等总结卡挂完：完整卡显示、垫不满的保留夹紧（不丢弃不留洞）
    this._endSweepSoon(mp);
  }

  // task_end（worker 任务流末端必发）：final 已收束时本调用幂等复用 teardown，
  // 否则（异常路径漏 final）兜底收束 + 扫尾
  _onTaskEnd() {
    this._taskTeardown();
    this._scheduleHeal();
    this._endSweepSoon();
  }

  // progress 心跳（后端 1s 节流）：徽标进度计数刷新——顺带推动「思考 Ns」
  // 秒数走字（_refreshThink 自身无定时器，靠心跳/事件唤醒）
  _onProgress(ev) {
    if (!ev) return;
    this._progress = {
      chars: ev.chars || 0,
      tokensIn: ev.tokens_in || 0,
      tokensOut: ev.tokens_out || 0,
    };
    this._refreshThink();
  }

  // 总结挂载：一次性挂出生即完整的总结卡（Phase 1 无换装/裁尾）。同文去重
  // （ai_card 与 final 双发同一份 markdown）；handle 先于 mount——量高时内容
  // 已完整。
  async _mountSummary(md) {
    if (!md || md === this._lastSummaryMd) return;
    this._lastSummaryMd = md;
    const cardId = ++this._cardSeq;
    this._cardsText.set(cardId, md);
    await this._ensureFeed()
      .then(f => f && f.handle({kind: "ai_card", md, id: cardId}));
    await this._mountCard(cardId, "summary");
  }

  // 任务中止（denied/limit/error/interrupt）：island 定格失败态，文案只进
  // 状态栏（终端网格只留原生字节，不写系统提示——单管线约束）。
  // interrupt（Ctrl+C/⏹）例外：未完毕的内容卡整卡移除——store
  // task_fail 撤内容、onDrop 丢槽（中断零残留语义），活流卡不做失败定格。
  // 任何收束都过 _endSweepSoon：垫不满的卡保留夹紧（见 _endSweep 注释）。
  _onTaskFail(kind, text) {
    this._taskTeardown();
    this._ensureFeed().then(f => f && f.handle({kind: "task_fail", reason: kind}));
    this.setStatus(kind === "denied" ? "error" : this.status,
                   text || (kind === "denied" ? _t("✗ 已拒绝") : _t("任务已中止")));
    this._scheduleHeal();
    this._endSweepSoon();
  }

  // 收束扫尾编排：串行防重入（fail 紧跟 final 两连发不交错），等在途挂载链、
  // 挂载串行队列与 extra（总结挂载）全部落定再查完整性
  _endSweepSoon(extra) {
    const gen = this._taskGen || 0;   // 收束当刻代数：只清本代及以前的卡/槽
    const run = async () => {
      try {
        await Promise.all([
          this._cardReady || Promise.resolve(),
          this._mountQ || Promise.resolve(),
          extra || Promise.resolve(),
        ]);
        await this._endSweep(gen);
      } catch (e) {}
    };
    this._sweepQ = (this._sweepQ || Promise.resolve()).then(run, run);
    return this._sweepQ;
  }

  // 收束不变量（Phase 4，改「整卡丢弃」为「保留夹紧」）：
  // ① store 扫迟到补挂的未完毕内容卡（sweep——中断/异常残留，内容级）；
  // ② 逐槽结账一次给「垫得进去」的卡补齐机会；
  // ③ 仍不完整的卡**保留夹紧**（钉死到已垫高度 + 揭示放出）——出生即完整的
  //    卡天然过检；整卡丢弃拆了贴纸但 pad 空行回收不了＝原位留洞（真机图二）。
  //    宁矮不盖：夹紧态盒底不越过预留区。
  // 仅「从未挂载成功」的槽（pendingMount：没有 host，也没写过 pad 行）走
  // _fallbackPlain 纯文本降级后拆除——它没占预留行，拆了也不留洞，内容不丢。
  // 审批/救援卡豁免：按钮行底线夹紧是功能（可点性优先）。
  async _endSweep(gen) {
    if (this._dead) return;
    const sweepGen = gen != null ? gen : (this._taskGen || 0);
    const feed = await this._ensureFeed();
    if (feed) feed.handle({kind: "sweep", gen: sweepGen});
    // React 把定格内容渲一帧再量高（_settleCard 自带 host 补挂），否则量到半截
    await new Promise(r => requestAnimationFrame(() => r()));
    const settle = [...this._slots.values()]
      .filter(s => s.marker && s.kind !== "approval");
    await Promise.all(settle.map(s => this._settleCard(s).catch(() => {})));
    await new Promise(r => requestAnimationFrame(() => r()));
    const drop = [];
    for (const slot of [...this._slots.values()]) {
      if (!slot.marker || slot.kind === "approval") continue;
      if ((slot.gen || 0) > sweepGen) continue;   // 新任务在挂槽：不归本次收束管
      if (!slot.mounted || slot.pendingMount) {
        // 挂载失败降级：内容以纯文本写进网格，不留隐形卡、不丢内容
        this._fallbackPlain(slot);
        drop.push(slot.id);
        this._dropSlot(slot);
        continue;
      }
      const full = slot.pinnedRows == null && !slot.clamped &&
                   (slot.reserved || 0) >= (slot.rows || 1);
      if (!full) {
        // 保留夹紧：钉死到已垫高度（审批卡不低于按钮行），不丢弃
        this._clampCard(slot);
        const rows = Math.max(1, slot.reserved || 1, this._floorRows(slot));
        if (slot.pinnedRows !== rows) {
          slot.pinnedRows = rows;
          this._applyDecoration(slot, rows);
        }
      }
      if (!slot.revealed) this._revealSlot(slot);
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

  // 审批走 store 更新：命令卡（tool_start 已挂载）就地武装按钮，不再单独
  // 挂审批卡/垫行（二合一：一卡全程）。island 加载失败兜底 modal 弹窗收
  // 决策，不让审批死锁。
  showApproval(command, reasons, host, risk, id) {
    // 补发去重（WS 重连/刷新重挂时 attach 会再投一次未决审批）：去重键
    // (卡 id, 命令串)——同串并行命令是两张卡两条审批，旧全局串去重会把
    // 第二条当重发挡掉（第二张卡永远等不到按钮＝死锁）。
    const key = (id == null ? "" : id) + "\u0000" + (command || "");
    if (this._approvalOpen && this._approvalKey === key) return;
    // 未决态必须同步记账，不能等卡片层落定：_ensureFeed() 一卡（脚本加载
    // 慢、promise 不落），徽标就停在「AI 正在思考」、审批 UI 一张不出，而
    // core 侧在干等决策——真机看就是任务卡死（bug2 截图）。球此刻已在用户侧。
    this._approvalOpen = true;
    this._approvalCmd = command;
    this._approvalKey = key;
    this._approvalResolved = false;   // 新一令：上一令的已决策态不带到本令
    this._refreshThink();
    this._ensureFeed().then(async feed => {
      // 慢到的卡片层：决策已下 / 命令已换就别再武装旧卡
      if (this._dead || this._approvalKey !== key) return;
      // 命令卡 id 映射缺失（claim_seq 未认领 / 卡已被中断丢）→ 模态兜底
      const cardId = (id != null) ? this._toolCards.get(id) : null;
      if (!feed || cardId == null) {
        return this._approvalModal(command, reasons, key);
      }
      // 该卡可能还在串行队列里没落地：插队立即挂，否则按钮出不来＝决策死锁
      this._flushToolMountFor(cardId);
      // 就地武装命令卡按钮（不 mount 不垫行：命令卡出生即完整已结账）。
      // store 返回 false＝卡已不在/非命令卡/无操作行（needs_approval 假的
      // 卡永不长操作行，谓词不可能中途反转）→ 模态兜底不长高。
      const armed = feed.handle({kind: "command_card_waiting", id: cardId,
                                command, reasons, risk});
      if (!armed) {
        return this._approvalModal(command, reasons, key);
      }
      // 武装后重钉：按钮行刚出生（React 渲染后 floorRows 才有值），卡可能
      // 已按底线=0 钉死 1 行 → 按钮被裁出盒＝真机「执行按钮点不动」根因。
      // 重算底线把钉死抬到按钮行底（宁短暂压提示符，不许按钮不可点=死锁）
      await this._sleep(30);
      const armedSlot = this._slots.get(cardId);
      if (armedSlot && armedSlot.marker && this._hostAlive(armedSlot.host)) {
        const floor = this._floorRows(armedSlot);
        if (floor > 0 && (armedSlot.pinnedRows == null || armedSlot.pinnedRows < floor)) {
          if (armedSlot.pinnedRows == null) this._clampCard(armedSlot);
          armedSlot.pinnedRows = Math.max(1, floor);
        }
        this._styleHost(armedSlot);
      }
      // 可点性看门狗（持续型）：直接查 DOM——「执行」按钮真实存在且落在
      // 卡盒可视区内才算用户点得到。旧版只采样一次（mounted 且未钉死）就
      // 返回：resize 折行/晚到 pad 事后把按钮行夹出屏时无人兜底（评审 HIGH）。
      // 现在审批存续期间持续巡检：先给 grace 等出生落定，此后任一时刻失
      // 可点性就 disarm 转模态——审批永远有可点的入口（红线⑨）。
      // 判定不看 pinnedRows：钉死但按钮仍在盒内（_floorRows 保底）是可点的。
      let t0 = Date.now();   // let：挂载未落定期重置（不烧宽限）
      const tStart = Date.now();   // 绝对兜底：挂载永不到也得转模态
      let slot = null;
      let everClickable = false;
      let misses = 0;
      const buttonClickable = () => {
        if (!slot || !slot.mounted || !this._hostAlive(slot.host)) return false;
        try {
          const b = slot.host.querySelector(".cmdacts button.primary");
          if (!b || typeof b.getBoundingClientRect !== "function") return false;
          const box = slot.host.getBoundingClientRect();
          const r = b.getBoundingClientRect();
          return r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
        } catch (e) { return false; }
      };
      // 失可点性 → disarm 转模态。grace 期内用户可能已按 Ctrl+Enter 放行：
      // 再转模态就是给已决策的命令再开一扇「批准」，点下去第二发决策会落到
      // core 下一次 ask_approval 头上＝幽灵批准（真机 B1）。守卫三件套：
      // _approvalResolved / key 校验 / 已有模态不叠。
      const toModal = () => {
        if (this._dead || this._approvalResolved ||
            this._approvalKey !== key) return;
        try {
          if (document.querySelector &&
              document.querySelector("#modal-root .modal")) return;
        } catch (e) {}
        // disarm 不删卡：工具记录留屏，快捷键路径从此无 armed 卡可双决策
        feed.handle({kind: "approval_void", id: cardId});
        this._approvalModal(command, reasons, key);
      };
      while (!this._dead && !this._approvalResolved &&
             this._approvalKey === key) {
        slot = this._slots.get(cardId) || slot;
        if (buttonClickable()) {
          everClickable = true;
          misses = 0;
        } else if (everClickable) {
          // 连续失点才算真失点（React 重渲染/编辑框开合的单帧空隙不得误报）
          misses++;
          if (misses < 5) { await this._sleep(200); continue; }
          toModal();
          return;
        } else if (!slot || slot.pendingMount) {
          // 挂载未落定（槽未注册/xterm 空闲不出 host）：宽限等挂载，不烧钟；
          // 15s 绝对兜底——挂载永不到也得给用户可点入口
          t0 = Date.now();
          if (Date.now() - tStart > 15000) { toModal(); return; }
        } else if (Date.now() - t0 >= this._approvalGraceMs) {
          toModal();
          return;
        }
        await this._sleep(200);
      }
    }).catch(e => {
      // 卡片层中途抛错也不能让审批静默死掉——core 在等决策，任务会假死。
      // 转模态兜底，决策永远有可点入口；已有模态就不叠第二张。
      console.error(_t("[ot] 审批武装失败，转模态兜底:"), e);
      if (this._dead || this._approvalResolved ||
          this._approvalKey !== key) return;
      try {
        if (document.querySelector &&
            document.querySelector("#modal-root .modal")) return;
      } catch (e) {}
      this._approvalModal(command, reasons, key);
    });
  }

  // 审批模态兜底（feed 缺失 / 武装失败 / 看门狗超时共用）：决策直发 WS、不经
  // store——命令卡已 disarm 或根本没有 armed 卡，快捷键路径无从双决策。
  // 按钮带 key：模态是异步落体，点击时卡号/命令可能早已换代（同串并行命令
  // 的第二条），不带 key 校验就会把新令的决策发给旧令（幽灵决策）。
  _approvalModal(command, reasons, key) {
    // modal.js 缺席（加载失败/测试环境）时不得抛穿——看门狗循环的 toModal
    // 会把异常吃成 unhandledRejection，测试互相污染
    if (typeof modalShell !== "function") {
      console.warn(_t("[ot] 模态组件缺失（modal.js 未载），审批模态兜底不可用"));
      return;
    }
    modalShell(_t("审批：") + (command || ""),
      `<p>${esc(reasons || "")}</p>`,
      [{label: _t("批准"), primary: true,
        onClick: () => this._sendDecision({type: "approve"}, command, key)},
       {label: _t("拒绝"),
        onClick: () => this._sendDecision(
          {type: "reject", message: _t("用户拒绝了该命令")}, command, key)}]);
  }

  // 决策单发出口：卡内 Ctrl+Enter（feed onDecision）与模态按钮都会到，
  // 只放一发。第二发决策会落到 core 下一次 ask_decision 头上，等于替用户
  // 批准一条根本没看过的命令（真机 B1 的幽灵模态双决策）。
  _sendDecision(decision, command, key) {
    if (this._dead || this._approvalResolved) return false;
    // 键对不上＝本令已决策或已被下一令顶掉（命令串可能与并行同串命令相同，
    // 只有 (卡 id,命令串) 整键才认得准）
    if (key != null && this._approvalKey !== key) return false;
    if (key == null && command != null && this._approvalCmd !== command) return false;
    this._approvalResolved = true;
    this._approvalOpen = false;
    this._approvalCmd = null;
    this._approvalKey = null;
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

  _openRunTextDialog() {
    modalShell(_t("执行长文本"), `
      <p class="run-text-hint">${_t("整段文本会一次性进入终端，并作为一条命令执行（只提交一次回车）。")}</p>
      <textarea id="run-text-input" rows="8" spellcheck="false"
                placeholder="${_t("粘贴或输入要执行的命令")}"></textarea>`, [
      {label: _t("执行"), primary: true, onClick: () => {
        const el = document.getElementById("run-text-input");
        const text = (el ? el.value : "").replace(/\s+$/, "");
        if (!text) return false;
        this._runLongCommand(text);
        this.focusCursor();
        return true;
      }},
      {label: _t("取消")},
    ]);
    const el = document.getElementById("run-text-input");
    if (el) el.focus();
  }

  focusCursor() {
    try { this.term.focus(); } catch (e) {}
  }

  // 长文本一次性执行：整段进终端、只提交一次回车。
  // 仍走 _feedData（手动命令要按增量并进消息历史），只是临时关掉 NL 分类——
  // 用户在弹框里写的是「一条命令」，不该被当成自然语言任务交给 agent。
  _runLongCommand(text) {
    if (this._dead) return;
    this._forceCmd = true;
    try {
      this.term.paste(text);       // bracketed paste：整段一次进终端
    } finally {
      this._forceCmd = false;
    }
    this._feedData(String.fromCharCode(13));
  }

  fit() {
    if (!this.paneEl.classList.contains("active")) return;
    try {
      const stage = this.paneEl.querySelector(".ot-stage");
      const termEl = this.paneEl.querySelector(".term");
      // 明确给活动终端一屏高度，不能由 xterm 当前 24 行内容反推容器高度。
      // 向下取整避免小数像素造成额外滚动条；历史卡片不参与高度计算。
      const height = stage && Math.floor(stage.getBoundingClientRect().height);
      if (termEl && height > 0 && termEl.style.height !== height + "px") {
        termEl.style.height = height + "px";
      }
      if (this.filesPanel && this.filesPanel._built && !this.filesPanel.el.hidden) {
        this.filesPanel._place();
      }
      this.fitAddon.fit();
    } catch (e) { /* 隐藏/零尺寸时忽略 */ }
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
    if (t) t.textContent = stage === "agent_init" ? _t("初始化 Agent") : _t("连接中");
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
      el.innerHTML = _t("命令集暂停：请在终端输入密码 ") +
        `<button class="status-cmdset-resume" tabindex="-1">${_t("继续")}</button>`;
      el.querySelector(".status-cmdset-resume").onclick = () =>
        this.sendJson({type: "cmdset_resume"});
      return;
    }
    if (msg.state === "done") {
      el.textContent = _t("命令集执行完毕");
      this._csTimer = setTimeout(() => { el.textContent = ""; }, 4000);
      return;
    }
    // 状态栏说清在跑哪条:只报 1/3 计数时用户看不出第 2、3 条到底执行了
    // 没有(真机反馈「只显示了第 1 条命令的执行记录」)。应答行不带内容
    // (core 对 `>` 行传空串),防密码泄进状态栏。
    const cmd = msg.cmd ? String(msg.cmd) : "";
    const short = cmd.length > 40 ? cmd.slice(0, 40) + "…" : cmd;
    el.textContent = _t("命令集 {0}/{1}", msg.index || "", msg.total || "") +
      (short ? "：" + short : "");
    el.title = cmd ? _t("正在执行：") + cmd : "";
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
      const elapsed = this._taskStartedAt
        ? Math.max(0, Math.round((Date.now() - this._taskStartedAt) / 1000)) : 0;
      let text = elapsed ? _t("AI 正在思考 {0}s", elapsed) : _t("AI 正在思考");
      let title = _t("任务未结束：AI 正在分析或执行");
      if (this._runningTool) {
        const t = this._runningTool.length > 36
          ? this._runningTool.slice(0, 36) + "…" : this._runningTool;
        text = _t("执行中: ") + t;
        title = _t("正在执行: ") + this._runningTool;
      }
      if (this._approvalOpen) {
        text = _t("等待审批");
        title = _t("命令等待你的决定（Ctrl+Enter 执行 / Ctrl+Backspace 拒绝）");
      }
      // Phase 3 徽标增强：三态文案拼进度计数（progress 心跳 1s 刷）——
      // 「思考中 12s · 已生成 N 字 · in X / out Y」。tokens 为 runner 估算口径，
      // usage 事件到后由 _renderTokens 修正在状态栏右侧（此处保持心跳值）
      const p = this._progress;
      if (p && (p.chars || p.tokensIn || p.tokensOut)) {
        text += _t(" · 已生成 {0} 字 · in {1} / out {2}", p.chars || 0, p.tokensIn || 0, p.tokensOut || 0);
      }
      if (tt) tt.textContent = text;
      el.title = title;
    }
    const bar = this.paneEl && this.paneEl.querySelector(".statusbar");
    if (bar) bar.classList.toggle("task-on", this._taskActive);
  }

  // --- WS JSON 事件 ---
  // 契约：ready/status/closed/usage/approval/ask_password/ask_password_dismiss/ask_host_key/
  // interrupt/mode/auth/change_model/task_start/final/denied/limit/error/
  // stage + Phase 1：ai_result/task_end/ai_card/ai_collapse（no-op）/ping。
  handleMsg(msg) {
    switch (msg.type) {
      case "ping":
        break;   // 心跳：存活基线已在 onmessage 记 _lastMsgAt，这里无需动作
      case "ready": {
        this._pwCapture = null;   // 登录成功：退出密码内联捕获
        this.setStatus("connected",
          _t("已连接 {0}{1}", msg.host, msg.distro ? "（" + msg.distro + "）" : ""));
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
        // 本机终端没有远程文件：知道会话类型后收掉 📁 入口（否则是个死按钮）
        if (this.filesPanel) this.filesPanel.probeSupport();
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
          modalConfirm(_t("记住密码"),
            _t("已成功登录。记住该主机的密码？下次连接将自动登录") +
            _t("（写入系统凭据库，不落数据库）"),
            ok => {
              if (ok) this.sendJson({type: "auth",
                                     auth_kind: "password_remember",
                                     text: ""});
            }, _t("记住"), _t("不记住"));
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
        this.showApproval(msg.command, msg.reasons, msg.host, msg.risk, msg.id);
        break;
      case "ask_password":
        if (!msg.auth_kind || msg.auth_kind === "password") {
          // 初始连接讨密码：与真实终端一致——提示符直接落进终端，无回显
          // 收集输入（不弹模态）；错密后端重讨时补 OpenSSH 的 denied 行。
          // 取消=Ctrl+C（发 password_cancel，中止整个连接尝试）
          if (this._pwCapture && this._pwCapture.submitted)
            this._writeTerm("\r\nPermission denied, please try again.");
          this._pwNewline();
          this._writeTerm(msg.label || _t("密码: "));
          // 撤连接浮层让提示符可见（ready/closed 自会撤，无需恢复）
          const ov = document.getElementById(`connov-${this.tabId}`);
          if (ov) ov.hidden = true;
          this._pwCapture = {kind: "password", buf: "", submitted: false};
          break;
        }
        modalAsk(_t("密码"), msg.label, (value, remember) => {
          this.sendJson({type: "auth", auth_kind: msg.auth_kind || "password",
                         text: value, remember});
        }, {remember: msg.auth_kind !== "cmdset",
            rememberLabel: _t("记住密码（写入系统凭据库，不落数据库）"),
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
        modalConfirm(_t("记住密码"),
          msg.text || _t("已成功登录。记住该密码？下次自动填充") +
                      _t("（写入系统凭据库，不落数据库）"),
          ok => {
            this.sendJson({type: "auth",
                           auth_kind: ok ? "remember_yes" : "remember_no",
                           text: ""});
          }, _t("记住"), _t("不记住"));
        break;
      case "ask_host_key":
        modalConfirm(_t("主机密钥"), msg.message, ok => {
          this.sendJson({type: "auth", auth_kind: "host_key", text: String(ok)});
        });
        break;
      case "interrupt":
        this._onTaskFail("interrupt", msg.text || _t("已中断"));
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
        this.setStatus("closed", msg.text || _t("连接已关闭"));
        break;
      case "reconnected":
        this.setStatus("connected", msg.text || _t("已重新连接"));
        break;
      // --- AI 事件：新契约顶层直接下发；兼容旧 {type:"event"} 包装 ---
      case "event":
        this.handleEvent(msg.event);
        break;
      case "task_start":
        this._onTaskStart();
        break;
      case "ai_result":
        this._onAiResult(msg);
        break;
      case "task_end":
        this._onTaskEnd();
        break;
      case "progress":
        this._onProgress(msg);
        break;
      case "ai_collapse":
        break;   // 流式契约退役：事件留线（CLI 依赖），Web 侧 no-op
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
      case "ai_result": this._onAiResult(ev); break;
      case "task_end": this._onTaskEnd(); break;
      case "progress": this._onProgress(ev); break;
      case "ai_boundary": this._onBoundary(); break;
      case "ai_collapse": break;   // 流式契约退役：事件留线（CLI 依赖），Web 侧 no-op
      case "ai_tool": this._onAiTool(ev); break;
      case "term_open": this._onTermOpen(ev); break;
      case "term_close": this._onTermClose(ev); break;
      case "ai_card": this._onAiCard(ev.markdown); break;
      case "final": this._onFinal(ev.text); break;
      case "interrupt": this._onTaskFail("interrupt", ev.text || _t("已中断")); break;
      case "rescue": this._showRescue(ev); break;
      case "denied":
      case "limit":
      case "error":
        // 系统异常（模型/工具超时、崩溃等）入红色警告卡展示（真机约定：
        // 报错信息都进红卡）。denied 是策略拒绝、limit 是预算停——业务
        // 语义，不入红卡
        if (ev.kind === "error") this._onAlert({text: ev.text || _t("系统异常")});
        this._onTaskFail(ev.kind, ev.text);
        break;
      case "session_cleared":
        this._clearCards();
        break;
      case "padded":
        this._onPadded(ev);
        break;
      case "alert":
        this._onAlert(ev);
        break;
      default:
        break;   // 未知事件静默忽略（此前 JSON.stringify 进终端是调试残留）
    }
  }

  close() {
    this._dead = true;
    // 文件面板的定时器不归 Session 管，但随会话一起死：不收就会拿着死 tabId
    // 无限轮询 /state，日志刷 404 直到刷新页面
    if (this.filesPanel) this.filesPanel.dispose();
    if (this._layoutObserver) this._layoutObserver.disconnect();
    if (this._stageContentObserver) this._stageContentObserver.disconnect();
    if (this._layoutFrame != null) cancelAnimationFrame(this._layoutFrame);
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
      // 点「连接服务器」就是要看终端：设置页若开着得让开（它会 display:none
      // 掉 #tabbar/#panes）。放在建 tab 成功后，POST 失败仍留在设置页不误跳
      if (typeof closeSettings === "function") closeSettings();
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
    nav.appendChild(sep(_t("直接连接")));
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
    `<button data-a="copy" title="${_t("复制为新的连接")}">⧉</button>` +
    `<button data-a="edit" title="${_t("编辑")}">✎</button>` +
    `<button data-a="del" title="${_t("删除")}">✕</button></span>`;
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
    `<span class="t-sub">${_t("本机终端")}</span></span>`;
  b.onclick = () => openTab("local");
  return b;
}

// 连接表单：远程机器的新增与编辑；
// 密码只进系统凭据库（服务端保证不落 SQLite）
function connForm(opts = {}) {
  const edit = opts.edit || null;
  const copy = opts.copy || null;        // 复制模式：预填源连接信息，保存新建
  const src = copy || edit;              // 预填来源（复制=源连接，编辑=被编辑对象）
  const title = (copy ? _t("复制") : edit ? _t("编辑") : _t("添加")) + _t("远程机器");
  // 复制默认名 = 原名 + 「 副本」：POST /api/saved 按 name upsert，同名保存会
  // 覆盖原连接而非新建，预加后缀保证落成独立新连接（用户可再改）
  const nameVal = copy ? ((copy.name || "").replace(/ 副本$/, "") + _t(" 副本"))
                       : (edit ? edit.name : "");
  // 连接后命令集:仅远程机器表单。密码写 > @名字=密码,保存后服务端
  // 抽取入凭据库并把该行改写为 > @名字 回传(弹窗即关,无需回显刷新)
  const cmdRow = `
      <label>${_t("连接后命令")}</label>
      <textarea id="f-commands" rows="4" spellcheck="false"
                placeholder="${_t("连接成功后自动逐行执行。自动应答写 &gt; @名字=密码（保存后转为引用）")}">${esc(src && src.commands ? src.commands : "")}</textarea>`;
  modalShell(title, `
    <div class="form-grid">
      <label>${_t("主机名")}</label>
      <input id="f-name" type="text" autocomplete="off"
             placeholder="${_t("如 web01，留空默认 user@IP")}" value="${esc(nameVal)}">
      <label>${_t("IP 地址")}</label>
      <input id="f-host" type="text" autocomplete="off"
             placeholder="${_t("如 192.168.1.10")}" value="${esc(src ? src.host : "")}">
      <label>${_t("端口")}</label>
      <input id="f-port" type="text" autocomplete="off"
             placeholder="${_t("默认 22")}" value="${src && src.port ? src.port : ""}">
      <label>${_t("用户名")}</label>
      <input id="f-user" type="text" autocomplete="off"
             placeholder="${_t("如 root")}" value="${src && src.user ? src.user : ""}">
      <label>${_t("密码")}</label>
      <input id="f-pass" type="password" autocomplete="new-password"
             placeholder="${copy || edit ? _t("留空则不修改") : _t("存入系统凭据库，不写数据库")}">
      ${cmdRow}
    </div>`, [
    {label: _t("确定"), primary: true, onClick: () => {
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
          if (!ok) { alert(_t("保存失败：") + (d.detail || _t("请检查表单内容"))); return; }
          loadTargets();
          if (d.warning) alert(d.warning);
          // 新增远程机器：保存成功后直接开 tab 尝试连接；复制不自动开——先落列表
          // 让用户确认/改完再连，避免误连出多个重复 tab
          if (!edit && !copy) openTab(d.name || payload.name || host);
        })
        .catch(() => alert(_t("保存失败：网络错误")));
      return true;
    }},
    {label: _t("取消"), onClick: () => {}},
  ]);
  // 密码栏回填凭据库里的密码（type="password" 恒以密文显示），不再留空让人
  // 重敲一遍；取不到才空着，语义仍是「留空则不修改」。弹框已换代就丢弃结果。
  const passEl = document.getElementById("f-pass");
  if (src && src.name && passEl) {
    authFetch("/api/saved/" + encodeURIComponent(src.name) + "/password")
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (passEl.isConnected && j && j.password) passEl.value = j.password;
      })
      .catch(() => {});
  }
  // 复制/编辑聚焦 IP 地址（最可能改动）；新增聚焦主机名
  const first = document.getElementById(copy || edit ? "f-host" : "f-name");
  if (first) first.focus();
}

function connDelete(t) {
  const sub = `${t.user ? t.user + "@" : ""}${t.host || ""}${t.port ? ":" + t.port : ":22"}`;
  modalConfirm(_t("删除连接"),
    _t("确定删除 {0}（{1}）吗？\n记住的密码将一并从系统凭据库清除。", t.name, sub),
    ok => {
      if (!ok) return;
      authFetch(`/api/saved/${encodeURIComponent(t.name)}`, {method: "DELETE"})
        .then(() => loadTargets());
    }, _t("删除"), _t("取消"));
}

// --- 全局事件 ---
document.getElementById("btn-add-remote").onclick = () => connForm({});

// 通用设置改动：落到所有已打开的终端（与主题刷新同一条路）
window.addEventListener("ot-term-options-change", event => {
  const opt = event.detail || {};
  Object.values(sessions).forEach(session => {
    const term = session.term;
    if (!term) return;
    if (opt.fontSize) term.options.fontSize = opt.fontSize;
    if (opt.scrollback) term.options.scrollback = opt.scrollback;
    if (opt.cursorStyle) term.options.cursorStyle = opt.cursorStyle;
    if (typeof opt.cursorBlink === "boolean") term.options.cursorBlink = opt.cursorBlink;
    term.refresh(0, term.rows - 1);
  });
});

// 语言切换：侧栏条目带插值句，重绘一遍。终端面板**不重建**——那会毁掉 xterm
// 的屏幕状态，它的固定文案由 i18n.js 的整页文本替换就地换掉。
if (typeof onLangChange === "function") onLangChange(() => renderTargets());

window.addEventListener("ot-theme-change", () => {
  Object.values(sessions).forEach(session => {
    if (!session.term) return;
    session.term.options.theme = terminalTheme();
    session.term.refresh(0, session.term.rows - 1);
  });
});

document.getElementById("sidebar-search").addEventListener("input", ev => {
  searchQuery = ev.target.value.trim();
  renderTargets();
});

document.getElementById("btn-toggle-sidebar").onclick = () => {
  document.body.classList.toggle("sidebar-collapsed");
  const s = sessions[activeTabId];
  if (s) setTimeout(() => s.fit(), 60);
};

const showSidebar = document.getElementById("btn-show-sidebar");
if (showSidebar) showSidebar.onclick = () => {
  document.body.classList.remove("sidebar-collapsed");
  document.getElementById("sidebar-search").focus();
  const s = sessions[activeTabId];
  if (s) setTimeout(() => s.fit(), 60);
};

// 响应式侧栏：窄窗口收起侧栏让终端拿满宽度（CSS 在 ≤860px 把侧栏转浮层，
// 收起后即可用顶栏按钮唤出）。只在「跨过阈值变窄」时收起，宽回去了也不
// 自动展开——展开是用户的手势，不与之抢状态。
const SIDEBAR_NARROW = 860;
let wasNarrow = window.innerWidth <= SIDEBAR_NARROW;
if (wasNarrow) document.body.classList.add("sidebar-collapsed");

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const narrow = window.innerWidth <= SIDEBAR_NARROW;
    if (narrow && !wasNarrow) document.body.classList.add("sidebar-collapsed");
    wasNarrow = narrow;
    const s = sessions[activeTabId];
    if (s) { s.fit(); s._keepApprovalInView(); }
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
