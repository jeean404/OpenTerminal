// 卡片组件：观感复用主样式表的 .ablock/.scard/.aprobe 类名（同一文档，
// CSS 变量与卡片样式直接继承），仅折叠态/实体底色由 island.css 补充。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// md_lite.js 是 CJS（module.exports 守卫），取默认导出再解构
import mdliteMod from "../../static/md_lite.js";
const { mdLiteBlocks, stripIncompleteMarkers } = mdliteMod;

export function OneCard({ card, dispatch }) {
  if (!card) return null;
  return <Card card={card} dispatch={dispatch} />;
}

function Card({ card, dispatch }) {
  switch (card.type) {
    case "analysis": return <AnalysisCard card={card} dispatch={dispatch} />;
    case "summary": return <SummaryCard card={card} dispatch={dispatch} />;
    case "command": return <CommandCard card={card} dispatch={dispatch} />;
    case "rescue": return <RescueCard card={card} dispatch={dispatch} />;
    case "tool": return <ToolCard card={card} />;
    case "alert": return <AlertCard card={card} />;
    default: return null;
  }
}

// 红色警告卡：配置错误/系统异常（模型超时、工具超时等）统一展示。
// 出生即完整（无打字机），红框 + ⚠ 头 + 错误正文（等宽，保留缩进）。
function AlertCard({ card }) {
  return (
    <div className="acard aprobe alertcard">
      <div className="aphead">
        <span className="apq">⚠ 系统警告</span>
      </div>
      <pre className="apcode">{card.text}</pre>
    </div>
  );
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

// 正文按块渲染：每块一个 .ablk（opacity 打字机，--i 逐块延迟）。
// 列表/表格在 mdLiteBlocks 内聚成整块，此处不再拆散。
// 流式打字机：把已到手的整段文本按块逐字揭示。块布局下卡片长高只是把下面
// 的内容往下推（没有占位行/夹紧那套），所以「边打字边长高」是安全的——
// 这正是原来做不到流式的根本原因，现在可以做了。
function useTypewriter(src, on) {
  const text = src || "";
  const [n, setN] = useState(on ? 0 : text.length);
  useEffect(() => {
    if (!on) { setN(text.length); return undefined; }
    if (!text.length) { setN(0); return undefined; }
    setN(0);
    let i = 0;
    const step = Math.max(2, Math.ceil(text.length / 55));   // 约 55 帧播完
    const t = setInterval(() => {
      i = Math.min(text.length, i + step);
      setN(i);
      if (i >= text.length) clearInterval(t);
    }, 22);
    return () => clearInterval(t);
  }, [text, on]);
  return text.slice(0, n);
}

// typed=true 时按打字机揭示（只在卡片首次成型时打一次，之后不再重播）
function Typed({ src, on, children }) {
  const shown = useTypewriter(src, on);
  return children(shown);
}

function Blocks({ src, strip, base = 0, typed }) {
  const shown = useTypewriter(src, typed);
  return mdLiteBlocks(strip ? stripIncompleteMarkers(shown) : shown).map((b, i) => (
    <div
      key={i}
      className="ablk"
      style={{ "--i": base + i }}
      dangerouslySetInnerHTML={{ __html: b }}
    />
  ));
}

function AnalysisCard({ card, dispatch }) {
  const label = card.failed ? "分析 · 已中止" : "分析";
  // 「AI 思考中」加载态：Enter 后卡片立即弹出，模型未回前先占住位
  if (card.loading) {
    return (
      <div className="ablock think">
        <Head card={card} label={label} />
        <div className="atext think">AI 思考中</div>
      </div>
    );
  }
  // 思考过程一律默认折叠（用户决策）：不管有没有结论都收起
  return (
    <div className={"ablock" + (card.done ? " done" : "") +
                    (card.failed ? " failed" : "")}>
      <Head card={card} label={label} />
      <div className="atext">
        {card.reason
          ? <details className="areason-wrap ablk" style={{ "--i": 0 }}>
              <summary>思考过程</summary>
              <div className="areason">{card.reason}</div>
            </details>
          : null}
        {card.text
          ? <Blocks src={card.text} strip base={card.reason ? 1 : 0} typed={!card.noType} />
          : null}
      </div>
    </div>
  );
}

function SummaryCard({ card, dispatch }) {
  return (
    <div className="scard">
      <Head card={card} label="总结" />
      <div className="sbody"><Blocks src={card.text} typed={!card.noType} /></div>
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

// Phase 2 命令卡：execute 工具卡 + 审批卡二合一，一卡贯穿全程。
// 四行全定高（name/命令/状态/操作），挂载后高度/行不再变化（红线④）：
//   ▸ execute
//   $ 完整 command           （定高 2 行，溢出截断 + title 全文）
//   ⚠ 高危 · {理由} · {状态}  （定高 1 行，理由槽出生即占位——空也渲染）
//   [执行][修改][拒绝][始终允许]（定高 1 行；回执同高替换按钮簇，截断+title）
// 操作行存在性由出生判定（needsApproval 假的卡永不长出操作行）；按钮只在
// armed（command_card_waiting 到达）后渲染——后端审批循环顺序 await 决策，
// 并行命令出生即活按钮会把决策发错卡（幽灵决策/死锁），见 store 类注释。
// 高危两步确认是操作行内绝对定位浮层（.apconfirm），不参与行高。
function CommandCard({ card, dispatch }) {
  const high = card.risk === "high";
  // 高危执行二次确认:鼠标点「执行」先弹小确认条(防误触),确认才真正放行;
  // 蓝框(normal)一次点击直接执行;键盘快捷键路径不变(刻意按键无误触问题)
  const [confirming, setConfirming] = useState(false);
  const dismiss = () => setConfirming(false);
  const decide = (kind, edited) =>
    dispatch({ kind: "decide", id: card.id, decision: kind, edited });
  const onExecute = () => (high ? setConfirming(v => !v) : decide("approve"));

  // 状态徽标：紧挨「调用工具：名」只显一次（真机：拒绝态曾在头/尾重复显）
  let stateText, stCls = "";
  if (card.rejected) { stateText = "✗ 已拒绝"; stCls = "rejected"; }
  else if (card.done) {
    stateText = card.failed ? "✗ 失败" : "✓ 完成";
    stCls = card.failed ? "fail" : "ok";
  } else if (card.decided) {
    stateText = "执行中…";
  } else {
    stateText = card.needsApproval ? "等待审批" : "执行中…";
    if (card.needsApproval) stCls = "waiting";
  }
  const live = card.armed && !card.decided && !card.done;
  const reasonLine = [high ? "⚠ 高危" : "", card.reasons || ""]
    .filter(Boolean).join(" · ");

  // 决策回执（右上角）：与状态徽标同文则不显（真机「已拒绝×2」）
  const receiptText = card.decided ? card.decided.text : "";
  const showReceipt = !!receiptText && receiptText !== stateText;

  // 卡片配色随状态（真机约定）：等待红 / 编辑橙 / 拒绝灰 / 完成绿 / 失败红
  let colorCls = "";
  if (card.editorOpen ||
      (card.decided && card.decided.cls === "edit" && !card.done && !card.rejected))
    colorCls = "editing";
  else if (card.rejected) colorCls = "rejected";
  else if (card.done) colorCls = card.failed ? "failed" : "done";
  else if (card.needsApproval && !card.decided) colorCls = "waiting";

  return (
    <div className={"acard aprobe cmdcard " + colorCls +
                    (high ? " high" : "") +
                    (card.editorOpen ? " edopen" : "")}>
      <div className="aphead cmdhead">
        <span className="adot" />
        <span className="alabel">调用工具：{card.name || "execute"}</span>
        <span className={"apstate " + stCls}>{stateText}</span>
        {/* 审批按钮簇：卡头右侧、执行为 primary 主按钮（高危红）。
            .cmdacts 定高槽：按钮簇→回执同高替换，卡高不变（红线④） */}
        {card.needsApproval
          ? <div className="cmdacts">
              {live
                ? <span className="apbtns">
                    <span className="apexec">
                      <button className="primary" onClick={onExecute}>
                        执行 <kbd>Ctrl ↵</kbd></button>
                      {confirming && (
                        <HighRiskConfirm onConfirm={() => decide("approve")} onCancel={dismiss} />
                      )}
                    </span>
                    <button onClick={() => { dismiss(); dispatch({ kind: "approval_key", id: card.id, key: "e" }); }}>
                      修改 <kbd>Ctrl E</kbd></button>
                    <button onClick={() => { dismiss(); decide("reject"); }}>
                      拒绝 <kbd>Ctrl ⌫</kbd></button>
                    <button className="ghost" title="本会话内同判定命令直接放行"
                            onClick={() => { dismiss(); decide("allow"); }}>
                      始终允许</button>
                  </span>
                : showReceipt
                  ? <span className={"apreceipt " + (card.decided ? card.decided.cls : "")}
                          title={receiptText}>
                      {receiptText}
                    </span>
                  : null}
            </div>
          : null}
      </div>
      <pre className="apcode cmdcode" title={card.command || card.args}>
        $ {card.command || card.args}
      </pre>
      {/* 状态行定高：理由槽出生即占位（空也渲染）；状态徽标已挪卡头，此处只留理由 */}
      <div className="cmdstat" title={reasonLine}>
        <span className="cmdreason">{reasonLine}</span>
      </div>
      {card.editorOpen && !card.decided && (
        <EditorCard card={card} dispatch={dispatch} />
      )}
    </div>
  );
}

// 保留按钮下方、按内容宽度的小确认框；只在靠近终端边缘时平移避让。
function HighRiskConfirm({ onConfirm, onCancel }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const popup = ref.current;
    const boundary = popup && (popup.closest(".ot-stage") || popup.closest(".pane"));
    if (!popup || !boundary) return undefined;
    const place = () => {
      const bounds = boundary.getBoundingClientRect();
      const left = bounds.left + 8;
      const right = bounds.left + boundary.clientWidth - 8;
      popup.style.maxWidth = Math.max(0, right - left) + "px";
      popup.style.transform = "none";
      const rect = popup.getBoundingClientRect();
      const x = Math.max(left, Math.min(rect.left, right - rect.width));
      popup.style.transform = `translateX(${x - rect.left}px)`;
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (ro) { ro.observe(boundary); ro.observe(popup); }
    window.addEventListener("resize", place);
    return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", place); };
  }, []);
  return (
    <span className="apconfirm" ref={ref}>
      <span className="apconfirm-q">高危命令，确认执行？</span>
      <button className="primary" onClick={onConfirm}>确认执行</button>
      <button onClick={onCancel}>取消</button>
    </span>
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
// 命令卡）。头部「调用工具：名」+关键参数+状态徽标（⏳→✓/✗）；橙色系区别
// 审批蓝/高危红。tool_end 只换徽标不增内容 → 卡高不变，零 pad 往返。
function ToolCard({ card }) {
  return (
    <div className={"acard aprobe tcard" +
                    (card.done ? (card.failed ? " failed" : " done") : "")}>
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

function EditorCard({ card, dispatch }) {
  // useState 初值即当前命令：编辑框每次展开都随 editorOpen 重新挂载
  const [val, setVal] = useState(card.command);
  // pane 级底部浮层（portal）：卡内流内渲染会溢出宿主预留行、落到缓冲末行
  // 之下——滚动到不了那里（真机「编辑框溢底部看不到内容」）。浮层与终端流
  // 无关：不碰 pad 账目、关闭不留白空
  const anchorRef = useRef(null);
  const taRef = useRef(null);
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
    if (cmd) dispatch({ kind: "decide", id: card.id, decision: "edit", edited: cmd });
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
            <button onClick={() => dispatch({ kind: "approval_key", id: card.id, key: "e" })}>取消</button>
          </div>
        </div>, paneEl) : null}
    </>
  );
}
