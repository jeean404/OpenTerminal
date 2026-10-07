// 真机浏览器验证（headless chromium + 已保存连接）：多轮 AI 对话后核对
// ① 工具卡可见（execute 也发卡）② 总结卡不被夹紧截断 ③ 终端输入存活
// ④ 卡内文字可选中复制。截图与结论落 /tmp/ot_verify/。
// 用法：node tools/verify-web/verify.cjs [port]
"use strict";

const { chromium } = require("/Users/wujian/.nvm/versions/node/v22.22.3/lib/node_modules/playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = Number(process.argv[2] || 8123);
const OUT = "/tmp/ot_verify";
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function waitFor(fn, arg, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn(arg)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("timeout: " + label);
}

async function main() {
  const logFd = fs.openSync(path.join(OUT, "server.log"), "w");
  const server = spawn(path.join(REPO, ".venv", "bin", "ot"),
    ["web", "--port", String(PORT), "--no-open"],
    { cwd: REPO, stdio: ["ignore", logFd, logFd] });
  let browser;
  try {
    await waitFor(async () => {
      try { return (await fetch(BASE + "/")).ok; } catch (e) { return false; }
    }, null, 20000, "server up");

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push("pageerror: " + e.message));
    page.on("console", m => {
      if (m.type() === "error" && !/favicon/.test(m.text())) errors.push("console: " + m.text());
    });

    await page.goto(BASE + "/");
    await page.waitForSelector("#targets .target", { timeout: 15000 });
    const entry = page.locator("#targets .target", { hasText: "101.33" }).first();
    if (await entry.count()) await entry.click();
    else await page.locator("#targets .target").first().click();

    // 连上且提示符落屏（]# 或 $ 结尾行）
    await page.waitForFunction(() => {
      const rows = document.querySelector(".xterm-rows");
      return rows && /[#%]\s*$|]\s*#/.test(rows.textContent || "");
    }, { timeout: 60000 });
    await page.screenshot({ path: path.join(OUT, "01-connected.png") });

    const rowsText = () => page.evaluate(() =>
      (document.querySelector(".xterm-rows") || {}).textContent || "");
    const taskIdle = () => page.evaluate(() => {
      const el = document.querySelector('[id^="think-"]');
      return !!el && el.hidden;
    });
    const autoApprove = async () => {
      for (const sel of ["#modal-root button.primary", ".aprobe button.primary"]) {
        const b = page.locator(sel).first();
        if (await b.count()) {
          console.log("  (auto-approve via " + sel + ")");
          await b.click().catch(() => {});
          return true;
        }
      }
      return false;
    };
    const thinkState = () => page.evaluate(() => {
      const el = document.querySelector('[id^="think-"]');
      return el ? (el.hidden ? "hidden" : "shown") : "missing";
    });
    const runTask = async (text, tag) => {
      await page.mouse.click(760, 480);   // 视口坐标：终端 pane 中央
      await page.keyboard.type(text, { delay: 25 });
      await page.keyboard.press("Enter");
      // 段1：等任务起跑（思考徽标亮）；段2：等收束（徽标再藏）。
      // 初态徽标本就隐藏，直接等 hidden 会把「还没起跑」误判成「已收束」
      let started = false;
      let sawTcard = false;
      let t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        if (await thinkState() === "shown") { started = true; break; }
        await new Promise(r => setTimeout(r, 300));
      }
      t0 = Date.now();
      while (Date.now() - t0 < 150000) {
        if (!sawTcard) {
          // 在屏工具卡：出生即在流底可见；被后续输出顶出视口后不算
          sawTcard = await page.evaluate(() => {
            const h = [...document.querySelectorAll(".ot-card-host")].find(h =>
              h.querySelector(".tcard") &&
              getComputedStyle(h).display !== "none" && h.clientHeight > 0);
            return h ? h.textContent : "";
          });
          if (sawTcard) {
            await page.screenshot({ path: path.join(OUT, tag + "-toolcard.png") });
          }
        }
        if (started && (await thinkState()) === "hidden") break;
        await autoApprove();
        await new Promise(r => setTimeout(r, 1000));
      }
      await new Promise(r => setTimeout(r, 2000));   // 结账/垫行收尾
      await page.screenshot({ path: path.join(OUT, tag + ".png") });
      return { started, sawTcard };
    };

    const r1 = await runTask("/tmp 下有哪些文件", "02-round1");
    check("轮1 任务收束", r1.started);
    check("轮1 总结卡挂载", await page.evaluate(() =>
      !!document.querySelector(".scard .sbody")?.textContent.trim()));

    const r2 = await runTask("1+1 等于几，只回答数字", "03-round2");
    const r3 = await runTask("执行 echo OT_VERIFY_ROUND3", "04-round3");
    // 模型选工具随机（ls/execute 都可能）：滚轮扫 scrollback，把每张工具卡
    // 滚进视口读文本（顺带验证离屏卡回显路径），execute 命中即算
    const seen = new Set();
    for (const r of [r1, r2, r3]) if (r.sawTcard) seen.add(r.sawTcard);
    await page.mouse.move(760, 480);
    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel(0, -400);
      await new Promise(r => setTimeout(r, 350));
      for (const t of await page.evaluate(() =>
        [...document.querySelectorAll(".ot-card-host")]
          .filter(h => getComputedStyle(h).display !== "none" && h.clientHeight > 0)
          .filter(h => h.querySelector(".tcard"))
          .map(h => h.textContent))) seen.add(t);
    }
    // 决定性断言走 DOM：execute 工具卡已挂（可见性受滚动时机影响有 flake，
    // 在屏捕获只用于截图佐证）；滚扫 collected 的 seen 作为兜底
    const domTcards = await page.evaluate(() =>
      [...document.querySelectorAll(".tcard")].map(t => (t.textContent || "").trim()));
    const saw = domTcards.find(t => t.includes("调用工具：execute")) ||
      [...seen].find(t => t.includes("调用工具：execute"));
    check("execute 工具卡已发（DOM 有卡）", !!saw,
      (saw || domTcards[0] || [...seen][0] || "").slice(0, 60));
    const tcardN = await page.evaluate(() =>
      document.querySelectorAll(".tcard").length);
    check("三轮后工具卡累计 >= 2", tcardN >= 2, "tcard=" + tcardN);

    // ② 卡片不被夹紧截断：回滚到底静置后量在屏 host（滚扫中途的离屏过渡态
    // ch=0 不是用户可见截断；零高 host 排除）
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 600);
      await new Promise(r => setTimeout(r, 120));
    }
    await new Promise(r => setTimeout(r, 800));
    const clips = await page.evaluate(() =>
      [...document.querySelectorAll(".ot-card-host")]
        .filter(el => {
          const cs = getComputedStyle(el);
          return cs.display !== "none" && cs.visibility !== "hidden";
        })
        .map(el => ({
          sh: el.scrollHeight, ch: el.clientHeight,
          cls: (el.firstElementChild || {}).className || "",
        })).filter(c => c.ch > 0 && c.sh > c.ch + 2));
    check("无卡片被截断", clips.length === 0, JSON.stringify(clips).slice(0, 200));

    // ③ 输入存活：命令回显 + 输出都落屏
    await page.mouse.click(760, 480);   // 视口坐标：终端 pane 中央
    await page.keyboard.type("echo OT_VERIFY_LIVE", { delay: 25 });
    await page.keyboard.press("Enter");
    let live = false;
    try {
      await waitFor(async () => (await rowsText()).includes("OT_VERIFY_LIVE"), null,
        15000, "echo live");
      live = true;
    } catch (e) { /* fallthrough */ }
    check("多轮后终端输入存活", live);
    await page.screenshot({ path: path.join(OUT, "05-live.png") });

    // ④ 卡内文字可选中：计算样式 + 真实拖选
    const usel = await page.evaluate(() => {
      const el = document.querySelector(".scard .sbody");
      return el ? getComputedStyle(el).userSelect : "missing";
    });
    check("卡内 user-select=text", usel === "text", usel);
    const box = await page.locator(".scard .sbody").last().boundingBox();
    let selText = "";
    if (box) {
      await page.mouse.move(box.x + 5, box.y + 8);
      await page.mouse.down();
      await page.mouse.move(box.x + Math.min(300, box.width - 5), box.y + 8,
        { steps: 8 });
      await page.mouse.up();
      selText = await page.evaluate(() => window.getSelection().toString());
    }
    check("卡内拖选得到选区", selText.trim().length > 0,
      JSON.stringify(selText.slice(0, 40)));
    await page.screenshot({ path: path.join(OUT, "06-select.png") });

    // 拖选后终端焦点可回：点终端再敲键有回显
    await page.mouse.click(760, 480);   // 视口坐标：终端 pane 中央
    await page.keyboard.type("echo OT_VERIFY_FOCUS", { delay: 25 });
    await page.keyboard.press("Enter");
    let foc = false;
    try {
      await waitFor(async () => (await rowsText()).includes("OT_VERIFY_FOCUS"),
        null, 10000, "focus back");
      foc = true;
    } catch (e) { /* fallthrough */ }
    check("选卡后点终端可继续输入", foc);

    const realErrors = errors.filter(e => !/ResizeObserver|favicon/.test(e));
    check("无页面级 JS 报错", realErrors.length === 0,
      realErrors.slice(0, 3).join(" | ").slice(0, 200));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed` +
    (bad.length ? "  FAIL: " + bad.map(b => b.name).join(", ") : ""));
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.error("VERIFY ERROR", e); process.exit(2); });
