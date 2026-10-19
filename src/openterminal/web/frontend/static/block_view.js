// 块流渲染器：把 BlockStream 的块列表画成流式 DOM（Phase 1）。
//
// 取代「xterm decoration 浮层」：卡片块是普通 DOM 节点，高度由内容自撑，
// 后面的块自然下推。于是三条硬约束同时消失——不遮挡（兄弟节点不重叠）、
// 不裁切（没有 clamp）、无大空白（没有 pad，也就没有「不可回吐的垫行」）。
//
// 卡片渲染复用现有 React island：`feed.mount(id, hostEl)` 只要一个 DOM 元素，
// 本来就与 xterm 解耦——所以 cards.jsx / island.css / style.css 一行不改，
// 观感原样保留。
//
// 文本块这里用 DOM 渲染（ANSI → HTML）；接真 xterm 做活动区是 Phase 2 的事。
// 纯函数（ansiToHtml / stripAnsi / pickRenderOps）可直测，不碰 DOM。
"use strict";

// ── ANSI SGR → HTML ──────────────────────────────────────
//
// 冻结块是「只读的历史输出」，不需要终端的光标/换行语义，只要把颜色和
// 常见属性画对。控制序列一律丢弃，避免把 \x1b[K 之类画成乱码。
const ANSI_FG = {
  30: "#6b7280", 31: "#f87171", 32: "#4ade80", 33: "#fbbf24",
  34: "#60a5fa", 35: "#c084fc", 36: "#22d3ee", 37: "#d1d5db",
  90: "#9ca3af", 91: "#fca5a5", 92: "#86efac", 93: "#fde68a",
  94: "#93c5fd", 95: "#d8b4fe", 96: "#67e8f9", 97: "#f3f4f6",
};
const ANSI_BG = {
  40: "#374151", 41: "#7f1d1d", 42: "#14532d", 43: "#713f12",
  44: "#1e3a8a", 45: "#581c87", 46: "#155e75", 47: "#4b5563",
  100: "#4b5563", 101: "#991b1b", 102: "#166534", 103: "#854d0e",
  104: "#1e40af", 105: "#6b21a8", 106: "#155e75", 107: "#6b7280",
};

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripAnsi(s) {
  return String(s == null ? "" : s)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

// 解析一段文本，产出 [{text, cls, style}] 片段；再拼成 HTML。
// 不用 innerHTML 拼用户可控内容以外的标签——所有文本过 escHtml。
function ansiToHtml(src, opts) {
  const o = opts || {};
  const s = String(src == null ? "" : src);
  const out = [];
  let buf = "";
  let cur = null;   // {bold, dim, italic, underline, fg, bg}
  const push = () => {
    if (!buf) return;
    const attrs = [];
    if (cur) {
      if (cur.bold) attrs.push("font-weight:600");
      if (cur.italic) attrs.push("font-style:italic");
      const decoration = [cur.underline ? "underline" : "", cur.strike ? "line-through" : ""].filter(Boolean);
      if (decoration.length) attrs.push("text-decoration:" + decoration.join(" "));
      if (cur.inverse) {
        attrs.push("color:" + (cur.bg || "#0d1117"));
        attrs.push("background:" + (cur.fg || "#e6e8ea"));
      } else {
        if (cur.fg) attrs.push("color:" + cur.fg);
        if (cur.bg) attrs.push("background:" + cur.bg);
      }
      if (cur.invisible) attrs.push("visibility:hidden");
      if (cur.dim) attrs.push("opacity:.62");
    }
    out.push(attrs.length
      ? '<span style="' + attrs.join(";") + '">' + escHtml(buf) + "</span>"
      : escHtml(buf));
    buf = "";
  };

  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch !== "\x1b") { buf += ch; i++; continue; }
    // OSC（标题等）：整段丢到终止符
    if (s[i + 1] === "]") {
      let j = i + 2;
      while (j < s.length && s[j] !== "\x07") {
        if (s[j] === "\x1b" && s[j + 1] === "\\") { j += 2; break; }
        j++;
      }
      push();
      i = j + 1;
      continue;
    }
    // CSI：参数字节 0x30-0x3F（0-9:;<=>?），中间字节 0x20-0x2F，终结字节 0x40-0x7E。
    // 终结判错会把后面的正文整段吞进转义序列（真机 `<script>` 被吃掉的同款 bug）。
    if (s[i + 1] === "[") {
      let j = i + 2;
      while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3F) j++;
      const paramEnd = j;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2F) j++;
      const code = j < s.length ? s.charCodeAt(j) : -1;
      const isFinal = code >= 0x40 && code <= 0x7E;
      const final = isFinal ? s[j] : null;
      const params = s.slice(i + 2, paramEnd);
      // 残缺序列：跳过 ESC 本身，剩下的当正文（不能整段丢掉用户输出）
      i = isFinal ? j + 1 : i + 1;
      if (final !== "m") continue;   // 光标/清屏/擦除等一律丢弃
      push();
      cur = applySgr(cur, params, o);
      continue;
    }
    push();
    i++;
  }
  push();
  return out.join("");
}

function applySgr(cur, params, opts) {
  const st = Object.assign({}, cur || {});
  const nums = String(params || "0").split(";").map(x => {
    const n = parseInt(x, 10);
    return isNaN(n) ? 0 : n;
  });
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i];
    if (n === 0) { delete st.bold; delete st.dim; delete st.italic;
      delete st.underline; delete st.fg; delete st.bg;
      delete st.inverse; delete st.invisible; delete st.strike; }
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.underline = true;
    else if (n === 7) st.inverse = true;
    else if (n === 8) st.invisible = true;
    else if (n === 9) st.strike = true;
    else if (n === 22) { delete st.bold; delete st.dim; }
    else if (n === 23) delete st.italic;
    else if (n === 24) delete st.underline;
    else if (n === 27) delete st.inverse;
    else if (n === 28) delete st.invisible;
    else if (n === 29) delete st.strike;
    else if (n === 39) delete st.fg;
    else if (n === 49) delete st.bg;
    else if (n === 38 || n === 48) {
      // 38;5;N / 38;2;r;g;b —— 256 色按灰阶与色立方粗略近似即可，
      // 冻结块是只读历史，不必逐格精确
      const mode = nums[i + 1];
      if (mode === 5) {
        const v = nums[i + 2] | 0;
        const col = v < 16 ? ANSI_FG[v < 8 ? v + 30 : v + 82]
          : v < 232 ? cube256(v) : gray256(v);
        if (n === 38) st.fg = col; else st.bg = col;
        i += 2;
      } else if (mode === 2) {
        const col = "rgb(" + (nums[i + 2] | 0) + "," + (nums[i + 3] | 0) +
          "," + (nums[i + 4] | 0) + ")";
        if (n === 38) st.fg = col; else st.bg = col;
        i += 4;
      }
    }
    else if (ANSI_FG[n]) st.fg = ANSI_FG[n];
    else if (ANSI_BG[n]) st.bg = ANSI_BG[n];
  }
  return st;
}

function cube256(v) {
  const idx = v - 16;
  const r = Math.floor(idx / 36), g = Math.floor((idx % 36) / 6), b = idx % 6;
  const f = x => (x === 0 ? 0 : 55 + x * 40);
  return "rgb(" + f(r) + "," + f(g) + "," + f(b) + ")";
}
function gray256(v) {
  const g = 8 + (v - 232) * 10;
  return "rgb(" + g + "," + g + "," + g + ")";
}

// 从已解析的 xterm 单元格取快照，而不是重放原始 PTY 控制序列。
// translateToString 只留文字，会把命令青色、自然语言蓝色和输出本身的颜色洗掉。
function bufferToAnsi(buffer) {
  const lines = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) { lines.push(""); continue; }
    if (typeof line.getCell !== "function") {
      lines.push(line.translateToString(true));
      continue;
    }
    const next = buffer.getLine(i + 1);
    let end = line.length;
    // 双宽字符放不进行末最后一列时，xterm 会留下一个空续位再折行。
    // 它不是用户输入的空格（显式空格 getChars() === " "），合并时不能补进去。
    if (next && next.isWrapped && end > 0 && next.getCell(0)?.getWidth() === 2 &&
        line.getCell(end - 1)?.getChars() === "") end--;
    // 软折行中间的空格是内容；只修剪逻辑行末尾的空白。
    if (!next || !next.isWrapped) {
      while (end > 0) {
        const cell = line.getCell(end - 1);
        if (cell && (cell.getChars().trim() || cell.getWidth() === 0)) break;
        end--;
      }
    }
    let text = "", active = "";
    for (let x = 0; x < end; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // CJK/emoji 的续格不能再输出一遍
      const codes = [];
      for (const [method, code] of [["isBold", 1], ["isDim", 2], ["isItalic", 3],
        ["isUnderline", 4], ["isInverse", 7], ["isInvisible", 8], ["isStrikethrough", 9]]) {
        if (typeof cell[method] === "function" && cell[method]()) codes.push(code);
      }
      for (const [prefix, code] of [["Fg", 38], ["Bg", 48]]) {
        const color = cell["get" + prefix + "Color"]();
        if (cell["is" + prefix + "RGB"]()) {
          codes.push(code, 2, (color >> 16) & 255, (color >> 8) & 255, color & 255);
        } else if (cell["is" + prefix + "Palette"]()) {
          codes.push(code, 5, color);
        }
      }
      const style = codes.join(";");
      if (style !== active) {
        text += "\x1b[0m" + (style ? "\x1b[" + style + "m" : "");
        active = style;
      }
      text += cell.getChars() || " ";
    }
    if (active) text += "\x1b[0m";
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join("\n").replace(/\s+$/, "");
}

// ── DOM 渲染 ────────────────────────────────────────────
//
// sync() 让容器的子节点与块列表一致：按 id 复用节点，只在必要时插入/移动/
// 删除。移动用 insertBefore，不重建——重建会把 React root 拆了重挂（闪烁）。
class BlockView {
  /**
   * @param {Element} container 滚动容器
   * @param {object} opts { feed, onUserScroll, follow }
   */
  constructor(container, opts) {
    this.container = container;
    this.feed = (opts && opts.feed) || null;
    this.onUserScroll = (opts && opts.onUserScroll) || null;
    this.follow = !opts || opts.follow !== false;
    this.nodes = new Map();       // blockId -> element
    this._armed = new Set();      // 已 feed.mount 的卡
    this._bindScroll();
  }

  _bindScroll() {
    const c = this.container;
    if (!c || typeof c.addEventListener !== "function") return;
    // 已定决策：跟着滚，但用户一往上翻就停住，不跟用户抢滚动条
    c.addEventListener("scroll", () => {
      if (!this.follow) return;
      if (!this._atBottom()) {
        this.follow = false;
        if (this.onUserScroll) this.onUserScroll(false);
      }
    }, { passive: true });
  }

  _atBottom() {
    const c = this.container;
    if (!c) return true;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 24;
  }

  // 用户点「回到底部」
  resumeFollow() {
    this.follow = true;
    this.scrollToBottom();
  }

  scrollToBottom() {
    const c = this.container;
    if (!c) return;
    c.scrollTop = c.scrollHeight;
  }

  // 与块列表对齐。返回本次是否有节点移动（调用方据此决定要不要重算滚动）。
  sync(blocks, opts) {
    const c = this.container;
    if (!c) return false;
    const want = blocks || [];
    const liveId = opts && opts.liveId;
    let moved = false;

    for (let i = 0; i < want.length; i++) {
      const b = want[i];
      let el = this.nodes.get(b.id);
      if (!el) {
        el = this._create(b);
        this.nodes.set(b.id, el);
        moved = true;
      }
      this._paint(b, el, b.id === liveId);
      const at = c.children[i];
      if (at !== el) {
        c.insertBefore(el, at || null);
        moved = true;
      }
    }
    // 多出来的节点删掉（已从块流移除的）
    while (c.children.length > want.length) {
      const dead = c.children[c.children.length - 1];
      this._destroy(dead);
      c.removeChild(dead);
      moved = true;
    }
    if (this.follow) this.scrollToBottom();
    return moved;
  }

  _create(b) {
    const el = this.container.ownerDocument.createElement("div");
    el.className = "ot-blk ot-blk-" + b.kind;
    el.dataset.blockId = b.id;
    el.dataset.kind = b.kind;
    if (b.kind === "card") {
      // 卡片块：给 React island 一个普通宿主，不是 xterm decoration
      const host = this.container.ownerDocument.createElement("div");
      host.className = "ot-card-host ot-flow-host";
      el.appendChild(host);
      el._host = host;
    } else {
      const body = this.container.ownerDocument.createElement("div");
      body.className = "ot-blk-body";
      el.appendChild(body);
      el._body = body;
    }
    return el;
  }

  _paint(b, el, isLive) {
    el.classList.toggle("ot-live", !!isLive);
    if (b.kind === "card") {
      const host = el._host;
      if (host && this.feed && !this._armed.has(b.id)) {
        try { this.feed.mount(b.id, host); } catch (e) { /* island 缺席不挡排版 */ }
        this._armed.add(b.id);
      }
      return;
    }
    const body = el._body;
    if (!body) return;
    const text = (b.payload && (b.payload.text != null ? b.payload.text : b.payload.output)) || "";
    // 重画是幂等的：内容没变就不动 DOM（滚动条/选区都不被打扰）
    if (el._text !== text) {
      el._text = text;
      body.innerHTML = ansiToHtml(text);
    }
    // 过渡段用紫色左边线标注，内容照常（不是空框）
    el.classList.toggle("ot-transition", b.kind === "transition");
    el.classList.toggle("ot-banner", b.kind === "banner");
  }

  _destroy(el) {
    const id = el && el.dataset ? el.dataset.blockId : null;
    if (id) {
      if (this.feed && this._armed.has(id)) {
        try { this.feed.unmount(id); } catch (e) {}
      }
      this._armed.delete(id);
      this.nodes.delete(id);
    }
  }

  destroy() {
    const c = this.container;
    if (c) while (c.firstChild) { this._destroy(c.firstChild); c.removeChild(c.firstChild); }
    this.nodes.clear();
    this._armed.clear();
    if (this.feed && typeof this.feed.destroy === "function") {
      try { this.feed.destroy(); } catch (e) {}
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BlockView, ansiToHtml, stripAnsi, escHtml, bufferToAnsi };
}
