// 临时截图：注入一张总结卡看配色（不跑 agent，纯样式预览）
"use strict";
const { startServer, launch, openTab } = require("./lib");
(async () => {
  const { base, server } = await startServer(8402, {});
  const browser = await launch();
  try {
    const { page } = await openTab(browser, base);
    await page.addStyleTag({ content: ".pane{display:flex!important}" });
    await page.evaluate(() => {
      const pane = document.querySelector(".pane");
      const d = document.createElement("div");
      d.className = "scard";
      d.style.position = "fixed"; d.style.left = "20px"; d.style.top = "20px";
      d.style.zIndex = 9999; d.style.width = "560px";
      d.innerHTML = `<div class="ahead"><i class="adot"></i>总结</div>
        <div class="mline">任务完成：<strong>3 个文件</strong>已修改，测试全部通过。</div>
        <div class="mtable"><table><thead><tr><th>文件</th><th>改动</th><th>状态</th></tr></thead>
        <tbody><tr><td>app.js</td><td>+42 −8</td><td>✓</td></tr>
        <tr><td>style.css</td><td>+12 −6</td><td>✓</td></tr></tbody></table></div>`;
      document.body.appendChild(d);
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: "docs/scard-cyan.png", clip: { x: 0, y: 0, width: 620, height: 260 } });
    console.log("screenshot saved docs/scard-cyan.png");
  } finally {
    await browser.close().catch(() => {});
    if (server) server.kill();
  }
})().catch(e => { console.error("FATAL:", e); process.exit(2); });
