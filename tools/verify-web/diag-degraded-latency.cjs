// 取证：降级路径（hook 失效 = su -/换壳后）自然语言 Enter→卡时延。
// 流程：连 local → 敲 `exec zsh` 换掉集成壳（hook 失效）→ 等看门狗判 stale
// → 提交自然语言 → 采样 task_start / 卡片出现时刻。
// 修复前：先擦行再同步重注入 4-6s 才见卡；修复后 task_start 毫秒级。
// 用法：node tools/verify-web/diag-degraded-latency.cjs [port] [问题]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8298);
const QUESTION = process.argv[3] || "当前目录下有哪些文件";
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
    await page.locator("#targets .target", { hasText: "local" }).first().click();
    for (let i = 0; i < 60; i++) {
      const st = await page.evaluate(() => {
        const conn = document.querySelector('[id^="conn-"]');
        const ov = document.querySelector('[id^="connov-"]');
        return { conn: conn ? conn.hidden : "missing",
                 ov: ov ? ov.hidden : "missing" };
      });
      if (st.conn === true && st.ov === true) break;
      await sleep(400);
    }
    await sleep(1500);
    // 换壳：exec zsh 替换集成壳（hook 随旧 shell 消失）
    if (!(await clickTerm(page))) throw new Error("点不到终端");
    await page.keyboard.type("exec zsh", { delay: 40 });
    await page.keyboard.press("Enter");
    say("exec zsh 已发，等新 shell + 看门狗判 stale");
    await sleep(4000);   // 新提示符 + 回车看门狗 1s 判 stale

    await page.keyboard.type(QUESTION, { delay: 45 });
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    say("Enter 已按（降级提交）");
    let cardMs = null, thinkMs = null, textMs = null;
    const timeline = [];
    for (let i = 0; i < 150; i++) {   // 15s 上限
      const now = Date.now() - t0;
      const st = await page.evaluate(() => {
        const think = document.querySelector('[id^="think-"]');
        const card = document.querySelector(".ablock");
        const hosts = document.querySelectorAll(".ot-card-host").length;
        const rows = document.querySelectorAll(".xterm-rows > div");
        let tail = "";
        for (let r = rows.length - 1; r >= 0; r--) {
          const s = (rows[r].textContent || "").trim();
          if (s) { tail = s; break; }
        }
        return { think: think ? (think.hidden ? "hidden" : "shown") : "missing",
                 card: !!card, hosts,
                 cardHidden: card
                   ? getComputedStyle(card.closest(".ot-card-host") || card)
                       .visibility : "?" ,
                 tail: tail.slice(0, 120) };
      });
      timeline.push({ t: now, ...st });
      if (st.think === "shown" && thinkMs === null) thinkMs = now;
      if (st.card && cardMs === null) cardMs = now;
      if (st.tail.includes(QUESTION.slice(0, 6)) && textMs === null && now > 50)
        textMs = now;
      if (cardMs !== null && thinkMs !== null && now > cardMs + 500) break;
      await sleep(100);
    }
    const wsTaskStart = wsLog.find(l => l.text.includes("task_start"));
    const out = {
      thinkMs, cardMs, textMs,
      taskStartAfterEnterMs: wsTaskStart ? wsTaskStart.t - t0 : null,
      timeline: timeline.filter((s, i) =>
        i === 0 || JSON.stringify(s) !== JSON.stringify(timeline[i - 1])),
    };
    console.log(JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(lib.OUT, "degraded-latency.json"),
                     JSON.stringify(out, null, 2));
    await page.screenshot({ path: path.join(lib.OUT, "degraded-latency.png") });
    say("采样完成，截图已存");
  } finally {
    await browser.close();
    say("浏览器已关");
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
