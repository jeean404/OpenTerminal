// demo 录制：playwright 真浏览器操作 ot web 并录屏（webm）。
// 用法：node tools/demo-recorder/record.cjs [viddir] [port]
// 剧情与 serve_demo.py 的 DemoRunner 对齐：plain 彩色命令 → 自然语言任务 →
// 审批面板点执行 → 等总结卡 → 收尾留白。
const { chromium } = require("playwright");

const OUT = process.argv[2] || "vid";
const PORT = process.argv[3] || "8099";

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
  await page.waitForTimeout(900);

  // beat 1：plain 命令，彩色输出——「你的 shell 还是你说了算」
  await page.click(".xterm");
  await page.keyboard.type("ls /tmp/ot-demo", { delay: 35 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2800);

  // beat 2：自然语言任务 → 思考流 + 分析卡流式
  await page.keyboard.type("看看 /tmp/ot-demo 下哪些目录最占空间，给我一张表", { delay: 55 });
  await page.keyboard.press("Enter");

  // beat 3：审批面板——停顿让观看者读清命令再点执行
  await page.waitForSelector(".acard .apbtns button.primary", { timeout: 30000 });
  await page.waitForTimeout(2400);
  await page.click(".acard .apbtns button.primary");

  // beat 4：真命令输出落地 + 总结卡 markdown 表格
  await page.waitForSelector(".scard", { timeout: 30000 });
  await page.waitForTimeout(3600);

  const video = page.video();
  await page.close();
  await ctx.close();
  await browser.close();
  console.log(await video.path());
})().catch((e) => { console.error(e); process.exit(1); });
