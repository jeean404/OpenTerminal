// Phase 5 真机冒烟（born-complete cards）：真浏览器 + 真本机 PTY（PowerShell）
// + 真 HITL 审批 + 真卡片层；模型为可复现脚本（serve_scripted_model.py）。
//
// 覆盖用户三大目标的真机口径：
//   ① 美卡保留：命令卡（.cmdcard）+ 高总结卡（.scard）正常渲染、打字机揭示；
//   ② 不遮挡/不丢弃/不错位：任务收束后卡片全部在屏（不丢弃）、盒体不越过
//      预留区（maxHeight 钉死）、无隐藏残留；
//   ③ 终端原生能力：任务后 ↑ 历史召回 / Tab 补全照常工作（键直通 PTY）。
// 全程不变量：R8 页面零 JS 报错。
//
// 用法：node tools/verify-web/verify-phase5-smoke.cjs
"use strict";

const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
const HOME = path.join(REPO, ".tmp", "phase5-home");
const PORT = 8261;
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
    "# verify-phase5-smoke 专用（隔离 OPENTERMINAL_HOME）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    'auto_extra = ["echo", "ls", "pwd", "cat", "id", "whoami", "hostname"]',
    // 强制出审批：「总结」场景的命令在 tiered 下会被判只读免审，冒烟必须
    // 真走一遍命令卡审批 UI（红线⑨真机口径）
    'approve_extra = ["uname -a && df -h"]',
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
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "phase5-key",
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
  await page.screenshot({ path: path.join(OUT, `phase5-${name}.png`) });
  console.log("    [截图] phase5-" + name + ".png");
};

const probeCards = page => page.evaluate(() => {
  const vis = el => {
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const hosts = Array.from(document.querySelectorAll(".ot-card-host"));
  return {
    cmds: Array.from(document.querySelectorAll(".cmdcard")).map(x => ({
      text: (x.innerText || "").replace(/\s+/g, " ").slice(0, 120),
      state: ((x.querySelector(".apstate") || {}).innerText || "").trim(),
      hasActs: !!x.querySelector(".cmdacts"),
      liveBtn: !!x.querySelector(".cmdacts button.primary"),
    })),
    summs: Array.from(document.querySelectorAll(".scard")).map(x => ({
      len: (x.innerText || "").length,
      preview: (x.innerText || "").replace(/\s+/g, " ").slice(0, 80),
    })),
    hosts: hosts.map(h => ({
      visible: vis(h),
      cls: h.className,
      // 硬线几何：盒体必须钉 maxHeight（防盖住下方活文本）
      maxH: h.style.maxHeight || "",
      reveal: h.classList.contains("ot-reveal"),
    })),
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
    await sleep(300);
  }
  console.log("    [最后快照] " + JSON.stringify(last).slice(0, 400));
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

// xterm 纯文本快照（历史召回/补全断言用）
const snapshot = page => page.evaluate(() => {
  let rows = document.querySelectorAll(".xterm-rows .xterm-row");
  if (!rows.length) rows = document.querySelectorAll(".xterm-rows > div");
  return Array.from(rows).map(r => r.textContent || "").join("\n");
});

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
    if (m.type() === "error" && !/favicon/i.test(m.text()))
      errors.push("console: " + m.text());
  });
  page.on("requestfailed", r =>
    errors.push("reqfail: " + r.url() + " " + ((r.failure() || {}).errorText || "")));

  try {
    await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });

    // ---- A. 本机会话 ----
    const picked = await page.locator('#targets .target[data-name="local"]').first()
      .click().then(() => true).catch(() => false);
    record("A0 侧栏点中本机目标", picked, picked ? "local" : "未找到 local 条目");
    // 等真就绪：连接浮层退场 + 终端出提示符文本 + worker 判 interactive。
    // 本机 conda PowerShell 启动 40s+，且集成探测要等 shell 起来——抢跑打字
    // 会把按键打进未就绪的壳（真机首轮冒烟的假失败根因）
    let snap0 = "", interactive = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      snap0 = await snapshot(page);
      // interactive 信号：模型下拉可见性（app.js ready 时
      // modelSel.hidden = !interactive）
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
    record("A1 本机终端就绪（提示符 + interactive=1）",
      interactive && snap0.trim().length > 0,
      "interactive=" + interactive + " 尾行: " +
      (snap0.split("\n").filter(Boolean).pop() || "").slice(0, 100));
    await shot(page, "a-ready");

    // ---- B. 任务触发：「总结」场景（execute + 高总结卡）----
    await say(page, "总结");
    const withBadge = await waitCards(page, p => p.think && !p.think.hidden, 15000, "思考徽标");
    record("B1 任务起跑：徽标接管（" + (withBadge.think.text || "").slice(0, 40) + "）",
      true, withBadge.think.text);

    // ---- C. 命令卡（二合一）出生 ----
    const withCmd = await waitCards(page, p => p.cmds.length >= 1, 60000, "命令卡");
    record("C1 命令卡出生（一卡贯穿，无独立工具卡+审批卡）",
      withCmd.cmds.length === 1 && withCmd.summs.length === 0,
      JSON.stringify(withCmd.cmds));
    // 出生窗（宁藏不盖等垫行）过后再验「出生即定型」：揭示 + maxHeight 钉死
    const born = await waitCards(page,
      p => p.hosts.some(h => h.reveal && h.maxH && h.maxH !== "none"),
      30000, "出生定型");
    const host0 = born.hosts.find(h => h.reveal) || born.hosts[0];
    record("C2 出生即定型：宿主钉 maxHeight + 打字机揭示类",
      !!host0 && !!host0.maxH && host0.maxH !== "none" && host0.reveal,
      JSON.stringify(host0));
    await shot(page, "c-cmdcard");

    // ---- D. 审批按钮可点（红线⑨真机口径）----
    const armed = await waitCards(page, p => p.cmds.some(c => c.liveBtn), 60000, "审批武装");
    const btnBox = await page.evaluate(() => {
      const b = document.querySelector(".cmdcard .cmdacts button.primary");
      if (!b) return null;
      const box = b.closest(".ot-card-host") || b.closest(".cmdcard");
      const r = b.getBoundingClientRect();
      const h = box.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, hostTop: h.top, hostBottom: h.bottom,
               w: r.width, h: r.height };
    });
    record("D1 审批按钮真实可点（在卡盒可视区内）",
      !!btnBox && btnBox.h > 0 && btnBox.top >= btnBox.hostTop - 2 &&
      btnBox.bottom <= btnBox.hostBottom + 2,
      JSON.stringify(btnBox));
    await shot(page, "d-armed");
    await page.evaluate(() => {
      const b = document.querySelector(".cmdcard .cmdacts button.primary");
      if (b) b.click();
    });
    record("D2 点击执行（高危两步确认不在本场景：脚本命令非高危）", true, "");

    // ---- E. 收束：命令收徽标 + 高总结卡 ----
    const done = await waitCards(page, p =>
      p.cmds.some(c => /✓|✗/.test(c.state)) && p.summs.length >= 1, 60000, "收束");
    record("E1 命令卡原位收徽标（不消失）",
      done.cmds.length === 1 && /✓|✗/.test(done.cmds[0].state),
      done.cmds[0].state);
    record("E2 高总结卡出生（markdown 表格）",
      done.summs[0].len > 500, "长度=" + done.summs[0].len + " " + done.summs[0].preview);
    await sleep(1200);   // 等收束扫尾/揭示动画
    const settled = await probeCards(page);
    record("E3 收束后不丢弃：1 命令卡 + 1 总结卡全部在屏",
      settled.cmds.length === 1 && settled.summs.length === 1 &&
      settled.hosts.every(h => h.visible),
      `cmds=${settled.cmds.length} summs=${settled.summs.length} hosts=${JSON.stringify(settled.hosts.map(h => ({v: h.visible, maxH: h.maxH})))}`);
    record("E4 徽标退场（任务收束）",
      !settled.think || settled.think.hidden, JSON.stringify(settled.think));
    await shot(page, "e-settled");

    // ---- F. 终端原生能力（目标③真机口径）----
    await say(page, "echo ot-native-ok");
    await sleep(1500);
    const snap1 = await snapshot(page);
    record("F1 命令执行回显（echo ot-native-ok）",
      snap1.includes("ot-native-ok"), snap1.split("\n").slice(-4).join(" | ").slice(0, 160));
    // ↑ 历史召回：断言「当前输入行」= 最后一条非空行出现召回文本——
    // 不能取尾 N 行（执行过的历史行也含同文本，会假阳性）；xterm 快照尾部
    // 有整屏空行，.pop() 直接取会拿到空串
    const lastLine = s => (s.split("\n").map(x => x.replace(/\s+$/, ""))
      .filter(x => x.trim()).pop() || "");
    const tailLines = s => (s.split("\n").map(x => x.trim()).filter(Boolean).slice(-3).join(" | "));
    if (!(await clickTerm(page))) throw new Error("点不到终端");
    await page.keyboard.press("ArrowUp");
    await sleep(400);
    const snap2 = await snapshot(page);
    record("F2 ↑ 历史召回（当前输入行变为 echo ot-native-ok）",
      /echo ot-native-ok/.test(lastLine(snap2)),
      "当前行: " + lastLine(snap2).slice(0, 100));
    // 清行 + Tab 补全（PowerShell 命令名补全：Get-Ch → Get-ChildItem）
    await page.keyboard.press("Control+C");   // 放弃当前输入行，拿干净提示符
    await sleep(400);
    await page.keyboard.type("Get-Ch", { delay: 40 });
    await sleep(250);
    await page.keyboard.press("Tab");
    await sleep(500);
    const snap3 = await snapshot(page);
    record("F3 Tab 补全（Get-Ch → Get-ChildItem 一类展开）",
      /Get-Child/i.test(snap3) && !/Get-Ch\b/.test(tailLines(snap3)),
      "尾部: " + tailLines(snap3).slice(0, 100));
    await shot(page, "f-native");

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
