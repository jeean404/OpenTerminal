// 诊断：总结卡滚屏是否重渲染（root 迁移重挂）。
// 用法：node tools/verify-web/diag-scroll-rerender.cjs
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
const HOME = path.join(REPO, ".tmp", "scroll-home");
const PORT = 8265;
fs.mkdirSync(OUT, { recursive: true });
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
    "[model]", 'provider = "anthropic"', 'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"', 'api_key_env = "ANTHROPIC_API_KEY"', "",
    "[policy]", 'mode = "tiered"',
    'auto_extra = ["echo", "ls", "pwd", "cat"]', "",
    "[web]", 'host = "127.0.0.1"', `port = ${PORT}`, "",
  ].join("\n"), "utf8");
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if ((await fetch(base + "/")).ok) throw new Error("端口 " + PORT + " 残留服务端，换端口");
  } catch (e) {
    if (String(e.message).includes("残留")) throw e;
  }
  const logFd = fs.openSync(path.join(OUT, `server-${PORT}.log`), "w");
  const server = spawn(pythonExe(),
    [path.join(__dirname, "serve_scripted_model.py"),
     "--port", String(PORT), "--no-open"],
    { cwd: REPO, stdio: ["ignore", logFd, logFd],
      env: { ...process.env, OPENTERMINAL_HOME: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "scroll-key",
        OT_WEB_DEBUG: "1",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        PYTHONIOENCODING: "utf-8" } });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try { if ((await fetch(base + "/")).ok) break; } catch (e) {}
    await sleep(400);
  }
  return { base, server };
}

const snapshot = page => page.evaluate(() => {
  let rows = document.querySelectorAll(".xterm-rows .xterm-row");
  if (!rows.length) rows = document.querySelectorAll(".xterm-rows > div");
  return Array.from(rows).map(r => r.textContent || "").join("\n");
});

async function main() {
  prepareHome();
  const started = await startServer();
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const migrations = [];
  const flips = [];
  const errors = [];
  page.on("console", m => {
    const t = m.text();
    if (t.includes("root 迁移重挂")) migrations.push(t);
    if (t.includes("display 翻转")) flips.push(t);
    if (m.type() === "error" && !/favicon/i.test(t)) errors.push(t);
  });
  try {
    await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });
    await page.locator('#targets .target[data-name="local"]').first().click();
    // 等终端就绪
    let ready = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const s = await snapshot(page);
      const interactive = await page.evaluate(() => {
        const el = document.querySelector('[id^="model-"]');
        return !!(el && !el.hidden);
      }).catch(() => false);
      if (interactive && /PS |>\s*$/.test(s.split("\n").filter(Boolean).pop() || "")) { ready = true; break; }
      await sleep(500);
    }
    console.log("就绪:", ready);
    // 先跑任务出总结卡（「总结」场景：多块表格总结卡）
    await page.locator(".term").click({ force: true });
    await page.keyboard.type("总结", { delay: 45 });
    await sleep(350);
    await page.keyboard.press("Enter");
    // 等总结卡出现
    let n = 0;
    const t1 = Date.now();
    while (Date.now() - t1 < 60000) {
      n = await page.evaluate(() => document.querySelectorAll(".scard").length);
      if (n > 0) break;
      await sleep(400);
    }
    console.log("总结卡数量:", n);
    await sleep(1500);   // 等打字机/收束
    // 灌满缓冲（总结卡下方输出 300 行），让终端可滚
    await page.locator(".term").click({ force: true });
    await page.keyboard.type("1..300 | ForEach-Object { \"line $_\" }", { delay: 8 });
    await sleep(400);
    await page.keyboard.press("Enter");
    await sleep(3000);
    console.log("--- 滚屏前 root 迁移数:", migrations.length);
    await page.screenshot({ path: path.join(OUT, "diag-scroll-before.png") });
    // 记录滚前的卡几何 + 不透明度
    const probe = () => page.evaluate(() => {
      const sc = document.querySelector(".scard");
      const host = sc && sc.closest(".ot-card-host");
      const blocks = Array.from(document.querySelectorAll(".scard .ablk"))
        .map(b => getComputedStyle(b).opacity);
      return {
        top: host ? host.style.top : null, disp: host ? host.style.display : null,
        vis: host ? host.style.visibility : null, h: host ? host.style.maxHeight : null,
        opacity0: blocks.slice(0, 3),
        scrollTop: (document.querySelector(".xterm-viewport") || {}).scrollTop,
      };
    });
    console.log("滚前:", JSON.stringify(await probe()));
    console.log("滚前渲染计数:", await page.evaluate(() => window.__otRenders || 0));
    // 给 .ablk 块打身份标记（dataset.otId），滚动后查块是否被重建
    await page.evaluate(() => {
      document.querySelectorAll(".scard .ablk").forEach((b, i) => {
        b.dataset.otId = "blk" + i;
      });
    });
    // 把卡滚进视口：先滚到卡位置，再慢速逐帧截图
    await page.evaluate(() => {
      const t = document.querySelector(".xterm-viewport");
      const h = document.querySelector(".ot-card-host");
      if (t && h) {
        const hb = h.getBoundingClientRect();
        // 让卡顶回到视口上部
        t.scrollTop = Math.max(0, t.scrollTop + hb.top - 60);
      }
    });
    await sleep(400);
    console.log("滚到卡:", JSON.stringify(await probe()));
    // 逐帧截图（慢滚 6 步，每步截一次）
    const termBox = await page.evaluate(() => {
      const t = document.querySelector(".term") || document.querySelector(".xterm");
      const r = t.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(termBox.x, termBox.y);
      await page.mouse.wheel(0, 60);   // 慢速下滚 1 步
      await sleep(150);
      await page.screenshot({ path: path.join(OUT, `diag-scroll-f${i}.png`) });
    }
    await sleep(500);
    console.log("--- 滚屏后 root 迁移数:", migrations.length, "display 翻转数:", flips.length);
    for (const m of migrations.slice(0, 5)) console.log("  MIG", m.slice(0, 160));
    for (const m of flips.slice(0, 10)) console.log("  FLIP", m.slice(0, 160));
    console.log("滚后:", JSON.stringify(await probe()));
    console.log("滚后渲染计数:", await page.evaluate(() => window.__otRenders || 0));
    // 块身份：dataset.otId 是否还在（被重建则丢标记）
    console.log("块身份检查:", JSON.stringify(await page.evaluate(() => {
      const blocks = Array.from(document.querySelectorAll(".scard .ablk"));
      return {
        total: blocks.length,
        withId: blocks.filter(b => b.dataset.otId).length,
        anims: blocks.slice(0, 3).map(b => getComputedStyle(b).animationName),
      };
    })));
    await page.screenshot({ path: path.join(OUT, "diag-scroll-after.png") });
    console.log("JS 报错:", errors.length, errors.slice(0, 3));
  } catch (e) {
    console.log("异常:", String(e).slice(0, 300));
  } finally {
    await browser.close().catch(() => {});
    started.server.kill();
    process.exit(0);
  }
}
main();
