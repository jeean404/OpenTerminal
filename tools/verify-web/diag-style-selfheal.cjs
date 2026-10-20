// 验证样式表自愈：首次加载时掐掉 style.css（模拟传输层抖动），
// 观察 300ms 后自愈重拉是否把样式补上
const lib = require("./lib.js");

(async () => {
  const port = 8792;
  const { base, server } = await lib.startServer(port);
  const browser = await lib.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let styleDropped = false;
  await page.route("**/static/style.css", route => {
    if (!styleDropped) { styleDropped = true; return route.abort(); }
    return route.continue();
  });
  await page.goto(base + "/", { waitUntil: "load" });
  const before = await page.evaluate(() => ({
    sheets: document.styleSheets.length,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    sheets: document.styleSheets.length,
    bg: getComputedStyle(document.body).backgroundColor,
    href: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => l.href),
  }));
  console.log("dropped-first-style.css:", styleDropped);
  console.log("before-heal:", JSON.stringify(before));
  console.log("after-heal :", JSON.stringify(after));
  const healed = after.sheets === 2 && after.bg !== "rgba(0, 0, 0, 0)";
  console.log(healed ? "PASS: 样式自愈成功" : "FAIL: 样式未恢复");
  await browser.close();
  if (server) server.kill();
  process.exit(healed ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
