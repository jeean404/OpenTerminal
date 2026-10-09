// 真机实验：宏式 Enter（bind -x hook + accept-line）是否让 bash 重展开 PS1。
// 不改源码：把三个 bind 手工打进活会话，再用 Enter 走宏，观察字节与屏幕。
// 用法: node tools/verify-web/probe-macro-enter.cjs <port>
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8261);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = lib.OUT;
const BS = String.fromCharCode(92);      // 反斜杠（避开 heredoc 吃字符）
const ESCSEQ = BS + "e";

const SETUP = [
  "bind -x '\"" + ESCSEQ + "[44~\": __ot_submit'",
  "bind '\"" + ESCSEQ + "[45~\": accept-line'",
  "bind '\"" + BS + "C-m\": \"" + ESCSEQ + "[44~" + ESCSEQ + "[45~\"'",
];
const PROBES = ["cd /etc", "pwd", "printf abc", "history | tail -4", "echo TAILMARK"];

const probe = page => page.evaluate(() => {
  const g = id => {
    const el = document.querySelector('[id^="' + id + '-"]');
    return el ? (el.innerText || "").trim() : "";
  };
  const vis = id => {
    const el = document.querySelector('[id^="' + id + '-"]');
    return el ? (el.hidden ? "hidden" : "shown") : "missing";
  };
  let cur = null;
  try {
    const s = sessions[activeTabId];
    const b = s.term.buffer.active;
    cur = { x: b.cursorX, y: b.baseY + b.cursorY };
  } catch (e) { cur = { err: String(e) }; }
  return { status: g("status"), cs: g("cs"), connVis: vis("conn"),
           overlayVis: vis("connov"), cur };
});

async function clickTerm(page, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { await page.locator(".term").click({ timeout: 3000 }); return true; }
    catch (e) {}
    await sleep(300);
  }
  return false;
}

async function send(page, text, tag) {
  await page.keyboard.type(text, { delay: 25 });
  await sleep(350);
  await page.keyboard.press("Enter");
  await sleep(1800);
  const snap = await lib.snapshot(page);
  fs.writeFileSync(path.join(OUT, "macro-" + tag + ".txt"), snap);
  console.log("--- " + tag + " 尾 5 行 ---");
  console.log(snap.split("\n").filter(l => l.trim()).slice(-5).join("\n"));
  return snap;
}

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用!)");
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, started.base);
  try {
    const picked = await lib.pickTarget(page, "腾讯云主机");
    console.log("点选保存连接:", picked);
    await sleep(3000);
    let ready = null;
    for (let i = 0; i < 40; i++) {
      const p = await probe(page);
      if (p.connVis === "hidden" && p.overlayVis === "hidden" && p.status) { ready = p; break; }
      await sleep(500);
    }
    console.log("就绪:", ready ? ready.status : "未就绪");
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const p = await probe(page);
      if (/完成|done/.test(p.cs)) break;
      await sleep(500);
    }
    await sleep(2500);
    await clickTerm(page);

    console.log("\n########## 装宏（仍走旧 Enter） ##########");
    for (let i = 0; i < SETUP.length; i++) {
      console.log("  > " + SETUP[i]);
      await send(page, SETUP[i], "setup" + i);
    }

    console.log("\n########## 宏式 Enter 探针 ##########");
    for (let i = 0; i < PROBES.length; i++) {
      await send(page, PROBES[i], "p" + i);
      await page.screenshot({ path: path.join(OUT, "macro-p" + i + ".png") });
    }
    const pFin = await probe(page);
    console.log("\n光标:", JSON.stringify(pFin.cur), " cs:", JSON.stringify(pFin.cs));
    console.log("页面错误:", errors.length ? errors.slice(0, 6) : "无");
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(0);
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
