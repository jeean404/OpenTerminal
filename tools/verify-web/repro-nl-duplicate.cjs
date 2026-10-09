// 真机复现/验收：降级路径（sudo su - 后 hook 陈旧）打自然语言，输入是否被画两遍。
// 修复前：白色孤儿行 + 蓝色重绘行各一份；修复后：只剩一行（蓝色重绘）。
// 用法：node tools/verify-web/repro-nl-duplicate.cjs [port] [问题]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8290);
const QUESTION = process.argv[3] || "帮我查看 docker容器";
const TARGET = process.argv[4] || "腾讯云主机";
const OUT = lib.OUT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const probe = page => page.evaluate(() => {
  const g = id => {
    const el = document.querySelector('[id^="' + id + '-"]');
    return el ? (el.innerText || "").trim() : "";
  };
  const vis = id => {
    const el = document.querySelector('[id^="' + id + '-"]');
    return el ? (el.hidden ? "hidden" : "shown") : "missing";
  };
  return { status: g("status"), cs: g("cs"),
           connVis: vis("conn"), overlayVis: vis("connov") };
});

async function clickTerm(page, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { await page.locator(".term").click({ timeout: 3000 }); return true; }
    catch (e) {}
    await sleep(300);
  }
  return false;
}

function linesWith(snap, needle) {
  return snap.split("\n").filter(l => l.includes(needle));
}

async function runLine(page, text, tag, settleMs) {
  await page.keyboard.type(text, { delay: 25 });
  await sleep(400);
  await page.keyboard.press("Enter");
  await sleep(settleMs || 1800);
  const snap = await lib.snapshot(page);
  fs.writeFileSync(path.join(OUT, "nldup-" + tag + ".txt"), snap);
  return snap;
}

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用!)");
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, started.base);
  let fail = null;
  try {
    const picked = await lib.pickTarget(page, TARGET);
    console.log("点选保存连接", TARGET + ":", picked);
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
    await sleep(2000);
    await clickTerm(page);

    console.log("\n########## 造降级环境：sudo su - + cd /tmp ##########");
    await runLine(page, "sudo su -", "su", 5000);
    await runLine(page, "cd /tmp", "cd", 2500);
    let snap = await lib.snapshot(page);
    console.log("--- 送问前尾 4 行 ---");
    console.log(snap.split("\n").filter(l => l.trim()).slice(-4).join("\n"));

    console.log("\n########## 降级路径送自然语言 ##########");
    snap = await runLine(page, QUESTION, "ask", 6000);
    await page.screenshot({ path: path.join(OUT, "nldup-ask.png"), fullPage: false });

    const hits = linesWith(snap, QUESTION);
    const nq = (snap.match(new RegExp(QUESTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    console.log("\n########## 结果 ##########");
    console.log("含问句的行数:", hits.length, " 问句出现总次数:", nq);
    hits.forEach((l, i) => console.log("  [" + i + "] " + JSON.stringify(l)));
    console.log("--- 尾 10 行 ---");
    console.log(snap.split("\n").filter(l => l.trim()).slice(-10).join("\n"));
    if (hits.length !== 1) {
      fail = "输入被画了 " + hits.length + " 遍（期望 1 遍）";
    }
    console.log("页面错误:", errors.length ? errors.slice(0, 6) : "无");
  } finally {
    await browser.close().catch(() => {});
    if (started.server) started.server.kill();
  }
  console.log(fail ? "\nFAIL: " + fail : "\nPASS: 输入只画一遍");
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
