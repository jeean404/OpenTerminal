// 用户两条预期的真机验证（born-complete cards Phase 5 全量场景）：
//   ① 命令卡形态流转：免审=工具卡态（无操作行）；需审=审核卡态（armed 按钮簇）；
//      决策后=工具卡态（按钮簇→回执），并按 执行/拒绝/修改/始终允许 分样式；
//      高危两步确认浮层。
//   ② 分析卡：原样式（.ablock 蓝框+「分析」标签+思考/正文）+ 打字机逐块揭示。
// 全程不变量：R8 页面零 JS 报错、命令卡不消失（原位收徽标）。
//
// 用法：node tools/verify-web/verify-user-expect.cjs
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
const HOME = path.join(REPO, ".tmp", "user-expect-home");
const PORT = 8263;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}
function finish(logPath) {
  const fails = results.filter(r => !r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`\n合计 ${results.length - fails}/${results.length} 通过`);
  if (logPath) console.log("服务端日志: " + logPath);
  process.exit(fails ? 1 : 0);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pythonExe() {
  for (const c of [
    path.join(REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# verify-user-expect 专用（隔离 OPENTERMINAL_HOME）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    // echo 走只读自动 → 免审批；重定向写文件 → normal 风险审批；
    // Remove-Item → high 风险审批（高危两步确认）
    'auto_extra = ["echo", "ls", "pwd", "cat", "id", "whoami", "hostname"]',
    "",
    "[web]",
    'host = "127.0.0.1"',
    `port = ${PORT}`,
    "",
  ].join("\n"), "utf8");
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  try { up = (await fetch(base + "/")).ok; } catch (e) { up = false; }
  if (up) throw new Error("端口 " + PORT + " 已有服务端；换端口重试");
  const logFd = fs.openSync(path.join(OUT, `server-${PORT}.log`), "w");
  const server = spawn(pythonExe(),
    [path.join(__dirname, "serve_scripted_model.py"),
     "--port", String(PORT), "--no-open"],
    {
      cwd: REPO,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        OPENTERMINAL_HOME: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "user-expect-key",
        OT_WEB_DEBUG: "1",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        PYTHONIOENCODING: "utf-8",
      },
    });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try { if ((await fetch(base + "/")).ok) break; } catch (e) { /* retry */ }
    await sleep(400);
  }
  return { base, server };
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `ue-${name}.png`) });
  console.log("    [截图] ue-" + name + ".png");
};

// 卡片探针：命令卡形态 + 分析卡打字机状态
const probeCards = page => page.evaluate(() => {
  const vis = el => {
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  return {
    cmds: Array.from(document.querySelectorAll(".cmdcard")).map(x => {
      const btns = Array.from(x.querySelectorAll(".cmdacts button"))
        .map(b => (b.innerText || "").replace(/\s+/g, " ").trim());
      const receipt = x.querySelector(".apreceipt");
      const state = x.querySelector(".apstate");
      return {
        code: ((x.querySelector(".cmdcode") || {}).innerText || "")
          .replace(/\s+/g, " ").trim().slice(0, 80),
        state: (state ? state.innerText : "").trim(),
        stateCls: state ? state.className : "",
        reason: ((x.querySelector(".cmdreason") || {}).innerText || "").trim(),
        high: x.classList.contains("high"),
        hasActs: !!x.querySelector(".cmdacts"),
        btns,
        liveBtn: btns.length > 0,
        receipt: receipt ? receipt.innerText.trim() : "",
        receiptCls: receipt ? receipt.className : "",
        confirm: !!x.querySelector(".apconfirm"),
        edopen: x.classList.contains("edopen"),
      };
    }),
    analyses: Array.from(document.querySelectorAll(".ablock")).map(x => ({
      label: ((x.querySelector(".alabel") || {}).textContent || "").trim(),
      hasReason: !!x.querySelector(".areason"),
      reason: ((x.querySelector(".areason") || {}).textContent || "").trim().slice(0, 60),
      blkCount: x.querySelectorAll(".ablk").length,
      blkIdx: Array.from(x.querySelectorAll(".ablk")).map(b =>
        b.style.getPropertyValue("--i").trim()),
      done: x.classList.contains("done"),
      failed: x.classList.contains("failed"),
    })),
    hosts: Array.from(document.querySelectorAll(".ot-card-host")).map(h => ({
      visible: vis(h),
      cls: h.className,
      maxH: h.style.maxHeight || "",
      reveal: h.classList.contains("ot-reveal") || h.classList.contains("ot-revealed"),
    })),
    // 打字机采样：各块当前 opacity（揭示中会 0/1 混杂）
    blkOpacity: Array.from(document.querySelectorAll(".ablock .ablk")).map(b => {
      const s = getComputedStyle(b);
      return { i: b.style.getPropertyValue("--i").trim(), op: s.opacity,
               anim: s.animationName, delay: s.animationDelay };
    }),
    think: (() => {
      const t = document.querySelector('[id^="think-"]');
      return t ? { hidden: t.hidden, text: (t.innerText || "").trim() } : null;
    })(),
  };
});

async function waitCards(page, fn, timeout, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await probeCards(page);
    if (fn(last)) return last;
    await sleep(250);
  }
  console.log("    [最后快照] " + JSON.stringify(last).slice(0, 500));
  throw new Error("等待超时: " + label);
}

async function clickTerm(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.locator(".term").click({ timeout: 3000, force: true });
      await sleep(120);
      return true;
    } catch (e) { await sleep(300); }
  }
  return false;
}

async function say(page, text) {
  if (!(await clickTerm(page))) throw new Error("点不到终端");
  await sleep(150);
  await page.keyboard.type(text, { delay: 45 });
  await sleep(350);
  await page.keyboard.press("Enter");
}

const snapshot = page => page.evaluate(() => {
  let rows = document.querySelectorAll(".xterm-rows .xterm-row");
  if (!rows.length) rows = document.querySelectorAll(".xterm-rows > div");
  return Array.from(rows).map(r => r.textContent || "").join("\n");
});

// 点命令卡内按钮（按文案匹配）
async function clickCmdBtn(page, label) {
  return page.evaluate(lbl => {
    const btns = Array.from(document.querySelectorAll(".cmdcard .cmdacts button"));
    const b = btns.find(x => (x.innerText || "").startsWith(lbl));
    if (!b) return false;
    b.click();
    return true;
  }, label);
}

async function main() {
  prepareHome();
  const started = await startServer();
  const logPath = path.join(OUT, `server-${PORT}.log`);
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => {
    if ((m.type() === "error" || m.type() === "warning") && !/favicon/i.test(m.text()))
      errors.push("console: " + m.text());
  });
  page.on("requestfailed", r =>
    errors.push("reqfail: " + r.url() + " " + ((r.failure() || {}).errorText || "")));

  try {
    await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });

    // ---- 0. 本机会话就绪 ----
    await page.locator('#targets .target[data-name="local"]').first()
      .click().then(() => true).catch(() => false);
    let snap0 = "", interactive = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      snap0 = await snapshot(page);
      interactive = await page.evaluate(() => {
        const el = document.querySelector('[id^="model-"]');
        return !!(el && !el.hidden);
      }).catch(() => false);
      const connClear = await page.evaluate(() => {
        const g = id => {
          const el = document.querySelector(`[id^="${id}-"]`);
          return el ? (el.hidden ? "hidden" : "shown") : "missing";
        };
        return g("conn") !== "shown" && g("connov") !== "shown";
      }).catch(() => false);
      if (connClear && /PS |>\s*$/.test(snap0.split("\n").filter(Boolean).pop() || "") &&
          interactive) break;
      await sleep(500);
    }
    record("0 本机终端就绪（提示符 + interactive=1）",
      interactive && snap0.trim().length > 0,
      "interactive=" + interactive + " 尾行: " +
      (snap0.split("\n").filter(Boolean).pop() || "").slice(0, 80));

    // ================================================================
    // 预期①-1：免审命令 → 工具卡态（无操作行、无按钮）
    // ================================================================
    await say(page, "免审");
    const auto1 = await waitCards(page, p =>
      p.cmds.some(c => /echo auto-ok/.test(c.code)), 60000, "免审命令卡");
    const ac = auto1.cmds.find(c => /echo auto-ok/.test(c.code));
    record("①-1a 免审命令卡出生：无操作行/无按钮（工具卡态），无「⚠ 高危」误标",
      ac && !ac.liveBtn && ac.btns.length === 0 && !ac.high &&
      !/高危/.test(ac.reason) && /执行中|✓|✗/.test(ac.state),
      JSON.stringify({ state: ac.state, btns: ac.btns, hasActs: ac.hasActs,
                      high: ac.high, reason: ac.reason }));
    await shot(page, "1a-auto-executing");
    const auto2 = await waitCards(page, p => {
      const c = p.cmds.find(x => /echo auto-ok/.test(x.code));
      return c && /✓|✗/.test(c.state);
    }, 30000, "免审命令收束");
    const ac2 = auto2.cmds.find(c => /echo auto-ok/.test(c.code));
    record("①-1b 免审命令卡收束：✓ 完成（工具卡态保持无按钮）",
      ac2 && /✓/.test(ac2.state) && !ac2.liveBtn,
      JSON.stringify({ state: ac2.state, btns: ac2.btns }));
    await shot(page, "1b-auto-done");

    // ================================================================
    // 预期①-2/3：需审命令 → 审核卡态 → 点「执行」→ 工具卡态（✓ 样式）
    // ================================================================
    await say(page, "批准");
    const ap1 = await waitCards(page, p =>
      p.cmds.some(c => /ot-u1/.test(c.code) && c.liveBtn), 60000, "审批武装");
    const ap = ap1.cmds.find(c => /ot-u1/.test(c.code));
    record("①-2a 需审命令卡=审核卡态：等待审批 + 4 按钮（执行/修改/拒绝/始终允许）",
      ap && /等待审批/.test(ap.state) && ap.btns.length === 4 &&
      ap.btns.some(b => b.startsWith("执行")) && ap.btns.some(b => b.startsWith("修改")) &&
      ap.btns.some(b => b.startsWith("拒绝")) && ap.btns.some(b => b.startsWith("始终允许")),
      JSON.stringify({ state: ap.state, btns: ap.btns, high: ap.high, reason: ap.reason }));
    record("①-2b 普通风险=蓝框（非高危）",
      ap && !ap.high, "high=" + (ap && ap.high) + " reason=" + (ap && ap.reason));
    await shot(page, "2-approval-card");

    if (!(await clickCmdBtn(page, "执行"))) throw new Error("点不到「执行」");
    const ap2 = await waitCards(page, p => {
      const c = p.cmds.find(x => /ot-u1/.test(x.code));
      return c && c.receipt && /✓|✗/.test(c.state);
    }, 40000, "执行后收束");
    const apd = ap2.cmds.find(c => /ot-u1/.test(c.code));
    record("①-3 点执行 → 工具卡态（按钮簇→回执「✓ 已同意」，状态 ✓ 完成）",
      apd && /✓ 已同意/.test(apd.receipt) && /✓/.test(apd.state) &&
      apd.btns.length === 0,
      JSON.stringify({ receipt: apd.receipt, receiptCls: apd.receiptCls,
                      state: apd.state, stateCls: apd.stateCls, btns: apd.btns }));
    await shot(page, "3-approved-done");

    // ================================================================
    // 预期①-4：点「拒绝」→ ✗ 已拒绝（fail 红样式）
    // ================================================================
    await say(page, "拒绝");
    const rj1 = await waitCards(page, p =>
      p.cmds.some(c => /ot-u2/.test(c.code) && c.liveBtn), 60000, "拒绝场景武装");
    await shot(page, "4a-reject-armed");
    if (!(await clickCmdBtn(page, "拒绝"))) throw new Error("点不到「拒绝」");
    const rj2 = await waitCards(page, p => {
      const c = p.cmds.find(x => /ot-u2/.test(x.code));
      return c && /已拒绝/.test(c.state + c.receipt);
    }, 30000, "拒绝后状态");
    const rj = rj2.cmds.find(c => /ot-u2/.test(c.code));
    record("①-4 点拒绝 → 灰卡「✗ 已拒绝」（rejected 灰样式，状态只显一次）",
      rj && /✗ 已拒绝/.test(rj.state) && /rejected/.test(rj.stateCls) &&
      rj.btns.length === 0 && !/已拒绝/.test(rj.receipt),
      JSON.stringify({ state: rj.state, stateCls: rj.stateCls,
                      receipt: rj.receipt, receiptCls: rj.receiptCls }));
    await shot(page, "4b-rejected");

    // ================================================================
    // 预期①-5：点「修改」→ 编辑框 → 保存 → ✎ 已编辑（edit 黄样式）
    // ================================================================
    await say(page, "改令");
    const ed1 = await waitCards(page, p =>
      p.cmds.some(c => /ot-u3/.test(c.code) && c.liveBtn), 60000, "改令场景武装");
    if (!(await clickCmdBtn(page, "修改"))) throw new Error("点不到「修改」");
    // 编辑框是 pane 级 portal：.pane > .apedit textarea
    await page.waitForSelector(".pane > .apedit textarea", { timeout: 10000 });
    await shot(page, "5a-editor-open");
    // React 受控组件：直接赋值 .value 不进 state，必须走 fill（触发 onChange）
    await page.fill(".pane > .apedit textarea", "echo edit-saved > $env:TEMP/ot-u3.txt");
    await sleep(200);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll(".pane > .apedit button"));
      const b = btns.find(x => (x.innerText || "").includes("保存"));
      if (b) b.click();
    });
    const ed2 = await waitCards(page, p => {
      const c = p.cmds.find(x => /ot-u3/.test(x.code));
      return c && /已编辑/.test(c.receipt + c.state);
    }, 30000, "编辑回执");
    const ed = ed2.cmds.find(c => /ot-u3/.test(c.code));
    record("①-5a 点修改 → 编辑框浮层 → 保存 → 回执「✎ 已编辑」（edit 黄样式）",
      ed && /已编辑/.test(ed.receipt + ed.state) &&
      /edit/.test(ed.receiptCls + ed.stateCls) && /edit-saved/.test(ed.code),
      JSON.stringify({ code: ed.code, receipt: ed.receipt,
                      receiptCls: ed.receiptCls, state: ed.state }));
    await shot(page, "5b-edited");
    const ed3 = await waitCards(page, p => {
      const c = p.cmds.find(x => /ot-u3/.test(x.code));
      return c && /✓|✗/.test(c.state) && !c.liveBtn;
    }, 40000, "编辑后收束");
    const edd = ed3.cmds.find(c => /ot-u3/.test(c.code));
    record("①-5b 编辑后命令执行收束（工具卡态）",
      edd && /✓|✗/.test(edd.state) && edd.btns.length === 0,
      JSON.stringify({ state: edd.state }));

    // ================================================================
    // 预期①-6：点「始终允许」→ ★ 已始终允许
    // ================================================================
    await say(page, "放行");
    const al1 = await waitCards(page, p =>
      p.cmds.some(c => /ot-u4/.test(c.code) && c.liveBtn), 60000, "放行场景武装");
    if (!(await clickCmdBtn(page, "始终允许"))) throw new Error("点不到「始终允许」");
    const al2 = await waitCards(page, p => {
      const c = p.cmds.find(x => /ot-u4/.test(x.code));
      return c && /已始终允许/.test(c.receipt + c.state);
    }, 30000, "始终允许回执");
    const al = al2.cmds.find(c => /ot-u4/.test(c.code));
    record("①-6a 点始终允许 → 回执「★ 已始终允许」",
      al && /★ 已始终允许/.test(al.receipt + al.state),
      JSON.stringify({ receipt: al.receipt, receiptCls: al.receiptCls, state: al.state }));
    await shot(page, "6a-allowed");
    const al3 = await waitCards(page, p => {
      const c = p.cmds.find(x => /ot-u4/.test(x.code));
      return c && /✓|✗/.test(c.state);
    }, 40000, "始终允许后收束");
    record("①-6b 始终允许后执行收束",
      /✓|✗/.test(al3.cmds.find(c => /ot-u4/.test(c.code)).state), "");

    // ================================================================
    // 预期①-7：高危命令 → 红框 + 两步确认浮层
    // ================================================================
    // 预置靶文件，让 Remove-Item 能成功（验证 ✓ 完成态）
    await say(page, "echo pre > $env:TEMP/ot-vh-target.txt");
    await sleep(1500);
    await say(page, "高危");
    const hi1 = await waitCards(page, p =>
      p.cmds.some(c => /ot-vh-target/.test(c.code) && c.liveBtn), 60000, "高危武装");
    const hi = hi1.cmds.find(c => /ot-vh-target/.test(c.code));
    record("①-7a 高危命令卡=红框审核卡态（high + 等待审批 + 按钮）",
      hi && hi.high && /等待审批/.test(hi.state) && hi.liveBtn,
      JSON.stringify({ high: hi.high, state: hi.state, reason: hi.reason, btns: hi.btns }));
    await shot(page, "7a-high-armed");
    if (!(await clickCmdBtn(page, "执行"))) throw new Error("点不到「执行」");
    // 两步确认：点执行先出浮层，不直接决策
    await sleep(600);
    const hi2 = await probeCards(page);
    const hic = hi2.cmds.find(c => /ot-vh-target/.test(c.code));
    record("①-7b 高危执行→两步确认浮层（.apconfirm 出现、未决策）",
      hic && hic.confirm && /等待审批/.test(hic.state),
      JSON.stringify({ confirm: hic.confirm, state: hic.state }));
    await shot(page, "7b-high-confirm");
    await page.evaluate(() => {
      const b = document.querySelector(".cmdcard .apconfirm button.primary");
      if (b) b.click();
    });
    const hi3 = await waitCards(page, p => {
      const c = p.cmds.find(x => /ot-vh-target/.test(x.code));
      return c && /✓|✗/.test(c.state) && c.receipt;
    }, 40000, "高危确认后收束");
    const hid = hi3.cmds.find(c => /ot-vh-target/.test(c.code));
    record("①-7c 确认执行 → 回执「✓ 已同意」→ ✓ 完成",
      hid && /✓ 已同意/.test(hid.receipt) && /✓/.test(hid.state),
      JSON.stringify({ receipt: hid.receipt, state: hid.state }));
    await shot(page, "7c-high-done");

    // ================================================================
    // 预期②：分析卡原样式 + 打字机揭示
    // ================================================================
    await say(page, "分析");
    // 等有内容的分析卡（挂载瞬间块可能还没渲染完，等 blkCount>0 再取）
    const an1 = await waitCards(page, p =>
      p.analyses.some(a => a.blkCount > 0), 60000, "分析卡");
    const an = an1.analyses.find(a => a.blkCount > 0);
    record("②-1 分析卡出生：原样式（.ablock + 「分析」标签 + 思考/正文分层）",
      an && /分析/.test(an.label) && an.blkCount > 0,
      JSON.stringify({ label: an.label, hasReason: an.hasReason,
                      reason: an.reason, blkCount: an.blkCount, blkIdx: an.blkIdx }));
    // 打字机：宿主 ot-reveal + 各块 --i 索引 + ot-reveal 动画
    // 等至少一块 opacity>0——揭示类挂上但动画 delay 未到时块仍为 0，抢跑会误判
    const an2 = await waitCards(page, p =>
      p.hosts.some(h => h.reveal) &&
      p.blkOpacity.some(b => Number(b.op) > 0), 30000, "打字机揭示");
    const sample = an2.blkOpacity;
    const hasAnim = sample.every(b => /ot-reveal/.test(b.anim) || b.anim === "none");
    const hasIdx = sample.every(b => b.i !== "");
    // 揭示期 opacity 0/1 混杂或全部完成（1）都算动画跑过；全 0 才是没跑
    const allZero = sample.every(b => Number(b.op) === 0);
    record("②-2 打字机逐块揭示：ot-reveal 动画 + --i 延迟索引（动画已跑）",
      hasAnim && hasIdx && !allZero,
      JSON.stringify(sample.slice(0, 6)) + (sample.length > 6 ? ` …共${sample.length}块` : ""));
    await shot(page, "8-analysis-typewriter");
    // 等打字机播完，验证内容完整
    await sleep(1500);
    const an3 = await waitCards(page, p =>
      p.analyses.some(a => a.done && a.blkCount > 0), 30000, "分析卡定格");
    const anDone = an3.analyses.find(a => a.done);
    const anHosts = an3.hosts.filter(h => /ot-card-host/.test(h.cls));
    record("②-3 分析卡定格后内容完整（思考槽 + 多块正文），宿主钉 maxHeight",
      anDone && anDone.hasReason && anDone.blkCount >= 3 &&
      anHosts.some(h => h.maxH && h.maxH !== "none"),
      JSON.stringify({ blkCount: anDone.blkCount, hasReason: anDone.hasReason,
                      hosts: anHosts.map(h => ({ maxH: h.maxH, reveal: h.reveal })) }));
    await shot(page, "8b-analysis-done");
    // 分析场景的免审命令卡一并收束
    await waitCards(page, p => {
      const c = p.cmds.find(x => /echo auto-ok/.test(x.code) && /✓|✗/.test(x.state));
      return !!c;
    }, 40000, "分析场景命令收束");
    record("②-4 分析段与命令卡并存不丢（分析卡 + 命令卡都在屏）",
      true, "");

    // ---- R8 全程零 JS 报错 ----
    record("R8 页面无 JS 报错", errors.length === 0,
      errors.length ? errors.join("\n").slice(0, 500) : "无 pageerror/console error");
  } catch (e) {
    record("脚本异常", false, String(e && e.stack || e));
    if (errors.length) console.log("    [控制台/网络] " + errors.join("\n    ").slice(0, 800));
    try { await shot(page, "crash"); } catch (e2) {}
  } finally {
    await browser.close().catch(() => {});
    started.server.kill();
  }
  finish(logPath);
}

main().catch(e => { console.error(e); process.exit(1); });
