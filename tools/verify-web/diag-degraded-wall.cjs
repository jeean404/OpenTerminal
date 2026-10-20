// 取证：降级路径「提示符墙 + 分析卡不渲染」（真机 101.33 su - 后截图实锤）。
// 流程：连已存 SSH 目标 → exec bash 换掉集成壳（hook 失效，远端 bash）→
// 提交自然语言 → 100ms 采样屏幕（裸提示符行数/卡片/思考徽标）+ 截图 + 服务端 log。
// 用法：node tools/verify-web/diag-degraded-wall.cjs [port] [目标关键字] [问题]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8303);
const TARGET = process.argv[3] || "101.33";
const QUESTION = process.argv[4] || "当前运行的docker容器";
const RESET_CMD = process.argv[5] || "exec bash";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function clickTerm(page) {
  for (let i = 0; i < 6; i++) {
    try { await page.locator(".term").click({ timeout: 3000, force: true });
          await sleep(120); return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  say("服务端:", started.base, started.server ? "(新起)" : "(复用!)");
  const browser = await lib.launch();
  const { page } = await lib.openTab(browser, started.base);
  const wsLog = [];
  page.on("console", m => {
    if (/otws/.test(m.text())) wsLog.push({ t: Date.now(), text: m.text() });
  });
  try {
    await page.addInitScript(() => {
      const Orig = window.WebSocket;
      window.WebSocket = class extends Orig {
        constructor(...a) {
          super(...a);
          this.addEventListener("message", ev => {
            if (typeof ev.data === "string")
              console.log("[otws] " + ev.data.slice(0, 140));
          });
        }
      };
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });
    await page.locator("#targets .target", { hasText: TARGET }).first().click();
    let connected = false;
    for (let i = 0; i < 90; i++) {
      const st = await page.evaluate(() => {
        const conn = document.querySelector('[id^="conn-"]');
        const ov = document.querySelector('[id^="connov-"]');
        return { conn: conn ? conn.hidden : "missing",
                 ov: ov ? ov.hidden : "missing" };
      });
      if (st.conn === true && st.ov === true) { connected = true; break; }
      await sleep(400);
    }
    if (!connected) throw new Error("连接未就绪（密码未存？）");
    await sleep(2000);
    if (!(await clickTerm(page))) throw new Error("点不到终端");
    say("已连接，" + RESET_CMD + " 换壳");
    await page.keyboard.type(RESET_CMD, { delay: 40 });
    await page.keyboard.press("Enter");
    await sleep(3500);   // 新 shell + 回车看门狗判 stale

    await page.keyboard.type(QUESTION, { delay: 45 });
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    say("Enter 已按（降级提交）");
    const timeline = [];
    let cardMs = null, thinkMs = null, wallPeak = 0;
    for (let i = 0; i < 150; i++) {   // 15s
      const now = Date.now() - t0;
      const st = await page.evaluate(() => {
        const think = document.querySelector('[id^="think-"]');
        const cards = [...document.querySelectorAll(".ablock")].map(c => {
          const host = c.closest(".ot-card-host");
          const vis = getComputedStyle(host || c).visibility;
          const r = (host || c).getBoundingClientRect();
          return { vis, h: Math.round(r.height) };
        });
        const rows = document.querySelectorAll(".xterm-rows > div");
        let bare = 0, tail = "";
        for (let r = rows.length - 1; r >= 0; r--) {
          const s = (rows[r].textContent || "").trim();
          if (/^(\[[^\]]+\]#|[^$]*\$)\s*$/.test(s) || s === "") bare++;
          else if (!tail) tail = s;
        }
        return { think: think ? (think.hidden ? "hidden" : "shown") : "missing",
                 cards, bare, tail: tail.slice(0, 90) };
      });
      wallPeak = Math.max(wallPeak, st.bare);
      if (st.cards.length && cardMs === null) cardMs = now;
      if (st.think === "shown" && thinkMs === null) thinkMs = now;
      if (i % 5 === 0) timeline.push({ t: now, ...st });
      if (now === 800 || now === 2000 || now === 4000) {
        await page.screenshot({ path: path.join(lib.OUT, `wall-${now}.png`) });
      }
      if (st.cards.length && now > cardMs + 2000) break;
      await sleep(100);
    }
    const out = { thinkMs, cardMs, wallPeak,
      timeline: timeline.slice(0, 40),
      ws: wsLog.filter(l => /task_start|pad|ai_|final|error/.test(l.text))
        .map(l => ({ t: l.t - t0, text: l.text.slice(0, 120) })).slice(0, 40) };
    console.log(JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(lib.OUT, "degraded-wall.json"),
                     JSON.stringify(out, null, 2));
    await page.screenshot({ path: path.join(lib.OUT, "wall-final.png") });
    say("采样完成");
  } finally {
    await browser.close();
  }
  const log = path.join(lib.OUT, `server-${PORT}.log`);
  if (fs.existsSync(log)) {
    const lines = fs.readFileSync(log, "utf8").split("\n")
      .filter(l => /otdbg/.test(l) && !/pump tick|drain raw/.test(l));
    say("--- 服务端 [otdbg] 尾 55 行 ---");
    console.log(lines.slice(-55).join("\n"));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
