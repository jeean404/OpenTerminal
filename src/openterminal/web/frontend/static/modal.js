// 通用模态框：从 app.js 抽出独立成文件，node --test 可直接加载
// （module.exports 守卫，照 md_lite.js / pad_ledger.js 的先例）。
//
// 两个不变量（都是真机踩出来的）：
//
//  1. **代际号**：嵌套开窗时（如 TOFU 确认框顶掉登录框）旧 close 不得清掉
//     新窗。每个 modalShell 拿一个自增号，close 只在自己仍是最新时清 DOM。
//     缺了它，下面 async onClick 的修复会把刚开的 TOFU 确认框清空——表现
//     为「点了连接就没反应」（确认框开了又被旧 close 抹掉）。
//
//  2. **onClick 可 async**：返回 Promise 时等结果再决定关不关（返回 false
//     = 不关）。旧实现 `b.onClick() !== false` 对 Promise 恒为真，弹窗必关
//     ——删除失败/保存失败想留框都做不到。同步返回 false 的旧行为不变。
//
// Enter 提交对 `.modal` 内任意 input/select 生效，**textarea 除外**：编辑器
// （.fp-edit）里按 Enter 是换行，不能被提交关窗。

function _esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

let _modalSeq = 0;

// buttons: [{label, primary?, onClick() -> bool|Promise<bool>(false=不关窗)}]
function modalShell(title, bodyHtml, buttons, opts = {}) {
  const root = opts.root || document.getElementById("modal-root");
  const my = ++_modalSeq;
  delete root.dataset.pw;   // 新模态顶掉密码模态标记：代关只认密码模态
  const btns = buttons.map((b, i) =>
    `<button class="${b.primary ? "primary" : ""}" data-i="${i}">` +
    `${_esc(b.label)}</button>`).join("");
  root.innerHTML = `
    <div class="modal">
      <h3>${_esc(title)}</h3>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-btns">${btns}</div>
    </div>`;

  const close = () => {
    // 只清自己这一代：期间若又开了新模态，旧 close 什么都不做
    if (my === _modalSeq) root.innerHTML = "";
  };

  const fire = (b) => {
    // 同步 onClick 保持同步语义（调用方的时序假设不受影响）；只有真的返回
    // Promise（async onClick）才转异步等待。一律包成 Promise 会把同步回调
    // 推到 microtask，改掉既有「点了立即有副作用」的行为。
    let r;
    try {
      r = b.onClick ? b.onClick() : true;
    } catch (e) {
      console.error("modal onClick 失败:", e);
      return;
    }
    if (r && typeof r.then === "function") {
      r.then((v) => { if (v !== false) close(); })
       .catch((e) => console.error("modal onClick 失败:", e));
      return;
    }
    if (r !== false) close();
  };

  root.querySelectorAll(".modal-btns button").forEach((btn) => {
    btn.onclick = () => fire(buttons[Number(btn.dataset.i)]);
  });

  root.onkeydown = (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey) return;
    // textarea 里 Enter 是换行；只对 input/select 提交
    const t = ev.target;
    if (!t || (t.tagName !== "INPUT" && t.tagName !== "SELECT")) return;
    ev.preventDefault();
    fire(buttons.find((b) => b.primary) || buttons[0]);
  };

  root.onmousedown = (ev) => {
    if (ev.target === root) {
      opts.onDismiss && opts.onDismiss();
      close();
    }
  };
  return close;
}

function modalAsk(title, message, onOk, opts = {}) {
  const rememberHtml = opts.remember
    ? `<label class="modal-check"><input type="checkbox" id="modal-remember" checked> ` +
      `${_esc(opts.rememberLabel || "记住密码")}</label>`
    : "";
  modalShell(title,
    `<p>${_esc(message)}</p>` +
    `<input type="${opts.password === false ? "text" : "password"}" ` +
    `id="modal-value" autofocus>` +
    rememberHtml,
    [
      {label: "确定", primary: true, onClick: () => {
        const remember = opts.remember
          ? document.getElementById("modal-remember").checked : false;
        onOk(document.getElementById("modal-value").value, remember);
      }},
      {label: "取消", onClick: () => { opts.onCancel && opts.onCancel(); }},
    ],
    {onDismiss: opts.onCancel, root: opts.root});
  const r = opts.root || document.getElementById("modal-root");
  r.dataset.pw = "1";
  const v = document.getElementById("modal-value");
  if (v) v.focus();
}

function modalConfirm(title, message, onOk, yesLabel = "信任", noLabel = "拒绝",
                      opts = {}) {
  modalShell(title, `<p>${_esc(message)}</p>`, [
    {label: yesLabel, primary: true, onClick: () => onOk(true)},
    {label: noLabel, onClick: () => onOk(false)},
  ], opts);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {modalShell, modalAsk, modalConfirm, _esc};
}
