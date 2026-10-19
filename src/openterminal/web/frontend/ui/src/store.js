// 卡片流状态机：纯 JS store（不依赖 React，vitest 可直接单测）。
// 事件契约与 worker 的 ServerMsg event kinds 一一对应：
//   task_start / ai_result / ai_collapse / ai_tool / ai_card / final /
//   task_fail / approval_key / decide / rescue / rescue_decide / clear
// 收束补充事件（app.js 布局层发起）：
//   sweep（任务结束扫尾：移除迟到补挂的未完毕卡）/ drop（按 id 移除）
//
// Phase 1「定格一发入魂」契约：ai_result 一次性入完整分析段（出生即完整，
// 挂载后不再变化）；token 批累积（_flushSoon/flushNow）、原地换装、trimMd
// 裁尾已随流式契约删除。progress 心跳由 app.js 徽标层消费，不进卡片状态机。
// React 侧经 useSyncExternalStore(subscribe, getSnapshot) 订阅快照。
//
// Phase 2「命令卡二合一」契约：execute 工具卡与审批卡合并为 command 卡
// （一卡贯穿：执行中 → 等待审批 → ✓/✗/拒绝）。审批消息不再自立新卡，
// 而是 command_card_waiting 给既有命令卡武装按钮（armed）。armed 只经
// command_card_waiting 单点赋值——后端审批循环是顺序 for req: await
// ask_approval（决策 FIFO 消费），若并行命令卡出生即活按钮，点错卡的决策
// 会被另一 req 吃掉=幽灵决策+后一 req 死锁。出生只定 needsApproval（操作行
// 存在性），按钮等 armed 才渲染；常见单命令场景 tool_start 与 approval 同批
// 到达、卡挂载前已武装，观感即出生带按钮。

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
    this._lastSummaryMd = null; // 去重：worker 连发 ai_card(md)+final(md) 同文
    // command_card_waiting 先于 tool_start 到达的暂存（挂载链慢于审批帧时）：
    // 按卡 id 记，落卡即补武装。真机 2026-10-16 冒烟：审批比挂载链快 →
    // 武装落空 → 模态兜底（按钮永不出生）。受理工单：返回 true，卡永不出生
    // 时由 showApproval 可点性看门狗 grace 后转模态兜底
    this._pendingArms = new Map();
    // 任务代数：sweep 只清旧代未完毕卡（新任务的在挂卡不得被上代收束扫掉）
    this._gen = 0;
    this.onDecision = null;  // (decision, stateText, command, cardId) => void（app.js 结账后发 WS + 状态栏）
    this.onRescue = null;    // (accept) => void（app.js 发 rescue 决策 WS）
    this.onNewSession = null; // (cardId) => void（app.js 发 new_session WS + 回车换行）
    this.onDrop = null;      // (ids) => void（app.js 丢弃对应布局槽——整卡消失）
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

  // 按 id 整卡移除（收束路径专用）：返回真正删掉的 id 列表；emit/onDrop 由
  // 调用方统一收口（一次收束只出一份快照、一次 onDrop）
  _remove(ids) {
    if (!ids || !ids.length) return [];
    const dropSet = new Set(ids);
    const dropped = [];
    this.cards = this.cards.filter(c => {
      if (dropSet.has(c.id)) { dropped.push(c.id); return false; }
      return true;
    });
    return dropped;
  }

  // 决策入口（命令卡按钮/快捷键/模态兜底共用）：写回执徽标 + 通知 app.js 发 WS。
  // 按卡 decided 单发守卫（幽灵决策是真事故）；id 缺省时取最新 armed 未决命令卡。
  _decide(kind, edited, id) {
    const card = id != null ? this._card(id)
      : [...this.cards].reverse().find(
        c => c.type === "command" && c.armed && !c.decided && !c.done);
    if (!card || card.type !== "command" || card.decided || card.done) return false;
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
    if (kind === "reject") card.rejected = true; // 终态：tool_end failed 不得覆盖「✗ 已拒绝」
    this._emit();
    // 第 4 个参数是卡 id：app.js 据此在放行决策前先给这张卡结账垫高
    // （worker 收到决策立刻注入命令，输出会把预留区永久盖帽）
    this.onDecision && this.onDecision(decision, st.text, card.command, card.id);
    return true;
  }

  handle(evt) {
    switch (evt.kind) {
      case "task_start": {
        this._lastSummaryMd = null;
        this._pendingArms.clear();   // 跨任务残留的暂存武装作废
        this._gen += 1;              // 新代：旧代收束扫尾不得碰本代卡
        break;
      }
      case "analysis_boot": {
        // Enter 后立即弹分析卡，模型未回前显示「AI 思考中」占位。
        // id 由 app.js 给（与后续 ai_result 同一张、同一个 id）：store 自己
        // 发号会对不上，卡片按 id 挂载找不到就是空白卡。
        if (evt.id == null) return;
        this.cards.push({
          id: evt.id, type: "analysis", gen: this._gen,
          text: "", reason: "", loading: true, done: false,
        });
        this._loadingId = evt.id;
        this._emit();
        break;
      }
      case "ai_result": {
        // 一次性入完整分析段：出生即 done，挂载后高度/行不再变化。
        // 空段（text/reason 均空）后端不会发，前端双保险跳过。
        const text = evt.text || "";
        const reason = evt.reason || "";
        if (!text && !reason) return;
        // 有「AI 思考中」占位卡就就地填满（同一张卡，不另开）
        const boot = this._loadingId != null
          ? this.cards.find(c => c.id === this._loadingId) : null;
        if (boot && boot.loading) {
          boot.text = text;
          boot.reason = reason;
          boot.loading = false;
          boot.done = true;
          boot.failed = !!evt.failed;
          this._loadingId = null;
          this._emit();
          break;
        }
        this.cards.push({
          id: evt.id != null ? evt.id : ++this._seq, type: "analysis", gen: this._gen,
          text, reason, done: true, failed: !!evt.failed,
        });
        this._emit();
        break;
      }
      case "ai_collapse":
        // 事件保留在协议上（CLI 依赖）；Web 侧流式已死，无折叠/裁尾语义
        break;
      case "alert": {
        // 红色警告卡：配置错误（协议二选一冲突/都缺）与系统异常（模型/工具
        // 超时等）统一入口。出生即完整，不参与收束扫尾（done 恒真）。
        const text = evt.text || "";
        if (!text) return;
        this.cards.push({
          id: evt.id != null ? evt.id : ++this._seq, type: "alert",
          text, gen: this._gen, done: true,
        });
        this._emit();
        break;
      }
      case "ai_card":
      case "final":
        // 总结卡只 push（出生即完整）；同文去重防 worker 双发
        this._applySummary(evt.md ?? evt.text ?? "", evt.id);
        break;
      case "tool_start": {
        // execute=命令卡（工具卡+审批卡二合一，状态机见类注释）；
        // 其他工具（read_file 等）保持小工具卡语义：end 置状态徽标。
        const command = evt.command || "";
        const isCmd = !!command || evt.name === "execute";
        const card = isCmd ? {
          id: evt.id != null ? evt.id : ++this._seq, type: "command", gen: this._gen,
          name: evt.name || "", command, args: evt.args || "",
          // 出生判定（过近似）：allowed 只增，中途「始终允许」命中→tool_end
          // 直通 ✓（审批不至→✓ 合法迁移）；操作行存在性由它定，之后不长高
          needsApproval: !!evt.needs_approval,
          reasons: Array.isArray(evt.reasons) ? evt.reasons.join(" · ") : (evt.reasons || ""),
          risk: evt.risk || "",
          armed: false, decided: null, editorOpen: false, rejected: false,
          done: false, failed: false,
        } : {
          id: evt.id != null ? evt.id : ++this._seq, type: "tool", gen: this._gen,
          name: evt.name || "", args: evt.args || "", done: false, failed: false,
        };
        this.cards.push(card);
        // 审批武装先到（挂载链慢于审批帧，真机冒烟实测）：落卡即补武装
        if (this._pendingArms.has(card.id)) {
          const pa = this._pendingArms.get(card.id);
          this._pendingArms.delete(card.id);
          this.handle(Object.assign({kind: "command_card_waiting"}, pa));
        }
        this._emit();
        break;
      }
      case "command_card_waiting": {
        // 审批到达：给既有命令卡武装按钮（不 mount 不垫行——出生即完整，
        // 高度账目不因审批变更）。返回 false=转 app.js 模态兜底。
        const card = this._card(evt.id);
        if (!card) {
          // 卡还没进 store（tool_start 在挂载链上异步落）：暂存受理，
          // 落卡即武装；卡永不出生由可点性看门狗 grace 后转模态兜底
          this._pendingArms.set(evt.id, {
            id: evt.id, command: evt.command,
            reasons: evt.reasons, risk: evt.risk,
          });
          return true;
        }
        if (card.type !== "command") return false;
        if (!card.needsApproval) return false; // 无操作行卡：谓词不可能（birth false→later false），兜底不长高
        if (card.done || card.decided) return true; // 迟到：已收束/已决策，不重开按钮
        if (evt.command && !card.command) card.command = evt.command;
        if (evt.reasons && !card.reasons) {
          card.reasons = Array.isArray(evt.reasons) ? evt.reasons.join(" · ") : evt.reasons;
        }
        if (evt.risk && !card.risk) card.risk = evt.risk;
        // 防御性单武装：同时只允许一张命令卡带活按钮（FIFO 配对靠它兜底）
        for (const c of this.cards) if (c !== card && c.armed && !c.decided) c.armed = false;
        card.armed = true;
        this._emit();
        return true;
      }
      case "tool_end": {
        const card = this._card(evt.id);
        if (!card || (card.type !== "tool" && card.type !== "command") || card.done) return;
        card.done = true;
        card.failed = !!evt.failed;
        this._emit();
        break;
      }
      case "task_fail": {
        let dropped = [];
        if (evt.reason === "interrupt") {
          // Ctrl+C/⏹ 中断零残留：未完毕的卡整卡移除——分析段出生即 done 天然
          // 安全；执行中/等待审批的命令卡随中断移除（今日语义保留：不留半截
          // 「✓已同意·执行中」尸块，rejected/已完成卡是完整回执→保留）
          dropped = this._remove(this.cards
            .filter(c => (c.type === "analysis" || c.type === "tool" || c.type === "command") && !c.done)
            .map(c => c.id));
        } else {
          // 任务中止：未决命令卡按钮悬空（点了也是幽灵决策）→ 一并撤除；
          // 其余未完毕卡标失败，⏳ 不得悬挂到任务结束
          dropped = this._remove(this.cards
            .filter(c => c.type === "command" && !c.done && !c.decided)
            .map(c => c.id));
          for (const c of this.cards) {
            if ((c.type === "tool" || c.type === "command") && !c.done) {
              c.done = true;
              c.failed = true;
            }
          }
        }
        this._emit();
        if (dropped.length) this.onDrop && this.onDrop(dropped);
        break;
      }
      case "sweep": {
        // 收束扫尾（app.js 在挂载链落定后发起）：迟到事件补挂的未完毕卡
        // （tool/command 无 end / analysis 未收束）不许留到任务结束后——整卡移除。
        // 按收束当刻的代数过滤（evt.gen）：新任务的在挂卡（gen > 收束代）不得
        // 被上代收束扫掉（真机 2026-10-17：审批卡刚起挂就被摘 → 转模态）
        const sgen = evt.gen != null ? evt.gen : this._gen;
        const dropped = this._remove(this.cards
          .filter(c => (c.type === "tool" || c.type === "analysis" || c.type === "command")
            && !c.done && (c.gen || 0) <= sgen)
          .map(c => c.id));
        if (dropped.length) {
          this._emit();
          this.onDrop && this.onDrop(dropped);
        }
        break;
      }
      case "drop": {
        // 布局层判定「垫不满＝半截」后按 id 撤卡（连同槽里 island 一起消失）
        const dropped = this._remove(evt.ids || []);
        if (dropped.length) {
          this._emit();
          this.onDrop && this.onDrop(dropped);
        }
        break;
      }
      case "approval_void": {
        // 看门狗转模态：解除按钮武装（同高占位，命令卡保留——它是工具记录）。
        // 快捷键路径随之无 armed 卡，防模态+快捷键双决策。
        const card = this._card(evt.id);
        if (!card) return true;
        if (card.armed && !card.decided) {
          card.armed = false;
          this._emit();
        }
        return true;
      }
      case "decide":
        return this._decide(evt.decision, evt.edited, evt.id);
      case "rescue": {
        // 失败救援：用户命令非零退出，worker 挂卡询问是否交给 AI
        const card = {
          id: evt.id || ++this._seq, type: "rescue", gen: this._gen, line: evt.line || "",
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
        const open = evt.id != null ? this._card(evt.id)
          : [...this.cards].reverse().find(
            c => c.type === "command" && c.armed && !c.decided && !c.done);
        if (!open || open.type !== "command" || open.decided || open.done) return false;
        if (evt.key === "Enter") return this._decide("approve", null, open.id);
        if (evt.key === "e" || evt.key === "E") {
          open.editorOpen = !open.editorOpen;
          this._emit();
          return true;
        }
        if (evt.key === "Backspace") return this._decide("reject", null, open.id);
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
        this._pendingArms.clear();
        this._emit();
        break;
    }
  }

  // 总结卡：只 push 出生即完整的卡（Phase 1 无换装）。
  // 去重：worker 会连发 ai_card(md) 与 final(md)（同一份 markdown），
  // 第二次直接跳过，避免同文双卡。
  _applySummary(md, id) {
    if (!md || md === this._lastSummaryMd) return;
    this._lastSummaryMd = md;
    this.cards.push({
      id: id != null ? id : ++this._seq, type: "summary", gen: this._gen, text: md,
      done: true, failed: false,
    });
    this._emit();
  }
}
