// 块流：卡片层的排版地基（Phase 1）。
//
// 取代「卡片贴在 xterm 网格行上的浮层」：输出是一串有序的块，卡片块与文本块
// 是平级兄弟节点，位置由块序决定。这样三条硬约束同时消失——
//   ① 卡片要占网格行 → 就要在缓冲里插空行 → 只能 shell 往返（慢、且只能追加流底）；
//   ② 占位行数不满就夹紧截断（真机「⚠ 系统警告只剩标题」）；
//   ③ 多卡并发 registerMarker 抢同一行 → 后贴纸盖先贴纸（真机「工具卡盖审批卡」）。
//
// 三条设计原则（见 docs/block-stream-plan.md）：
//   P1 布局不得依赖 shell 集成（sudo su - 后 hook 必死）；
//   P2 标记是加速器不是依赖；
//   P3 **锚点是身份不是坐标**——本模块只认 id，从不认行号。
//
// 纯函数 + 可直测（node --test），不碰 DOM / xterm / React。
"use strict";

const KINDS = ["term", "card", "banner", "transition"];

class BlockStream {
  constructor() {
    this._seq = 0;
    this._blocks = [];          // 唯一权威：有序块列表
    this._byId = new Map();     // id -> block
    this._subs = new Set();
  }

  // ── id ───────────────────────────────────────────────
  // 全会话唯一、生成后永不改变。卡片与输出都靠它定位，所以并行插入不可能
  // 撞在同一处（今天抢 marker 行就是撞在这上面）。
  nextId(prefix) {
    this._seq += 1;
    return String(prefix || "blk") + "-" + this._seq;
  }

  // ── 增 ───────────────────────────────────────────────
  // 追加到末尾。id 已存在则拒绝：重连补块必须幂等，否则卡片重复（风险清单）。
  append(block) {
    const b = this._norm(block);
    if (this._byId.has(b.id)) return null;
    this._blocks.push(b);
    this._byId.set(b.id, b);
    this._emit({ type: "add", id: b.id, at: this._blocks.length - 1 });
    return b;
  }

  // 插到某块之后——**并行工具输出归属的关键**：out-2 挂 after:"card-2"，
  // card-3 自然下移。列表插入，不是坐标运算。
  //
  // after 不认识时（块已被移除 / 降级态认不出归属）落到末尾：宁可位置粗一点，
  // 也不许插进一段中间（已定决策）。
  insertAfter(afterId, block) {
    const b = this._norm(block);
    if (this._byId.has(b.id)) return null;
    const idx = this._indexOf(afterId);
    const at = idx < 0 ? this._blocks.length : idx + 1;
    this._blocks.splice(at, 0, b);
    this._byId.set(b.id, b);
    this._emit({ type: "add", id: b.id, at });
    return b;
  }

  // 插到某块之前。卡片要落在「当前活块」之上时用它：活块恒在流末尾，
  // 新卡 insertBefore(live) 即可，不需要知道上一张卡是谁。
  insertBefore(beforeId, block) {
    const b = this._norm(block);
    if (this._byId.has(b.id)) return null;
    const idx = this._indexOf(beforeId);
    const at = idx < 0 ? this._blocks.length : idx;
    this._blocks.splice(at, 0, b);
    this._byId.set(b.id, b);
    this._emit({ type: "add", id: b.id, at });
    return b;
  }

  // ── 改 ───────────────────────────────────────────────
  // 原地更新（tool_end 换徽标、分析卡换装总结卡）：零布局位移，不该 emit 布局
  // 变化——但要通知渲染器重画内容。
  update(id, patch) {
    const b = this._byId.get(id);
    if (!b || !patch) return null;
    for (const k of Object.keys(patch)) {
      if (k === "id") continue;         // 身份不可改
      if (patch[k] !== undefined) b[k] = patch[k];
    }
    this._emit({ type: "update", id });
    return b;
  }

  // ── 删 ───────────────────────────────────────────────
  // 中断 / 整卡移除 / 收束扫尾。删了就是整块没了——「完整或消失」的消失侧。
  //
  // 铁律（用户决策）：**等用户点按钮的卡永不移除**，除非显式 force（任务中断
  // 整卡移除、/clear）。把它做成结构性闸门而不是口头约定——否则虚拟化/收束
  // 扫尾任一处手一抖就是「按钮没了 = 审批死锁」。keepAlive 由 armed/disarmed
  // 翻转（见 update）。
  remove(id, opts) {
    const idx = this._indexOf(id);
    if (idx < 0) return false;
    if (this._blocks[idx].keepAlive && !(opts && opts.force)) return false;
    this._blocks.splice(idx, 1);
    this._byId.delete(id);
    this._emit({ type: "remove", id, at: idx });
    return true;
  }

  // 批量删（中断时连带该任务的在途块）。force：中断语义，越过 keepAlive
  removeMany(ids, opts) {
    let n = 0;
    for (const id of ids || []) if (this.remove(id, opts)) n++;
    return n;
  }

  clear(opts) {
    if (!this._blocks.length) return;
    // /clear、新会话是显式清场：越过 keepAlive
    this._blocks = [];
    this._byId.clear();
    this._emit({ type: "clear" });
  }

  // ── 查 ───────────────────────────────────────────────
  get(id) { return this._byId.get(id) || null; }
  has(id) { return this._byId.has(id); }
  get length() { return this._blocks.length; }

  // 顺序快照：渲染器照它画。返回浅拷贝，外部改不到内部账目。
  list() { return this._blocks.slice(); }

  indexOf(id) { return this._indexOf(id); }

  // 某块之后的块（含边界检查）：任务收束扫尾要按「本任务开了哪些块」清场。
  after(id) {
    const idx = this._indexOf(id);
    return idx < 0 ? [] : this._blocks.slice(idx + 1);
  }

  // 某类块的最后一张：换装（分析卡 → 总结卡）要找当前活卡
  lastOfKind(kind) {
    for (let i = this._blocks.length - 1; i >= 0; i--) {
      if (this._blocks[i].kind === kind) return this._blocks[i];
    }
    return null;
  }

  // 某任务/某代的块：收束扫尾按 gen 圈定，不误伤别的任务的卡
  filter(fn) { return this._blocks.filter(fn); }

  // ── 订阅 ─────────────────────────────────────────────
  // 变更只广播一次，渲染器批量重排；不要在这里做重活。
  subscribe(fn) {
    if (typeof fn === "function") this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit(ev) {
    for (const fn of this._subs) {
      try { fn(ev, this); } catch (e) { /* 单个订阅者出错不能打死排版 */ }
    }
  }

  _indexOf(id) {
    if (!id) return -1;
    for (let i = 0; i < this._blocks.length; i++) {
      if (this._blocks[i].id === id) return i;
    }
    return -1;
  }

  _norm(block) {
    const b = Object.assign({}, block || {});
    if (!b.id) b.id = this.nextId(b.kind || "blk");
    if (KINDS.indexOf(b.kind) < 0) b.kind = "term";
    if (b.state !== "live" && b.state !== "frozen") {
      // 文本块默认 live（还在收输出）；卡片块出生即定型（born-complete）
      b.state = b.kind === "card" ? "frozen" : "live";
    }
    if (b.conf == null) b.conf = 1;
    return b;
  }
}

// ── 纯函数：降级判定 ─────────────────────────────────────
//
// 位置精度随可用信息降级（L0 标记 → L1 提示符 → L2 静默 → L3 不切），
// 但「不遮挡 / 不裁切 / 无大空白 / 不消失」在每一级都成立——这是本架构的支点。
function canCut(ctx) {
  const c = ctx || {};
  if (c.marker) return { ok: true, level: "L0", conf: 1 };
  if (c.promptSeen && c.quietMs >= (c.minQuietMs || 350)) {
    return { ok: true, level: "L1", conf: 0.8 };
  }
  if (c.quietMs >= (c.minQuietMs || 350) && c.cursorAtLineStart) {
    return { ok: true, level: "L2", conf: 0.5 };
  }
  // L3：切不动就不切，当前块继续长，卡片进待安置条
  return { ok: false, level: "L3", conf: 0 };
}

// 换壳 / 跳板指令识别：**指令是我方亲手敲进 PTY 的**，所以不依赖任何远端配合，
// 在 hook 已死的裸壳下同样成立（P1）。
//
// `su` 必须带词边界：否则 `sudo apt install nginx` 会被 `su` 前缀误判成换壳。
// 不认裸 `bash`/`sh`/`zsh`/`exit`：误触发面太大（`sh -c '…'`、脚本里的 exit），
// 宁可漏判进 L3 降级（卡片完整、位置稍粗），也不许乱开过渡块。
const SHELL_SWITCH_RE = /^\s*(?:sudo\s+)?(?:\bsu\b(?:\s+-|\s+[a-z_][a-z0-9_-]*)?|\blogin\b|\bssh\s+|\bmosh\s+|\bexec\s+|\bscreen\s+|\btmux\s+)/;

function isShellSwitch(line) {
  return SHELL_SWITCH_RE.test(String(line == null ? "" : line));
}


// \-\ 纯函数：回显行 \-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\
//
// 工具卡下的输出块要带命令回显行（`[root@x /tmp]# ps aux ...`），观感才和
// 真终端一致。但 hook 画完回显后 Readline 会来一句「光标上移一格 + 擦行」
// 重绘提示符，随机啃掉一行——回显活不活得到收束是竞态，于是有的块带有的
// 不带。这里把它变成确定的：**开括号时记住那行真实回显**（彼时它刚画上），
// 收束时丢了就原样补回去。补的是 shell 自己画的那行（含真提示符），不是
// 我们瞎编的。

// 回显行 = 提示符尾符 + 这条命令，整行才算
function isCmdEcho(line, cmd) {
  const c = String(cmd == null ? "" : cmd).trim();
  const h = String(line == null ? "" : line).trimEnd();
  if (!c || !h.endsWith(c)) return false;
  const before = h.slice(0, h.length - c.length).trimEnd();
  const last = before.slice(-1);
  return last === "$" || last === "#" || last === "%" || last === ">";
}

// 从「缓冲区文本」里认回显行：只看最后一个非空行（回显刚画在那儿，其后
// 光标已换行）。认不出就返回空串——宁缺勿猜。
function pickCmdEcho(bufferText, cmd) {
  const lines = String(bufferText == null ? "" : bufferText).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trimEnd();
    if (!s) continue;
    return isCmdEcho(s, cmd) ? s : "";
  }
  return "";
}

// 收束时保证输出块以回显行开头：已在开头就原样；在中间就把前面的提示符
// 重绘噪声丢掉；整段被啃掉就补回去。
function ensureCmdEcho(text, echo) {
  const src = String(text == null ? "" : text);
  const e = String(echo == null ? "" : echo).trimEnd();
  if (!e) return src;
  const lines = src.split("\n");
  const i = lines.findIndex(l => l.trimEnd() === e);
  if (i === 0) return src;
  if (i > 0) return lines.slice(i).join("\n");
  return e + "\n" + src;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BlockStream, KINDS, canCut, isShellSwitch, SHELL_SWITCH_RE,
                  isCmdEcho, pickCmdEcho, ensureCmdEcho };
}
