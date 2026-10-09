// 冒烟：tab 标签页上的连接状态点（.tab-dot）随状态变色；侧栏不再有状态点。
"use strict";
const path = require("node:path");
const lib = require("./lib");

(async () => {
  const PORT = 8271;
  const { base, server } = await lib.startServer(PORT);
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, base);
  try {
    await page.waitForSelector("#targets .target", { timeout: 10000 });
    const sidebarDots = await page.evaluate(
      () => document.querySelectorAll("#targets .target .dot").length);

    // 打开本机 tab，观察 tab-dot 状态迁移 connecting → connected
    await page.locator("#targets .target", { hasText: "local" }).first().click();
    await page.waitForSelector('[id^="tabbtn-"]', { timeout: 10000 });
    const states = [];
    for (let i = 0; i < 60; i++) {
      const st = await page.evaluate(() => {
        const d = document.querySelector("#tabs .tab .tab-dot");
        return d ? d.className : "missing";
      });
      states.push(st);
      if (st.includes("connected")) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const final = states[states.length - 1];
    console.log(JSON.stringify({ sidebarDots, states: [...new Set(states)], errors },
      null, 2));
    if (sidebarDots !== 0) throw new Error(`侧栏仍有状态点 x${sidebarDots}`);
    if (!states.every(s => s !== "missing")) throw new Error("tab 上找不到状态点");
    if (!final.includes("connected")) throw new Error(`最终态非 connected: ${final}`);
    console.log("PASS: tab 状态点存在且迁移到 connected；侧栏无状态点");
    process.exitCode = 0;
  } catch (e) {
    console.error("FAIL:", e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    if (server) server.kill();
  }
})();
