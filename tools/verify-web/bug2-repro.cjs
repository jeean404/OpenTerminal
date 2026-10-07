// Bug2 复现：连上后问两轮同样的自然语言问题，观测第二轮是否卡「AI 正在
// 思考」+ 终端是否还能输入。截图 + 服务端日志对照。
// 用法：node tools/verify-web/bug2-repro.cjs [port] [问题]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8123);
const QUESTION = process.argv[3] || "查看当前docker容器";
const TARGET = process.argv[4] || "腾讯云主机";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function thinkState(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[id^="think-"]');
    return el ? (el.hidden ? "hidden" : "shown") : "missing";
  });
}

async function connState(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || "";
    if (/连接已关闭/.test(t)) return "closed";
    if (/连接已断开|会话已结束/.test(t)) return "dropped";
    return "ok";
  });
}

async function typeLine(page, text) {
  await page.mouse.click(760, 480);
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press("Enter");
}

// 终端能否输入：输入探针串，看是否出现在 xterm 文本里
async function canType(page, probe) {
  await page.mouse.click(760, 480);
  await page.keyboard.type(probe, { delay: 15 });
  await sleep(700);
  const txt = await lib.snapshot(page);
  const ok = txt.includes(probe);
  if (ok) {
    // 清掉探针，别污染后续
    await page.keyboard.press("Control+U").catch(() => {});
  }
  return { ok, tail: txt.slice(-160) };
}

async function main() {
  const { base, server } = await lib.startServer(PORT);
  const browser = await lib.launch();
  const report = [];
  try {
    const { page, errors } = await lib.openTab(browser, base);
    await lib.pickTarget(page, TARGET);

    // 等连接 + 命令集收尾（终端静默 3s）
    let last = "", stable = 0, t0 = Date.now();
    while (Date.now() - t0 < 60000 && stable < 20) {
      const cur = await lib.snapshot(page);
      if (cur === last) stable++; else { stable = 0; last = cur; }
      await sleep(250);
    }
    await page.screenshot({ path: path.join(lib.OUT, "b2-00-connected.png") });
    console.log("连接完成，开始第一轮提问");

    for (let round = 1; round <= 2; round++) {
      console.log(`\n----- 第 ${round} 轮: ${QUESTION} -----`);
      await typeLine(page, QUESTION);

      // 等任务起跑
      let started = false;
      t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        if (await thinkState(page) === "shown") { started = true; break; }
        await sleep(300);
      }
      console.log(`  起跑: ${started} (+${Date.now() - t0}ms)`);

      // 等收束：徽标 hidden 且屏幕静默
      let done = false, stuckLong = 0;
      last = await lib.snapshot(page);
      t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        const st = await thinkState(page);
        const cur = await lib.snapshot(page);
        const changed = cur !== last;
        last = cur;
        if (started && st === "hidden" && !changed) { done = true; break; }
        if (st === "shown") stuckLong++; else stuckLong = 0;
        await sleep(1000);
      }
      const elapsed = Date.now() - t0;
      console.log(`  收束: ${done} 用时 ${elapsed}ms  思考态=${await thinkState(page)}`);

      // 本轮结束后测终端输入存活
      const typed = await canType(page, `Z${round}PROBE`);
      console.log(`  终端可输入: ${typed.ok}  conn=${await connState(page)}`);
      report.push({ round, started, done, elapsed, think: await thinkState(page),
                    canType: typed.ok, conn: await connState(page) });
      await page.screenshot({ path: path.join(lib.OUT, `b2-round${round}.png`) });

      if (!typed.ok) {
        console.log("  !! 终端输入失效，tail =", JSON.stringify(typed.tail));
        break;
      }
    }

    await page.screenshot({ path: path.join(lib.OUT, "b2-99-final.png") });
    const finalText = await lib.snapshot(page);
    fs.writeFileSync(path.join(lib.OUT, "b2-final.txt"), finalText);
    console.log("\n===== 汇总 =====");
    console.log(JSON.stringify(report, null, 1));
    console.log("===== JS 错误 =====");
    console.log(errors.length ? errors.join("\n") : "(none)");
    console.log("\n===== 屏幕尾部 =====");
    console.log(finalText.slice(-900));
  } finally {
    await browser.close();
    if (server) server.kill();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
