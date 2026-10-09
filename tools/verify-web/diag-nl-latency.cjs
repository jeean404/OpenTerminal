// 取证/验收：自然语言 Enter 后的上屏与出卡时延。
// 修复前（直通降级旧序）：Enter → \x15 擦行 + ^C + 0.52s → task_start → 卡，
//   文字空窗 ~1-2s（只能等卡渲染 task_start text）。
// 修复后：task_start 先发（卡即出），清缓冲后台并行——文字空窗应 <0.6s。
// 用法：node tools/verify-web/diag-nl-latency.cjs [port] [问题]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8295);
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
  const consoleLog = [];
  page.on("console", m => {
    if (/ot onData|otdbg|otws|error|warn/i.test(m.text()))
      consoleLog.push({ t: Date.now(), text: m.text().slice(0, 200) });
  });
  try {
    // WS JSON 帧时间戳（task_start/ai_token 到达时刻）——addInitScript 在
    // reload 后于应用脚本前执行
    await page.addInitScript(() => {
      const Orig = window.WebSocket;
      window.WebSocket = class extends Orig {
        constructor(...a) {
          super(...a);
          this.addEventListener("message", ev => {
            if (typeof ev.data === "string")
              console.log("[otws] " + ev.data.slice(0, 140));
          });
          const os = this.send.bind(this);
          this.send = d => {
            if (typeof d === "string" && d.length < 200)
              console.log("[otws-up] " + d.slice(0, 140));
            return os(d);
          };
        }
      };
    });
    await page.evaluate(() => localStorage.setItem("otdbg", "1"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });
    say("目标列表就绪");

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
    if (!(await clickTerm(page))) throw new Error("点不到终端");
    say("local tab 就绪，开始键入");

    await page.keyboard.type(QUESTION, { delay: 45 });
    say("键入完成");
    const snapAfterType = await lib.snapshot(page);
    const echoedWhileTyping = snapAfterType.includes(QUESTION.slice(0, 8));

    // Enter + 100ms 采样：文字可见性空窗、思考徽标、卡片
    const events = [];
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    say("Enter 已按");
    let sawTextBack = false, sawCard = false, sawThink = false;
    let blankFrom = null, blankMs = null;
    let nudged = false;
    for (let i = 0; i < 150; i++) {   // 15s 上限
      const now = Date.now() - t0;
      const st = await page.evaluate(() => {
        const think = document.querySelector('[id^="think-"]');
        const card = document.querySelector(".ablock, .aphead, .scard");
        const rows = document.querySelectorAll(".xterm-rows > div");
        let tail = "";
        for (let r = rows.length - 1; r >= 0; r--) {
          const s = (rows[r].textContent || "").trim();
          if (s) { tail = s; break; }
        }
        return { think: think ? (think.hidden ? "hidden" : "shown") : "missing",
                 card: !!card, tail: tail.slice(0, 120),
                 hosts: document.querySelectorAll(".ot-card-host").length };
      });
      if (!nudged && now > 3000) {
        // 假说检验：0.6s 后无渲染 pass → 外部 resize 强制一次
        nudged = true;
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        events.push({ t: now, ev: "resize 促成" });
      }
      const hasQ = st.tail.includes(QUESTION.slice(0, 6));
      if (!hasQ && blankFrom === null && now > 200) blankFrom = now;
      if (hasQ && blankFrom !== null && blankMs === null) blankMs = now - blankFrom;
      if (hasQ && !sawTextBack) { sawTextBack = true;
        events.push({ t: now, ev: "文字重现", tail: st.tail }); }
      if (st.think === "shown" && !sawThink) { sawThink = true;
        events.push({ t: now, ev: "思考徽标" }); }
      if (st.hosts > 0 && sawThink && !events.some(e => e.ev === "host交付"))
        events.push({ t: now, ev: "host交付" });
      if (st.card && !sawCard) { sawCard = true;
        events.push({ t: now, ev: "卡片出现" });
        break; }
      await sleep(100);
    }
    const out = {
      echoedWhileTyping, blankFromMs: blankFrom, blankMs,
      events,
      ws: consoleLog.filter(c => /otws/.test(c.text))
        .filter(c => !/\x1b|onData/.test(c.text)).slice(0, 120),
      console: consoleLog.slice(0, 30),
    };
    console.log(JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(lib.OUT, "nl-latency.json"),
                     JSON.stringify(out, null, 2));
    await page.screenshot({ path: path.join(lib.OUT, "nl-latency.png") });
    say("采样完成，截图已存");
  } finally {
    await browser.close();
    say("浏览器已关");
  }
  const log = path.join(lib.OUT, `server-${PORT}.log`);
  if (fs.existsSync(log)) {
    const lines = fs.readFileSync(log, "utf8").split("\n")
      .filter(l => /otdbg/.test(l) && !/pump tick/.test(l));
    console.log("--- 服务端 [otdbg] 尾 40 行 ---");
    console.log(lines.slice(-40).join("\n"));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
