// demo 录制：playwright 真浏览器操作 ot web 并录屏（webm）。
// 用法：node tools/demo-recorder/record.cjs [viddir] [port]
// 剧情与 serve_demo.py 的 DemoRunner 对齐：plain 彩色命令 → 自然语言任务 →
// 思考/分析流式 → 只读 du 原地跑 → 高危删除进审批 → 执行+二次确认 → 总结卡。
const { chromium } = require("playwright");

const OUT = process.argv[2] || "vid";
const PORT = process.argv[3] || "8099";
const TASK = "看看 /tmp/ot-demo 下哪些目录最占空间，清掉 build-cache，给我一张表";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "domcontentloaded" });

  // 侧栏开 local tab（真终端 pane 出现）
  await page.click('[data-name="local"]');
  await page.waitForSelector(".xterm-helper-textarea", { timeout: 20000 });
  await page.getByText("已连接").first().waitFor({ timeout: 20000 });
  // 连接耗时打成 TRIM 行：make_gif 用它裁掉片头死等
  console.log(`TRIM=${Math.max(0, (Date.now() - t0) / 1000 - 0.6).toFixed(2)}`);
  await page.waitForTimeout(1100);

  // beat 1：plain 命令，彩色输出——「你的 shell 还是你说了算」
  await page.click(".xterm");
  await page.keyboard.type("ls /tmp/ot-demo", { delay: 35 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2600);

  // beat 2：自然语言任务 → 思考流 + 分析卡流式 → 只读 du 自己跑完
  await page.keyboard.type(TASK, { delay: 50 });
  await page.keyboard.press("Enter");
  // 等审批卡长出「执行」按钮：在此之前 du 已原地跑完（看一眼不花钱）
  await page.waitForSelector(".acard .apbtns button.primary", { timeout: 45000 });
  await page.waitForTimeout(2200);

  // beat 3：点执行 → 高危二次确认框，停顿让观看者看清红线
  await page.click(".acard .apbtns button.primary");
  await page.waitForSelector(".apconfirm button.primary", { timeout: 15000 });
  await page.waitForTimeout(1600);

  // beat 4：确认执行 → 删除落地 + 总结卡 markdown 表格
  await page.click(".apconfirm button.primary");
  await page.waitForSelector(".scard", { timeout: 30000 });
  await page.waitForTimeout(4200);

  const video = page.video();
  await page.close();
  await ctx.close();
  await browser.close();
  console.log(await video.path());
})().catch((e) => { console.error(e); process.exit(1); });
