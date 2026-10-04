// 卡片流状态机：纯 JS store（不依赖 React，vitest 可直接单测）。
// 事件契约与 worker 的 ServerMsg event kinds 一一对应：
//   task_start / ai_token / ai_think / ai_collapse / ai_tool / ai_card / final /
//   task_fail / approval / approval_key / decide / rescue / rescue_decide / clear
// （fold/toggle 折叠机制已随 v5 spec §3.4/§8 删除——分析卡整卡长留）
// React 侧经 useSyncExternalStore(subscribe, getSnapshot) 订阅快照。

// 决策文案映射（对齐原 app.js _decide 的回执徽标）
const DECISION_STATES = {
  approve: { text: "✓ 已同意", cls: "ok" },
  allow: { text: "★ 已始终允许", cls: "ok" },
  reject: { text: "✗ 已拒绝", cls: "fail" },
  edit: { text: "✎ 已编辑", cls: "edit" },
};

export class CardsStore {
  constructor() {
    this.cards = [];
    this._snap = { cards: [] };
    this._seq = 0;
    this._activeId = null;   // 流式中的分析卡 id（task_start → final）
    this._dirty = false;     // token 缓冲待冲刷
    this._timer = null;
    this._lastSummaryMd = null; // 换装去重：worker 连发 ai_card(md)+final(md) 同文
    this.onDecision = null;  // (decision, stateText, command, cardId) => void（app.js 结账后发 WS + 状态栏）
    this.onRescue = null;    // (accept) => void（app.js 发 rescue 决策 WS）
    this.onNewSession = null; // (cardId) => void（app.js 发 new_session WS + 回车换行）
  }

  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  listeners = new Set();

  getSnapshot = () => this._snap;

  _emit() {
    this._snap = { cards: this.cards.slice() };
    for (const fn of this.listeners) fn();
  }

  _card(id) {
    return this.cards.find(c => c.id === id) || null;
  }

  _active() {
    return this._activeId ? this._card(this._activeId) : null;
  }

  // 流式 token 100ms 批冲刷：token 事件可能高频到达，逐 token setState
  // 会渲染风暴；攒到定时器统一出快照。
  _flushSoon() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) {
        this._dirty = false;
        this._emit();
      }
    }, 100);
  }

  // 同步冲刷 token 缓冲（定格/结账场景用：冻结前把最后一批 flush 进卡，
  // 否则 _freezeActive 清 _dirty 会丢掉定时器里未出的尾批内容）
  flushNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._dirty) { this._dirty = false; this._emit(); }
  }

  _freezeActive(failed) {
    const a = this._active();
    if (a) {
      a.done = true;
      a.failed = !!failed;
      this._activeId = null;
      this._dirty = false;
    }
    return a;
  }

  // 决策入口（审批卡按钮与快捷键共用）：写回执徽标 + 通知 app.js 发 WS
  _decide(kind, edited) {
    const card = [...this.cards].reverse().find(
      c => c.type === "approval" && !c.decided);
    if (!card) return false;
    const st = DECISION_STATES[kind];
    if (!st) return false;
    let decision;
    if (kind === "approve") decision = { type: "approve" };
    else if (kind === "allow") decision = { type: "approve", allow: true };
    else if (kind === "reject") decision = { type: "reject", message: "用户拒绝了该命令" };
    else if (kind === "edit") {
      decision = { type: "edit", edited_action: { name: "execute", args: { command: edited } } };
      card.command = edited;   // 回执展示编辑后命令
    } else return false;
    card.decided = { text: st.text, cls: st.cls };
    card.editorOpen = false;
    this._emit();
    // 第 4 个参数是卡 id：app.js 据此在放行决策前先给这张卡结账垫高
    // （worker 收到决策立刻注入命令，输出会把预留区永久盖帽）
    this.onDecision && this.onDecision(decision, st.text, card.command, card.id);
    return true;
  }

  handle(evt) {
    switch (evt.kind) {
      case "task_start": {
        const card = {
          id: evt.id || ++this._seq, type: "analysis", think: true,
          text: "", reason: "", done: false, failed: false,
        };
        this.cards.push(card);
        this._activeId = card.id;
        this._lastSummaryMd = null;
        this._emit();
        break;
      }
      case "ai_token": {
        const a = this._active();
        if (!a || a.done) return;
        if (a.think) a.think = false;
        a.text += evt.text;
        this._dirty = true;
        this._flushSoon();
        break;
      }
      // 模型思考过程流式入卡（灰字），让任务全程的中间过程可见——
      // 工具调用阶段模型往往只有 thinking 没有正文，不收思考块分析卡
      // 会一直空转「正在思考」
      case "ai_think": {
        const a = this._active();
        if (!a || a.done) return;
        if (a.think) a.think = false;
        a.reason += evt.text;
        this._dirty = true;
        this._flushSoon();
        break;
      }
      case "ai_collapse": {
        // 收尾裁尾：最终回答的正文 token 也流进了活分析卡，而总结卡在下方
        // 新开分区（卡已不在流底、无法原地换装）时同文会出现两遍（真机
        // 「分析卡与总结卡内容重复」根因）。先把 100ms 尾批冲进卡再裁——
        // 只裁确实以总结正文结尾的卡（容尾随空白），不匹配不动（宁可
        // 重复不可误裁叙事）。裁掉的预留空白行不可回收，卡下留一段空白，
        // 好过整段 markdown 重复。
        if (evt.trimMd) {
          this.flushNow();
          const a = this._active();
          if (a && !a.done) {
            const t = (a.text || "").trimEnd();
            const m = evt.trimMd.trim();
            if (m && t.endsWith(m)) {
              a.text = t.slice(0, t.length - m.length).trimEnd();
              this._dirty = true;
            }
          }
        }
        this._freezeActive(false);
        this._emit();
        break;
      }
      case "ai_card":
        this._applySummary(evt.md, evt.id);
        break;
      case "final":
        // 有活卡 → 原地换装（纯问答路径，卡仍在流底）；无活卡（首个命令
        // 已 ai_collapse 冻结）→ 只定格，总结卡由 ai_card 携新分区挂载
        // （贴在命令输出下方），绝不回旧分区挤占输出
        {
          const a0 = this._active();
          if (evt.md && a0 && !a0.done) this._applySummary(evt.md);
        }
        this._freezeActive(false);
        this._emit();
        break;
      case "tool_start": {
        // 工具调用小卡：不占 _activeId（不参与流式 token/思考——ai_collapse
        // 已定格分析卡，后续模型输出经 app.js 开新分析卡）；end 置状态徽标
        const card = {
          id: evt.id || ++this._seq, type: "tool", name: evt.name || "",
          args: evt.args || "", done: false, failed: false,
        };
        this.cards.push(card);
        this._emit();
        break;
      }
      case "tool_end": {
        const card = this._card(evt.id);
        if (!card || card.type !== "tool" || card.done) return;
        card.done = true;
        card.failed = !!evt.failed;
        this._emit();
        break;
      }
      case "task_fail":
        // 任务中止时未决工具卡一并标失败，⏳ 不得悬挂到任务结束
        for (const c of this.cards) {
          if (c.type === "tool" && !c.done) {
            c.done = true;
            c.failed = true;
          }
        }
        this._freezeActive(true);
        this._emit();
        break;
      case "approval": {
        const card = {
          id: evt.id || ++this._seq, type: "approval", command: evt.command || "",
          reasons: evt.reasons || "", risk: evt.risk || "high",
          decided: null, editorOpen: false,
        };
        this.cards.push(card);
        this._emit();
        break;
      }
      case "decide":
        this._decide(evt.decision, evt.edited);
        break;
      case "rescue": {
        // 失败救援：用户命令非零退出，worker 挂卡询问是否交给 AI
        const card = {
          id: evt.id || ++this._seq, type: "rescue", line: evt.line || "",
          ec: evt.ec != null ? evt.ec : "?", output: evt.output || "",
          decided: null,
        };
        this.cards.push(card);
        this._emit();
        break;
      }
      case "rescue_decide": {
        const card = [...this.cards].reverse().find(
          c => c.type === "rescue" && !c.decided);
        if (!card) return false;
        card.decided = evt.accept
          ? { text: "✓ 已交给 AI", cls: "ok" }
          : { text: "已忽略", cls: "fail" };
        this._emit();
        this.onRescue && this.onRescue(!!evt.accept);
        return true;
      }
      case "approval_key": {
        const open = [...this.cards].reverse().find(
          c => c.type === "approval" && !c.decided);
        if (!open) return false;
        if (evt.key === "Enter") return this._decide("approve");
        if (evt.key === "e" || evt.key === "E") {
          open.editorOpen = !open.editorOpen;
          this._emit();
          return true;
        }
        if (evt.key === "Backspace") return this._decide("reject");
        return false;
      }
      case "new_session": {
        // 总结卡底部「开启新会话」：本卡原位变「✓ 新会话已开启」，通知
        // app.js 重置后端模型上下文（不清屏，界面等效按了一次回车）
        const card = this._card(evt.id);
        if (!card || card.newSession) return false;
        card.newSession = true;
        this._emit();
        this.onNewSession && this.onNewSession(card.id);
        return true;
      }
      case "clear":
        this.cards = [];
        this._activeId = null;
        this._dirty = false;
        this._emit();
        break;
    }
  }

  // 换装：流式分析卡原地变为总结卡（同 id 不重挂）。
  // 去重：worker 会连发 ai_card(md) 与 final(md)（同一份 markdown），
  // 第二次直接跳过，避免同文双卡。
  _applySummary(md, id) {
    if (!md || md === this._lastSummaryMd) return;
    this._lastSummaryMd = md;
    const a = this._active();
    if (a) {
      // 换装：流式分析卡原地变为总结卡（同 id 不重挂）
      a.type = "summary";
      a.text = md;
      a.done = true;
      a.failed = false;
      this._activeId = null;
    } else {
      // 无活卡（跑过命令，分析卡定格在输出上方）：挂新卡
      this.cards.push({
        id: id != null ? id : ++this._seq, type: "summary", text: md,
        done: true, failed: false,
      });
    }
    this._emit();
  }
}
