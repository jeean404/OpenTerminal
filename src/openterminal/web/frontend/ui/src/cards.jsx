// 卡片组件：观感复用主样式表的 .ablock/.scard/.aprobe 类名（同一文档，
// CSS 变量与卡片样式直接继承），仅折叠态/实体底色由 island.css 补充。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// md_lite.js 是 CJS（module.exports 守卫），取默认导出再解构
import mdliteMod from "../../static/md_lite.js";
const { mdLite, stripIncompleteMarkers } = mdliteMod;

export function OneCard({ card, dispatch }) {
  if (!card) return null;
  return <Card card={card} dispatch={dispatch} />;
}

function Card({ card, dispatch }) {
  switch (card.type) {
    case "analysis": return <AnalysisCard card={card} dispatch={dispatch} />;
    case "summary": return <SummaryCard card={card} dispatch={dispatch} />;
    case "approval": return <ApprovalCard card={card} dispatch={dispatch} />;
    case "rescue": return <RescueCard card={card} dispatch={dispatch} />;
    case "tool": return <ToolCard card={card} />;
    default: return null;
  }
}

function Head({ card, label }) {
  // 不可折叠：pad 空行已打进 scrollback 无法回收，折叠只会留下空白块
  // （spec §3.4：fold 机器整体删除）
  return (
    <div className="ahead">
      <span className="adot" />
      <span className="alabel">{label}</span>
    </div>
  );
}

function AnalysisCard({ card, dispatch }) {
  const label = card.failed ? "分析 · 已中止" : "分析";
  // 模型未流式输出任何内容时（未说话即定格），定格后的卡不再显示思考态
  // spinner——任务已结束仍转圈「正在思考」是误导
  const thinking = card.think && !card.done;
  const body = thinking
    ? null
    : { __html: mdLite(stripIncompleteMarkers(card.text)) };
  return (
    <div className={"ablock" + (card.done ? " done" : "") +
                    (thinking ? " think" : "") +
                    (card.failed ? " failed" : "")}>
      <Head card={card} label={label} />
      {thinking
        ? <div className="atext think">AI 正在思考...</div>
        : card.think && !card.reason
          ? <div className="atext">（本次任务无分析输出）</div>
          : <div className="atext">
              {card.reason
                ? <div className="areason">{card.reason}</div>
                : null}
              {card.text
                ? <div dangerouslySetInnerHTML={body} />
                : null}
            </div>}
    </div>
  );
}

function SummaryCard({ card, dispatch }) {
  const body = { __html: mdLite(card.text) };
  return (
    <div className="scard">
      <Head card={card} label="总结" />
      <div className="sbody" dangerouslySetInnerHTML={body} />
      <div className="sfoot">
        {card.newSession
          ? <span className="nsstate">✓ 新会话已开启</span>
          : <button className="nsbtn" title="重置模型上下文，从 0 开始（不清屏）"
                    onClick={() => dispatch({ kind: "new_session", id: card.id })}>
              开启新会话</button>}
      </div>
    </div>
  );
}

function ApprovalCard({ card, dispatch }) {
  const high = card.risk === "high";
  const taRef = useRef(null);
  // 高危执行二次确认:鼠标点「执行」先弹小确认条(防误触),确认才真正放行;
  // 蓝框(normal)一次点击直接执行;键盘快捷键路径不变(刻意按键无误触问题)
  const [confirming, setConfirming] = useState(false);
  const dismiss = () => setConfirming(false);
  const decide = (kind, edited) =>
    dispatch({ kind: "decide", decision: kind, edited });
  const onExecute = () => (high ? setConfirming(v => !v) : decide("approve"));
  return (
    <div className={"acard aprobe" + (high ? " high" : "") +
                    (card.editorOpen ? " edopen" : "")}>
      <div className="aphead">
        {/* 决策后回执徽标原位接管问句槽：问句不再保留（真机反馈：问句+徽标
            同屏冗余）；未决策时才是 问句 + 按钮 布局 */}
        {card.decided
          ? <span className={"apstate " + card.decided.cls}>{card.decided.text}</span>
          : <span className="apq">{high ? "是否同意执行以下高危命令并查看输出？"
                                        : "是否同意执行以下命令并查看输出？"}</span>}
        {!card.decided && (
          <span className="apbtns">
            <span className="apexec">
              <button className="primary" onClick={onExecute}>
                执行 <kbd>Ctrl ↵</kbd></button>
              {confirming && (
                <span className="apconfirm">
                  <span className="apconfirm-q">高危命令，确认执行？</span>
                  <button className="primary" onClick={() => decide("approve")}>
                    确认执行</button>
                  <button onClick={dismiss}>取消</button>
                </span>
              )}
            </span>
            <button onClick={() => { dismiss(); dispatch({ kind: "approval_key", key: "e" }); }}>
              修改 <kbd>Ctrl E</kbd></button>
            <button onClick={() => { dismiss(); decide("reject"); }}>
              拒绝 <kbd>Ctrl ⌫</kbd></button>
            <button className="ghost" onClick={() => { dismiss(); decide("allow"); }}>
              始终允许</button>
          </span>
        )}
      </div>
      <pre className={"apcode" + (card.decided && card.decided.cls === "ok" ? " locked" : "")}>{card.command}</pre>
      {card.reasons ? <div className="apreasons">{card.reasons}</div> : null}
      {card.editorOpen && !card.decided && (
        <EditorCard card={card} taRef={taRef} dispatch={dispatch} />
      )}
    </div>
  );
}

// 失败救援卡：用户命令非零退出后询问是否交给 AI（一键触发救援任务）。
// 复用审批卡交互骨架（.acard/.aphead/.apbtns/.apcode）；决策后回执徽标原位接管
function RescueCard({ card, dispatch }) {
  return (
    <div className="acard aprobe">
      <div className="aphead">
        {card.decided
          ? <span className={"apstate " + card.decided.cls}>{card.decided.text}</span>
          : <span className="apq">这行执行失败了（exit {card.ec}），交给 AI 处理？</span>}
        {!card.decided && (
          <span className="apbtns">
            <button className="primary"
                    onClick={() => dispatch({ kind: "rescue_decide", accept: true })}>
              交给 AI</button>
            <button onClick={() => dispatch({ kind: "rescue_decide", accept: false })}>
              忽略</button>
          </span>
        )}
      </div>
      <pre className="apcode">{card.line}</pre>
      {card.output ? <div className="apreasons">{card.output}</div> : null}
    </div>
  );
}

// 工具调用小卡：AI 任务的文件/检索类工具（read_file/glob/grep 等，execute 走
// 主终端）。头部「调用工具：名」+关键参数+状态徽标（⏳→✓/✗）；橙色系区别
// 审批蓝/高危红。tool_end 只换徽标不增内容 → 卡高不变，零 pad 往返。
function ToolCard({ card }) {
  return (
    <div className="acard aprobe tcard">
      <div className="aphead">
        <span className="apq">调用工具：{card.name}</span>
        {card.done
          ? <span className={"apstate " + (card.failed ? "fail" : "ok")}>
              {card.failed ? "✗ 失败" : "✓ 完成"}</span>
          : null}
      </div>
      {card.args ? <pre className="apcode">{card.args}</pre> : null}
    </div>
  );
}

function EditorCard({ card, taRef, dispatch }) {
  // useState 初值即当前命令：编辑框每次展开都随 editorOpen 重新挂载
  const [val, setVal] = useState(card.command);
  // pane 级底部浮层（portal）：卡内流内渲染会溢出宿主预留行、落到缓冲末行
  // 之下——滚动到不了那里（真机「编辑框溢底部看不到内容」）。浮层与终端流
  // 无关：不碰 pad 账目、关闭不留白空
  const anchorRef = useRef(null);
  const [paneEl, setPaneEl] = useState(null);
  useEffect(() => {
    setPaneEl(anchorRef.current && anchorRef.current.closest(".pane"));
  }, []);
  // 展开即聚焦全选（对齐原 _openEditor 手势）；真机有焦点被终端抢回/portal
  // 晚一帧挂载：重试数次直到真落地
  useEffect(() => {
    if (!paneEl) return;
    let n = 0;
    const tryFocus = () => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      if (document.activeElement === ta) { ta.select(); return; }
      if (n++ < 8) setTimeout(tryFocus, 60);
    };
    tryFocus();
  }, [paneEl]);
  const save = () => {
    const cmd = val.trim();
    if (cmd) dispatch({ kind: "decide", decision: "edit", edited: cmd });
  };
  return (
    <>
      <span ref={anchorRef} hidden />
      {paneEl ? createPortal(
        <div className="apedit">
          <textarea ref={taRef} rows="2" spellCheck="false" autoFocus value={val}
                    onChange={e => setVal(e.target.value)} />
          <div className="apedit-btns">
            <button className="primary" onClick={save}>保存并执行</button>
            <button onClick={() => dispatch({ kind: "approval_key", key: "e" })}>取消</button>
          </div>
        </div>, paneEl) : null}
    </>
  );
}
