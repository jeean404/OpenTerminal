// 组件渲染回归（真机 2026-10-16 冒烟）：CommandCard 武装分支曾用
// <React.Fragment> 而 cards.jsx 只具名 import hooks——自动 JSX 运行时不注入
// React，armed 一渲染就 "React is not defined" 炸掉整岛（宿主空壳 + 审批
// 永远走模态兜底）。store 单测不渲染组件，抓不到；这里用 renderToString
//（SSR，无需 jsdom）把各分支真实渲一遍。
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { OneCard } from "../src/cards.jsx";

const noop = () => {};

const cmdCard = (over = {}) => ({
  id: 1, type: "command", name: "execute", command: "rm -rf /var/log",
  args: "", needsApproval: true, reasons: "⚠ 高危 · 删除文件",
  risk: "high", armed: true, decided: null, editorOpen: false,
  rejected: false, done: false, failed: false,
  ...over,
});

describe("CommandCard 渲染（armed 分支不得炸岛）", () => {
  it("武装态渲染完整按钮簇（执行/修改/拒绝/始终允许）", () => {
    const html = renderToString(<OneCard card={cmdCard()} dispatch={noop} />);
    expect(html).toContain("cmdcard");
    expect(html).toContain("执行");
    expect(html).toContain("修改");
    expect(html).toContain("拒绝");
    expect(html).toContain("始终允许");
  });

  it("未武装渲染同高回执行槽、无活按钮", () => {
    const html = renderToString(
      <OneCard card={cmdCard({armed: false})} dispatch={noop} />);
    expect(html).toContain("cmdcard");
    expect(html).toContain("等待审批");
    expect(html).not.toContain("始终允许");
  });

  it("已拒绝态出 ✗ 回执（终态不被 tool_end 覆盖）", () => {
    const html = renderToString(
      <OneCard card={cmdCard({rejected: true, decided: {text: "✗ 已拒绝", cls: "fail"}})}
               dispatch={noop} />);
    expect(html).toContain("已拒绝");
    expect(html).not.toContain("始终允许");
  });

  it("完成态出 ✓/✗ 徽标", () => {
    const html = renderToString(
      <OneCard card={cmdCard({done: true, failed: true, armed: false,
                              decided: {text: "✓ 已同意", cls: "ok"}})}
               dispatch={noop} />);
    expect(html).toContain("失败");
  });

  it("普通工具卡/分析卡/总结卡渲染不炸", () => {
    const tool = {id: 2, type: "tool", name: "read_file", args: "a", done: true, failed: false};
    const analysis = {id: 3, type: "analysis", text: "正文", reason: "推理",
                      done: true, failed: false};
    const summary = {id: 4, type: "summary", text: "# 总结", done: true};
    for (const c of [tool, analysis, summary]) {
      expect(() => renderToString(<OneCard card={c} dispatch={noop} />)).not.toThrow();
    }
  });
});
