// 诊断：卡片盒体几何（遮挡）+ 审批按钮命中测试（点不动）。
// 用法：node tools/verify-web/diag-card-geometry.cjs
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
const HOME = path.join(REPO, ".tmp", "geo-home");
const PORT = 8268;
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
    "[policy]", 'mode = "tiered"', 'auto_extra = ["echo", "ls", "pwd"]', "",
    "[web]", 'host = "127.0.0.1"', `port = ${PORT}`, "",
  ].join("\n"), "utf8");
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(OUT, `server-${PORT}.log`), "w");
  const server = spawn(pythonExe(),
    [path.join(__dirname, "serve_scripted_model.py"),
     "--port", String(PORT), "--no-open"],
    { cwd: REPO, stdio: ["ignore", logFd, logFd],
      env: { ...process.env, OPENTERMINAL_HOME: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "geo-key",
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
  try {
    await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });
    await page.locator('#targets .target[data-name="local"]').first().click();
    // 等就绪
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const s = await snapshot(page);
      const interactive = await page.evaluate(() => {
        const el = document.querySelector('[id^="model-"]');
        return !!(el && !el.hidden);
      }).catch(() => false);
      if (interactive && /PS |>\s*$/.test(s.split("\n").filter(Boolean).pop() || "")) break;
      await sleep(500);
    }
    await page.evaluate(() => { window.__otBlankLog = []; });
    // 场景：「分析」——分析卡 + 免审命令卡（echo）
    await page.locator(".term").click({ force: true });
    await page.keyboard.type("分析", { delay: 45 });
    await sleep(350);
    await page.keyboard.press("Enter");
    await sleep(4000);
    // 场景：「批准」——需审命令卡（按钮）
    await page.locator(".term").click({ force: true });
    await page.keyboard.type("批准", { delay: 45 });
    await sleep(350);
    await page.keyboard.press("Enter");
    // 等审批按钮
    let btnInfo = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 60000) {
      btnInfo = await page.evaluate(() => {
        const b = document.querySelector(".cmdcard .cmdacts button.primary");
        if (!b) return null;
        const r = b.getBoundingClientRect();
        // 命中测试：按钮中心点上层是什么元素
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const hitCls = hit ? (hit.className || hit.tagName) : "null";
        // 全部卡盒几何
        const boxes = Array.from(document.querySelectorAll(".ot-card-host")).map(h => {
          const hb = h.getBoundingClientRect();
          const card = h.querySelector(".cmdcard,.ablock,.scard,.alertcard,.tcard");
          return {
            kind: card ? (card.className.split(" ").find(c => ["cmdcard", "ablock", "scard", "alertcard", "tcard"].includes(c)) || "?") : "?",
            top: Math.round(hb.top), bottom: Math.round(hb.bottom),
            h: Math.round(hb.height),
            inner: card ? Math.round(card.getBoundingClientRect().height) : 0,
            mline: h.dataset.mline,
            bspan: h.dataset.bspan, rows: h.dataset.rows, pinned: h.dataset.pinned, need: h.dataset.need,
          };
        });
        return {
          btn: { top: Math.round(r.top), bottom: Math.round(r.bottom),
                 x: Math.round(r.x), y: Math.round(r.y) },
          hitCls: String(hitCls).slice(0, 60),
          hitIsBtn: hit === b,
          boxes,
        };
      });
      if (btnInfo) break;
      await sleep(500);
    }
    if (!btnInfo) {
      console.log("未找到审批按钮");
    } else {
      console.log("按钮几何:", JSON.stringify(btnInfo.btn));
      console.log("按钮中心命中:", btnInfo.hitCls, "是按钮本身?", btnInfo.hitIsBtn);
      console.log("卡盒几何:");
      for (const b of btnInfo.boxes) {
        console.log(`  ${b.kind}: top=${b.top} bottom=${b.bottom} 盒高=${b.h} 内容高=${b.inner} mline=${b.mline} bspan=${b.bspan} rows=${b.rows} pinned=${b.pinned} need=${b.need}`);
      }
      // 盒高 > 内容高 = 空白尾巴遮挡嫌疑
      for (const b of btnInfo.boxes) {
        if (b.h - b.inner > 30) console.log(`  ⚠ ${b.kind} 盒比内容高 ${b.h - b.inner}px（空白尾巴遮挡嫌疑）`);
      }
      // 重叠检测
      for (let i = 0; i < btnInfo.boxes.length; i++)
        for (let j = i + 1; j < btnInfo.boxes.length; j++) {
          const a = btnInfo.boxes[i], c = btnInfo.boxes[j];
          const ov = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
          if (ov > 5) console.log(`  ⚠ 重叠 ${a.kind}∩${c.kind} = ${ov}px`);
        }
    }
    // 真实鼠标点击测试（读按钮所在卡的状态）
    const readBtnCard = () => page.evaluate(() => {
      const b = document.querySelector(".cmdcard .cmdacts button.primary");
      if (!b) return "no-btn";
      const card = b.closest(".cmdcard");
      return (card.innerText || "").replace(/\s+/g, " ").slice(0, 100);
    });
    const before = await readBtnCard();
    const r = await page.evaluate(() => {
      const b = document.querySelector(".cmdcard .cmdacts button.primary");
      if (!b) return null;
      const bb = b.getBoundingClientRect();
      return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    });
    if (r) {
      await page.mouse.move(r.x, r.y);
      await sleep(200);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();
    }
    await sleep(1000);
    const after = await readBtnCard();
    console.log("空白打断点:", JSON.stringify(await page.evaluate(() =>
      (window.__otBlankLog || []).slice(0, 6))));
    console.log("真实鼠标点击执行按钮:");
    console.log("  点击前:", before);
    console.log("  点击后:", after);
    console.log("  状态变化:", before !== after ? "PASS 点击生效" : "FAIL 点击无反应");
    await page.screenshot({ path: path.join(OUT, "diag-geo.png") });
  } catch (e) {
    console.log("异常:", String(e).slice(0, 300));
  } finally {
    await browser.close().catch(() => {});
    started.server.kill();
    process.exit(0);
  }
}
main();
