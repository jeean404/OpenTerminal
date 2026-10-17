// CardsStore 单测：卡片流状态机（Phase 1「定格一发入魂」契约）。
// 分析段 ai_result 一次性入完整内容（出生即 done，挂载后高度/行不再变化）；
// token 批累积/原地换装/trimMd 裁尾已随流式契约删除。
// 运行：cd frontend/ui && npm test
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CardsStore } from "../src/store.js";

function make() {
  return new CardsStore();
}

describe("CardsStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("task_start 只重置去重状态，不预建流式分析卡", () => {
    const s = make();
    s.handle({ kind: "task_start", id: 1 });
    expect(s.getSnapshot().cards).toEqual([]);
  });

  it("ai_result 一次性入完整分析段：出生即 done，text/reason/failed 全量入卡", () => {
    const s = make();
    s.handle({ kind: "task_start" });
    s.handle({ kind: "ai_result", id: 7, text: "正文", reason: "推理中", failed: false });
    const c = s.getSnapshot().cards[0];
    expect(c).toMatchObject({
      id: 7, type: "analysis", text: "正文", reason: "推理中",
      done: true, failed: false,
    });
  });

  it("ai_result 空段跳过（text/reason 均空不成卡）", () => {
    const s = make();
    s.handle({ kind: "task_start" });
    s.handle({ kind: "ai_result", text: "", reason: "" });
    s.handle({ kind: "ai_result", failed: true });
    expect(s.getSnapshot().cards).toEqual([]);
  });

  it("ai_result failed 标记落到卡上（limit/error 尾段）", () => {
    const s = make();
    s.handle({ kind: "ai_result", text: "半截", failed: true });
    expect(s.getSnapshot().cards[0]).toMatchObject({ done: true, failed: true });
  });

  it("挂载后快照不再变化：重复读取/时间推进均不动卡内容（高度行数同理）", () => {
    const s = make();
    s.handle({ kind: "ai_result", id: 1, text: "abc", reason: "r" });
    const snap1 = s.getSnapshot().cards[0];
    const before = JSON.stringify(snap1);
    vi.advanceTimersByTime(1000);
    expect(JSON.stringify(s.getSnapshot().cards[0])).toBe(before);
  });

  it("ai_collapse 是 no-op：事件留线（CLI 依赖）但不动卡片", () => {
    const s = make();
    s.handle({ kind: "ai_result", id: 1, text: "abc" });
    const before = JSON.stringify(s.getSnapshot().cards);
    s.handle({ kind: "ai_collapse" });
    expect(JSON.stringify(s.getSnapshot().cards)).toBe(before);
  });

  it("ai_card 挂总结卡（出生即完整）", () => {
    const s = make();
    s.handle({ kind: "ai_card", id: 3, md: "# 总结" });
    expect(s.getSnapshot().cards[0]).toMatchObject(
      { id: 3, type: "summary", text: "# 总结", done: true });
  });

  it("final 挂总结卡；ai_card 与 final 同文连发只出一张（去重）", () => {
    const s = make();
    s.handle({ kind: "ai_card", id: 4, md: "# 总结" });
    s.handle({ kind: "final", id: 4, md: "# 总结" });
    const cards = s.getSnapshot().cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 4, type: "summary" });
  });

  it("task_start 重置去重状态：新一轮同文总结照常成卡", () => {
    const s = make();
    s.handle({ kind: "final", md: "# 总结" });
    s.handle({ kind: "task_start" });
    s.handle({ kind: "final", md: "# 总结" });
    expect(s.getSnapshot().cards).toHaveLength(2);
  });

  it("tool_start 非 execute → 小工具卡；tool_end 徽标收束（卡高不变）", () => {
    const s = make();
    s.handle({ kind: "tool_start", id: "tool1", name: "read_file", args: "a.txt" });
    expect(s.getSnapshot().cards[0]).toMatchObject(
      { id: "tool1", type: "tool", done: false });
    s.handle({ kind: "tool_end", id: "tool1", failed: true });
    expect(s.getSnapshot().cards[0]).toMatchObject(
      { id: "tool1", done: true, failed: true });
    // 幂等：重复 end 不再改状态
    s.handle({ kind: "tool_end", id: "tool1", failed: false });
    expect(s.getSnapshot().cards[0].failed).toBe(true);
  });

  it("tool_start execute → 命令卡（二合一）：出生带 needsApproval/未武装", () => {
    const s = make();
    s.handle({ kind: "tool_start", id: "cmd1", name: "execute",
               command: "ls -la", needs_approval: true, reasons: "敏感路径",
               risk: "high" });
    const c = s.getSnapshot().cards[0];
    expect(c).toMatchObject({
      id: "cmd1", type: "command", command: "ls -la",
      needsApproval: true, armed: false, decided: null, done: false,
    });
  });

  it("命令卡状态机：出生→武装等待审批→✓ 同意；审批不至 tool_end 直通", () => {
    const s = make();
    // ① 出生 → 武装
    s.handle({ kind: "tool_start", id: "cmd1", name: "execute",
               command: "rm -rf /var/log", needs_approval: true });
    expect(s.handle({ kind: "command_card_waiting", id: "cmd1",
                      command: "rm -rf /var/log" })).toBe(true);
    expect(s.getSnapshot().cards[0]).toMatchObject({ armed: true, decided: null });
    // ② 同意 → 回执 + 执行中
    const onDecision = vi.fn();
    s.onDecision = onDecision;
    expect(s.handle({ kind: "decide", decision: "approve", id: "cmd1" })).toBe(true);
    expect(s.getSnapshot().cards[0].decided).toMatchObject(
      { text: "✓ 已同意", cls: "ok" });
    expect(onDecision).toHaveBeenCalledWith(
      { type: "approve" }, "✓ 已同意", "rm -rf /var/log", "cmd1");
    // ③ tool_end 收束
    s.handle({ kind: "tool_end", id: "cmd1", failed: false });
    expect(s.getSnapshot().cards[0]).toMatchObject({ done: true, failed: false });
    // 单发决策守卫：已决策卡不吃二次决策（幽灵决策防线）
    expect(s.handle({ kind: "decide", decision: "reject", id: "cmd1" })).toBe(false);
  });

  it("命令卡状态机：✗ 拒绝 → rejected 终态（tool_end failed 不得覆盖）", () => {
    const s = make();
    s.handle({ kind: "tool_start", id: "cmd1", name: "execute",
               command: "rm -rf /", needs_approval: true });
    s.handle({ kind: "command_card_waiting", id: "cmd1" });
    s.handle({ kind: "decide", decision: "reject", id: "cmd1" });
    expect(s.getSnapshot().cards[0]).toMatchObject({ rejected: true });
    expect(s.getSnapshot().cards[0].decided).toMatchObject(
      { text: "✗ 已拒绝", cls: "fail" });
  });

  it("命令卡：出生判定 needsApproval 假 → 武装失败（无操作行，不长高）", () => {
    const s = make();
    s.handle({ kind: "tool_start", id: "cmd1", name: "execute", command: "ls",
               needs_approval: false });
    expect(s.handle({ kind: "command_card_waiting", id: "cmd1" })).toBe(false);
    expect(s.getSnapshot().cards[0].armed).toBe(false);
  });

  it("command_card_waiting 先于 tool_start：暂存受理，落卡即武装（真机竞态）", () => {
    const s = make();
    // 审批帧比挂载链快（真机 2026-10-16 冒烟实测）：武装先到、卡还没入店
    expect(s.handle({ kind: "command_card_waiting", id: 5,
                      command: "rm -rf /" })).toBe(true);
    expect(s.getSnapshot().cards).toEqual([]);
    // tool_start 落卡 → 自动补武装，按钮照常出生
    s.handle({ kind: "tool_start", id: 5, name: "execute",
               command: "rm -rf /", needs_approval: true });
    const c = s.getSnapshot().cards[0];
    expect(c.armed).toBe(true);
    expect(c.command).toBe("rm -rf /");
    expect(s.handle({ kind: "decide", decision: "approve", id: 5 })).toBe(true);
  });

  it("暂存武装不跨任务：task_start 清空（残留不得给下一张同 id 卡误武装）", () => {
    const s = make();
    s.handle({ kind: "command_card_waiting", id: 5, command: "x" });
    s.handle({ kind: "task_start" });
    s.handle({ kind: "tool_start", id: 5, name: "execute",
               command: "x", needs_approval: true });
    expect(s.getSnapshot().cards[0].armed).toBe(false);
  });

  it("双同串命令按序配对：同时只武装一张（防幽灵决策/死锁）", () => {
    const s = make();
    s.handle({ kind: "tool_start", id: "cmd1", name: "execute",
               command: "echo hi", needs_approval: true });
    s.handle({ kind: "tool_start", id: "cmd2", name: "execute",
               command: "echo hi", needs_approval: true });
    s.handle({ kind: "command_card_waiting", id: "cmd1" });
    s.handle({ kind: "command_card_waiting", id: "cmd2" });
    const [c1, c2] = s.getSnapshot().cards;
    expect(c2.armed).toBe(true);
    expect(c1.armed).toBe(false);   // 防御性单武装：旧卡按钮撤下
    // 决策落在 cmd2（FIFO：后武装者是当前审批）
    s.handle({ kind: "decide", decision: "approve", id: "cmd2" });
    expect(c2.decided).toMatchObject({ text: "✓ 已同意" });
    expect(c1.decided).toBe(null);
  });

  it("tool_end 未知 id 静默：不炸也不入卡", () => {
    const s = make();
    s.handle({ kind: "tool_end", id: "ghost", failed: true });
    expect(s.getSnapshot().cards).toEqual([]);
  });

  it("task_fail 非 interrupt：未决命令卡撤除（按钮悬空），未完毕工具标失败", () => {
    const s = make();
    const dropped = vi.fn();
    s.onDrop = dropped;
    s.handle({ kind: "tool_start", id: "tool1", name: "read_file", args: "a" });
    s.handle({ kind: "tool_start", id: "cmd1", name: "execute",
               command: "rm -rf /", needs_approval: true });
    s.handle({ kind: "command_card_waiting", id: "cmd1", command: "rm -rf /" });
    s.handle({ kind: "task_fail", reason: "error" });
    // 未决命令卡整卡撤除（点了也是幽灵决策）；工具卡标失败收束
    expect(s.getSnapshot().cards.map(c => c.id)).toEqual(["tool1"]);
    expect(s.getSnapshot().cards[0]).toMatchObject(
      { id: "tool1", done: true, failed: true });
    expect(dropped).toHaveBeenCalledWith(["cmd1"]);
  });

  it("task_fail interrupt：未完毕卡整卡移除（含命令卡，零残留）", () => {
    const s = make();
    const dropped = vi.fn();
    s.onDrop = dropped;
    s.handle({ kind: "ai_result", id: 1, text: "完整段" });
    s.handle({ kind: "tool_start", id: "tool1", name: "read_file", args: "a" });
    s.handle({ kind: "tool_start", id: "cmd1", name: "execute",
               command: "rm -rf /", needs_approval: true });
    s.handle({ kind: "task_fail", reason: "interrupt" });
    expect(s.getSnapshot().cards.map(c => c.id)).toEqual([1]);
    expect(dropped).toHaveBeenCalledWith(["tool1", "cmd1"]);
  });

  it("sweep：迟到补挂的未完毕卡整卡移除（已决策卡不受影响）", () => {
    const s = make();
    const dropped = vi.fn();
    s.onDrop = dropped;
    s.handle({ kind: "tool_start", id: "tool1", name: "execute", args: "ls" });
    s.handle({ kind: "tool_start", id: "tool2", name: "execute", args: "pwd" });
    s.handle({ kind: "tool_end", id: "tool2", failed: false });
    s.handle({ kind: "sweep" });
    expect(s.getSnapshot().cards.map(c => c.id)).toEqual(["tool2"]);
    expect(dropped).toHaveBeenCalledWith(["tool1"]);
  });

  it("drop：按 id 撤卡并回调 onDrop", () => {
    const s = make();
    const dropped = vi.fn();
    s.onDrop = dropped;
    s.handle({ kind: "ai_result", id: 1, text: "a" });
    s.handle({ kind: "ai_result", id: 2, text: "b" });
    s.handle({ kind: "drop", ids: [2] });
    expect(s.getSnapshot().cards.map(c => c.id)).toEqual([1]);
    expect(dropped).toHaveBeenCalledWith([2]);
  });

  it("decide 缺省 id：命中最新 armed 未决命令卡（模态/快捷键兜底路径）", () => {
    const s = make();
    const onDecision = vi.fn();
    s.onDecision = onDecision;
    s.handle({ kind: "tool_start", id: 5, name: "execute",
               command: "rm -rf /", needs_approval: true });
    s.handle({ kind: "command_card_waiting", id: 5, command: "rm -rf /" });
    s.handle({ kind: "decide", decision: "approve" });
    const c = s.getSnapshot().cards[0];
    expect(c.decided).toMatchObject({ text: "✓ 已同意", cls: "ok" });
    expect(onDecision).toHaveBeenCalledWith(
      { type: "approve" }, "✓ 已同意", "rm -rf /", 5);
  });

  it("审批决策：edit 替换命令展示编辑后命令，reject 出拒绝回执", () => {
    const s = make();
    s.handle({ kind: "tool_start", id: 5, name: "execute",
               command: "rm -rf /", needs_approval: true });
    s.handle({ kind: "command_card_waiting", id: 5, command: "rm -rf /" });
    s.handle({ kind: "decide", decision: "edit", edited: "rm -rf /tmp/x", id: 5 });
    const c = s.getSnapshot().cards[0];
    expect(c.command).toBe("rm -rf /tmp/x");
    expect(c.decided).toMatchObject({ text: "✎ 已编辑", cls: "edit" });
  });

  it("审批快捷键：Enter=同意、e=编辑框、Backspace=拒绝", () => {
    const s = make();
    s.handle({ kind: "tool_start", id: 5, name: "execute",
               command: "rm -rf /", needs_approval: true });
    s.handle({ kind: "command_card_waiting", id: 5, command: "rm -rf /" });
    expect(s.handle({ kind: "approval_key", key: "e" })).toBe(true);
    expect(s.getSnapshot().cards[0].editorOpen).toBe(true);
    s.handle({ kind: "approval_key", key: "e" });
    expect(s.getSnapshot().cards[0].editorOpen).toBe(false);
    s.handle({ kind: "approval_key", key: "Backspace" });
    expect(s.getSnapshot().cards[0].decided).toMatchObject({ text: "✗ 已拒绝" });
    // 已决策卡不吃快捷键（单次决策守卫）
    expect(s.handle({ kind: "approval_key", key: "Enter" })).toBe(false);
    expect(s.getSnapshot().cards[0].decided.text).toBe("✗ 已拒绝");
  });

  it("救援卡：accept 「✓ 已交给 AI」/ignore「已忽略」，多张只决最新", () => {
    const s = make();
    const onRescue = vi.fn();
    s.onRescue = onRescue;
    s.handle({ kind: "rescue", id: 1, line: "make", ec: 2 });
    s.handle({ kind: "rescue", id: 2, line: "make", ec: 2 });
    s.handle({ kind: "rescue_decide", accept: true });
    expect(s.getSnapshot().cards[1].decided).toMatchObject({ text: "✓ 已交给 AI" });
    expect(s.getSnapshot().cards[0].decided).toBe(null);
    s.handle({ kind: "rescue_decide", accept: false });
    expect(s.getSnapshot().cards[0].decided).toMatchObject({ text: "已忽略" });
    expect(onRescue).toHaveBeenCalledTimes(2);
  });

  it("new_session：本卡回执「✓ 新会话已开启」，重复点击无效", () => {
    const s = make();
    const onNewSession = vi.fn();
    s.onNewSession = onNewSession;
    s.handle({ kind: "final", id: 1, md: "# 总结" });
    expect(s.handle({ kind: "new_session", id: 1 })).toBe(true);
    expect(s.getSnapshot().cards[0].newSession).toBe(true);
    expect(onNewSession).toHaveBeenCalledWith(1);
    expect(s.handle({ kind: "new_session", id: 1 })).toBe(false);
  });

  it("clear：卡片流整体清空", () => {
    const s = make();
    s.handle({ kind: "ai_result", id: 1, text: "a" });
    s.handle({ kind: "final", md: "# 总结" });
    s.handle({ kind: "clear" });
    expect(s.getSnapshot().cards).toEqual([]);
  });

  it("快照不可变：订阅通知与快照引用仅在变更时推进", () => {
    const s = make();
    const listener = vi.fn();
    const unsub = s.subscribe(listener);
    const snap0 = s.getSnapshot();
    s.handle({ kind: "ai_collapse" });   // no-op 不触发订阅
    expect(s.getSnapshot()).toBe(snap0);
    expect(listener).not.toHaveBeenCalled();
    s.handle({ kind: "ai_result", id: 1, text: "a" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot()).not.toBe(snap0);
    unsub();
  });
});
