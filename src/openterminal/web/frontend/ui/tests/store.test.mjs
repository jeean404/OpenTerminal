// CardsStore 单测：卡片流状态机（换装/定格/审批决策/快捷键）。
// 运行：cd frontend/ui && npm test
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CardsStore } from "../src/store.js";

function make() {
  const s = new CardsStore();
  vi.useFakeTimers();
  return s;
}

describe("CardsStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("task_start 建 think 卡，首个 token 转流式", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 1 });
    expect(s.getSnapshot().cards[0]).toMatchObject({ id: 1, type: "analysis", think: true });
    s.handle({ kind: "ai_token", text: "正在检查" });
    vi.runAllTimers();
    const c = s.getSnapshot().cards[0];
    expect(c.think).toBe(false);
    expect(c.text).toBe("正在检查");
  });

  it("ai_think 思考流式入卡：转流式态、累进 reason、不占 text", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 2 });
    s.handle({ kind: "ai_think", text: "先看磁盘" });
    vi.runAllTimers();
    const c = s.getSnapshot().cards[0];
    expect(c.think).toBe(false);
    expect(c.reason).toBe("先看磁盘");
    expect(c.text).toBe("");
    // 后续正文 token 照常进 text，思考不混入
    s.handle({ kind: "ai_token", text: "正文" });
    vi.runAllTimers();
    expect(s.getSnapshot().cards[0].reason).toBe("先看磁盘");
    expect(s.getSnapshot().cards[0].text).toBe("正文");
  });

  it("token 批冲刷：多次 token 合并一次出快照", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 3 });
    const spy = vi.fn();
    s.subscribe(spy);
    spy.mockClear();
    s.handle({ kind: "ai_token", text: "a" });
    s.handle({ kind: "ai_token", text: "b" });
    vi.runAllTimers();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot().cards[0].text).toBe("ab");
  });

  it("ai_card 换装：活分析卡原地变总结卡（同 id）", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 4 });
    s.handle({ kind: "ai_token", text: "分析中" });
    const id = s.getSnapshot().cards[0].id;
    s.handle({ kind: "ai_card", md: "| 列 |\n| --- |\n| 值 |" });
    const c = s.getSnapshot().cards[0];
    expect(c.id).toBe(id);
    expect(c.type).toBe("summary");
    expect(c.text).toContain("| 列 |");
    expect(c.done).toBe(true);
  });

  it("收束后 final 只定格，总结由 ai_card 携 id 挂载（不回旧卡）", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 5 });
    s.handle({ kind: "ai_think", text: "思考" });
    s.handle({ kind: "ai_collapse" });            // 首个命令执行 → 分析卡定格
    s.handle({ kind: "final", md: "# 总结" });     // 无活卡：只定格，不挂卡
    let cards = s.getSnapshot().cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 5, type: "analysis", done: true, reason: "思考" });
    expect(cards[0].zone).toBeUndefined();
    s.handle({ kind: "ai_card", md: "# 总结", id: 6 });  // 新 id 挂载
    cards = s.getSnapshot().cards;
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ id: 6, type: "summary", text: "# 总结" });
    expect(cards[1].zone).toBeUndefined();
    expect(cards[0].type).toBe("analysis");       // 分析卡整卡长留
  });

  it("未收束（纯问答）final 原地换装，ai_card 同文去重", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 7 });
    s.handle({ kind: "ai_token", text: "答案" });
    const id = s.getSnapshot().cards[0].id;
    s.handle({ kind: "final", md: "# 答案" });
    let cards = s.getSnapshot().cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id, type: "summary", text: "# 答案" });
    expect(cards[0].zone).toBeUndefined();
    s.handle({ kind: "ai_card", md: "# 答案", id: 8 });  // 去重：不再新挂
    expect(s.getSnapshot().cards).toHaveLength(1);
  });

  it("final 无活卡只定格不挂卡，总结由 ai_card 挂载", () => {
    const s = new CardsStore();
    s.handle({ kind: "final", md: "# 结论" });
    expect(s.getSnapshot().cards).toHaveLength(0);   // 等 ai_card 携 id 挂载
    s.handle({ kind: "ai_card", md: "# 结论", id: 9 });
    expect(s.getSnapshot().cards).toHaveLength(1);
    expect(s.getSnapshot().cards[0].type).toBe("summary");
    expect(s.getSnapshot().cards[0].id).toBe(9);
    expect(s.getSnapshot().cards[0].zone).toBeUndefined();
  });

  it("task_fail 定格分析卡为失败", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 10 });
    s.handle({ kind: "ai_token", text: "部分" });
    vi.runAllTimers();
    s.handle({ kind: "task_fail", reason: "limit" });
    const c = s.getSnapshot().cards[0];
    expect(c.done).toBe(true);
    expect(c.failed).toBe(true);
  });

  it("审批：决策写回执并回调 app.js", () => {
    const s = new CardsStore();
    const onDecision = vi.fn();
    s.onDecision = onDecision;
    s.handle({ kind: "approval", id: 11, command: "rm -rf /tmp/x", reasons: "删除", risk: "high" });
    s.handle({ kind: "decide", decision: "approve" });
    const c = s.getSnapshot().cards[0];
    expect(c.decided).toEqual({ text: "✓ 已同意", cls: "ok" });
    // 第 4 个参数是卡 id：app.js 要在放行决策前先给这张卡结账垫高
    expect(onDecision).toHaveBeenCalledWith({ type: "approve" }, "✓ 已同意", "rm -rf /tmp/x", 11);
  });

  it("审批 edit 决策：回执命令替换为编辑后命令", () => {
    const s = new CardsStore();
    s.handle({ kind: "approval", id: 12, command: "ls -la", reasons: "", risk: "normal" });
    s.handle({ kind: "decide", decision: "edit", edited: "ls -lh" });
    const c = s.getSnapshot().cards[0];
    expect(c.command).toBe("ls -lh");
    expect(c.decided.cls).toBe("edit");
  });

  it("快捷键：Enter 同意 / Backspace 拒绝 / E 切编辑框", () => {
    const s = new CardsStore();
    s.handle({ kind: "approval", id: 13, command: "systemctl restart x", reasons: "", risk: "high" });
    s.handle({ kind: "approval_key", key: "e" });
    expect(s.getSnapshot().cards[0].editorOpen).toBe(true);
    s.handle({ kind: "approval_key", key: "Backspace" });
    expect(s.getSnapshot().cards[0].decided.text).toBe("✗ 已拒绝");
  });

  it("救援：非零退出挂卡，accept 写回执并回调 app.js", () => {
    const s = new CardsStore();
    const onRescue = vi.fn();
    s.onRescue = onRescue;
    s.handle({ kind: "rescue", id: 21, line: "帮我把ll=ls -al设置永久", ec: 127,
               output: "-bash: 帮我把ll=ls: command not found" });
    const c = s.getSnapshot().cards[0];
    expect(c.type).toBe("rescue");
    expect(c.line).toBe("帮我把ll=ls -al设置永久");
    expect(c.ec).toBe(127);
    expect(c.decided).toBeNull();
    s.handle({ kind: "rescue_decide", accept: true });
    const c2 = s.getSnapshot().cards[0];
    expect(c2.decided).toEqual({ text: "✓ 已交给 AI", cls: "ok" });
    expect(onRescue).toHaveBeenCalledWith(true);
  });

  it("救援：ignore 决策写失败回执，回调 false", () => {
    const s = new CardsStore();
    const onRescue = vi.fn();
    s.onRescue = onRescue;
    s.handle({ kind: "rescue", id: 22, line: "gti status", ec: 1, output: "" });
    s.handle({ kind: "rescue_decide", accept: false });
    const c = s.getSnapshot().cards[0];
    expect(c.decided).toEqual({ text: "已忽略", cls: "fail" });
    expect(onRescue).toHaveBeenCalledWith(false);
  });

  it("救援：多张未决卡时只决策最新一张（与审批同规则）", () => {
    const s = new CardsStore();
    s.handle({ kind: "rescue", id: 23, line: "foo", ec: 1 });
    s.handle({ kind: "rescue", id: 24, line: "bar", ec: 2 });
    s.handle({ kind: "rescue_decide", accept: true });
    const cards = s.getSnapshot().cards;
    expect(cards[0].decided).toBeNull();
    expect(cards[1].decided.text).toBe("✓ 已交给 AI");
  });

  it("clear 清空全部卡片", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 14 });
    s.handle({ kind: "approval", id: 15, command: "x", reasons: "", risk: "high" });
    s.handle({ kind: "clear" });
    expect(s.getSnapshot().cards).toHaveLength(0);
  });

  it("折叠机制已删除：卡片无 collapsed 字段，toggle 是 no-op（spec §3.4/§8）", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 16 });          // 分析卡（流式）
    s.handle({ kind: "ai_collapse" });                 // 冻结 → 无活卡
    s.handle({ kind: "ai_card", md: "结论", id: 17 });  // 独立总结卡
    const cards = s.getSnapshot().cards;
    expect(cards.map(c => c.type)).toEqual(["analysis", "summary"]);
    for (const c of cards) expect(c.collapsed).toBeUndefined();
    s.handle({ kind: "toggle", id: 16 });   // 旧事件不再有任何效果
    s.handle({ kind: "toggle", id: 17 });
    expect(s.getSnapshot().cards.map(c => c.collapsed))
      .toEqual([undefined, undefined]);
  });

  it("task_start 用调用方给定 id，不再有 zone 字段", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 42 });
    const c = s.getSnapshot().cards[0];
    expect(c.id).toBe(42);
    expect(c.zone).toBeUndefined();
  });

  it("ai_collapse 带 trimMd：裁掉流进分析卡的总结正文尾（防同文重复）", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 18 });
    s.handle({ kind: "ai_token", text: "先看进程。" });
    s.handle({ kind: "ai_token", text: "# 系统资源占用总览\n\n| 项目 | 数值 |\n| --- | --- |\n| CPU | 0% |" });
    vi.runAllTimers();
    s.handle({ kind: "ai_collapse", trimMd: "# 系统资源占用总览\n\n| 项目 | 数值 |\n| --- | --- |\n| CPU | 0% |" });
    const c = s.getSnapshot().cards[0];
    expect(c.done).toBe(true);
    expect(c.text).toBe("先看进程。");   // 叙事保留，总结尾裁掉
    expect(c.text).not.toContain("系统资源占用总览");
  });

  it("ai_collapse trimMd 不匹配（卡不以总结文结尾）时不动正文", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 19 });
    s.handle({ kind: "ai_token", text: "叙事与总结文无尾随关系" });
    vi.runAllTimers();
    s.handle({ kind: "ai_collapse", trimMd: "# 另一份总结" });
    expect(s.getSnapshot().cards[0].text).toBe("叙事与总结文无尾随关系");
  });

  it("ai_collapse trimMd 裁前先冲 100ms 尾批（缓冲里的 token 也参与匹配）", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 20 });
    s.handle({ kind: "ai_token", text: "开头" });
    s.handle({ kind: "ai_token", text: "# 总结正文" });   // 留在 100ms 批缓冲里
    s.handle({ kind: "ai_collapse", trimMd: "# 总结正文" });
    const c = s.getSnapshot().cards[0];
    expect(c.text).toBe("开头");   // 未 runAllTimers：flushNow 先冲再裁
  });

  it("tool_start 挂工具卡（不占 _activeId），tool_end 同 id 置状态徽标", () => {
    const s = new CardsStore();
    s.handle({ kind: "task_start", id: 30 });
    s.handle({ kind: "ai_think", text: "读文件" });
    s.handle({ kind: "ai_collapse" });                  // 分析卡定格
    s.handle({ kind: "tool_start", id: "tool1", name: "read_file", args: "notes.txt" });
    let cards = s.getSnapshot().cards;
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ id: "tool1", type: "tool",
      name: "read_file", args: "notes.txt", done: false, failed: false });
    // 工具卡不占流式位：后续 token 开新分析卡，不写进工具卡
    s.handle({ kind: "tool_end", id: "tool1" });
    s.handle({ kind: "ai_token", text: "读到了" });     // 无 ai_collapse 不会到这，仅防御
    vi.runAllTimers();
    cards = s.getSnapshot().cards;
    expect(cards[1]).toMatchObject({ id: "tool1", done: true, failed: false });
    expect(cards[0].done).toBe(true);                    // ai_collapse 已定格分析卡
  });

  it("tool_end failed 置失败徽标；未知 id 静默", () => {
    const s = new CardsStore();
    s.handle({ kind: "tool_start", id: "tool2", name: "grep", args: "pattern" });
    s.handle({ kind: "tool_end", id: "tool2", failed: true });
    expect(s.getSnapshot().cards[0]).toMatchObject({ done: true, failed: true });
    s.handle({ kind: "tool_end", id: "nope" });          // 不炸不挂卡
    expect(s.getSnapshot().cards).toHaveLength(1);
  });

  it("task_fail 把未决工具卡标失败（⏳ 不得悬挂到任务结束）", () => {
    const s = new CardsStore();
    s.handle({ kind: "tool_start", id: "tool3", name: "read_file", args: "x" });
    s.handle({ kind: "tool_start", id: "tool4", name: "ls", args: "." });
    s.handle({ kind: "tool_end", id: "tool4" });
    s.handle({ kind: "task_fail", reason: "error" });
    const cards = s.getSnapshot().cards;
    expect(cards[0]).toMatchObject({ id: "tool3", done: true, failed: true });
    expect(cards[1]).toMatchObject({ id: "tool4", done: true, failed: false });
  });

  it("task_fail interrupt：流式未完毕卡整卡移除，已收束卡留下", () => {
    // 用户诉求：Ctrl+C 时未渲染完毕的卡不显示半截——活流卡/在跑工具卡整卡
    // 消失；已收束的分析卡与已完成工具卡是完整卡，保留
    const s = new CardsStore();
    const onDrop = vi.fn();
    s.onDrop = onDrop;
    s.handle({ kind: "task_start", id: 40 });
    s.handle({ kind: "ai_think", text: "第一段" });
    s.handle({ kind: "ai_collapse" });                  // 分析卡 40 定格（已收束）
    s.handle({ kind: "tool_start", id: "tool5", name: "execute", args: "ls" });
    s.handle({ kind: "tool_end", id: "tool5" });        // 工具完成（✓）
    s.handle({ kind: "tool_start", id: "tool6", name: "execute", args: "cat x" });  // 在跑
    s.handle({ kind: "task_start", id: 41 });           // 阶段二流式卡（未完毕）
    s.handle({ kind: "ai_token", text: "半截" });
    vi.runAllTimers();
    s.handle({ kind: "task_fail", reason: "interrupt" });
    expect(s.getSnapshot().cards.map(c => c.id)).toEqual([40, "tool5"]);
    expect(onDrop).toHaveBeenCalledWith(expect.arrayContaining(["tool6", 41]));
  });

  it("task_fail interrupt：未决审批卡一并撤除，已决策留回执", () => {
    const s = new CardsStore();
    s.handle({ kind: "approval", id: 51, command: "rm x", reasons: "", risk: "high" });
    s.handle({ kind: "decide", decision: "reject" });   // 已决策：回执长留
    s.handle({ kind: "approval", id: 50, command: "ls", reasons: "", risk: "normal" });
    s.handle({ kind: "task_fail", reason: "interrupt" });
    const cards = s.getSnapshot().cards;
    expect(cards.map(c => c.id)).toEqual([51]);          // 未决 50 撤除
    expect(cards[0].decided.text).toBe("✗ 已拒绝");
  });

  it("sweep 移除迟到补挂的未完毕卡（tool 无 end / analysis 未收束）", () => {
    const s = new CardsStore();
    const onDrop = vi.fn();
    s.onDrop = onDrop;
    s.handle({ kind: "task_start", id: 42 });
    s.handle({ kind: "ai_collapse" });                  // 已收束：留下
    s.handle({ kind: "tool_start", id: "tool7", name: "execute", args: "ls" });  // 无 end
    s.handle({ kind: "task_start", id: 43 });           // 迟到 zombie 流式卡
    s.handle({ kind: "sweep" });
    expect(s.getSnapshot().cards.map(c => c.id)).toEqual([42]);
    expect(onDrop).toHaveBeenCalledWith(expect.arrayContaining(["tool7", 43]));
  });

  it("drop 按 id 撤卡并回调 onDrop", () => {
    const s = new CardsStore();
    const onDrop = vi.fn();
    s.onDrop = onDrop;
    s.handle({ kind: "tool_start", id: "tool8", name: "execute", args: "ls" });
    s.handle({ kind: "tool_end", id: "tool8" });
    s.handle({ kind: "drop", ids: ["tool8"] });
    expect(s.getSnapshot().cards).toHaveLength(0);
    expect(onDrop).toHaveBeenCalledWith(["tool8"]);
  });
});
