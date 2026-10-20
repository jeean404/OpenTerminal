// 复现「服务器启动后第一次浏览器访问无样式，刷新才正常」：
// 冷启动 server + 全新浏览器 profile，记录首页与全部静态资源的响应状态/类型
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib.js");

(async () => {
  const port = 8791;
  const { base, server } = await lib.startServer(port);
  console.log("server:", base);

  const browser = await lib.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const reqs = [];
  page.on("response", async r => {
    const u = r.url();
    if (!u.startsWith(base)) return;
    let ct = "";
    try { ct = r.headers()["content-type"] || ""; } catch (e) {}
    reqs.push({ p: u.slice(base.length), s: r.status(), ct });
  });
  page.on("requestfailed", r => {
    reqs.push({ p: r.url().slice(base.length), s: "FAILED", ct: r.failure()?.errorText || "" });
  });

  await page.goto(base + "/", { waitUntil: "load" });
  await page.waitForTimeout(1500);

  const sheets = await page.evaluate(() =>
    Array.from(document.styleSheets).map(s => {
      let n = -1;
      try { n = s.cssRules.length; } catch (e) { n = "ERR:" + e.name; }
      return { href: s.href, rules: n };
    }));
  const bodyCls = await page.evaluate(() => ({
    sheetsCount: document.styleSheets.length,
    sidebarDisplay: getComputedStyle(document.getElementById("sidebar") || document.body).display,
    bg: getComputedStyle(document.body).backgroundColor,
  }));

  console.log("requests:", JSON.stringify(reqs, null, 1));
  console.log("stylesheets:", JSON.stringify(sheets, null, 1));
  console.log("computed:", JSON.stringify(bodyCls));

  // 第二次导航（等价刷新）对比
  await page.goto(base + "/", { waitUntil: "load" });
  await page.waitForTimeout(800);
  console.log("after-reload requests:", JSON.stringify(reqs.slice(reqs.length), null, 1));
  const sheets2 = await page.evaluate(() => document.styleSheets.length);
  console.log("after-reload sheets:", sheets2);

  await browser.close();
  if (server) server.kill();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
