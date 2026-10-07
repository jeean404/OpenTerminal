// 终端 demo 回放录屏：.cast 灌进 vendored xterm.js，playwright 录屏出 webm。
// 用法：NODE_PATH=$(npm root -g) node render_terminal.cjs <in.cast> <outdir> [speed]
// 之后再走 make_gif.sh webm→gif。回放用真实时间轴（speed 可加速），输出
// 尺寸 = xterm 100×30 @14px + 留白。
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CAST = process.argv[2] || "/tmp/ot-term.cast";
const OUT = process.argv[3] || "/tmp/vid-term";
const SPEED = parseFloat(process.argv[4] || "1");

const REPO = path.resolve(__dirname, "..", "..");
const VENDOR = path.join(REPO, "src/openterminal/web/frontend/vendor");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lines = fs.readFileSync(CAST, "utf8").trim().split("\n");
  const header = JSON.parse(lines[0]);
  const events = lines.slice(1).map((l) => JSON.parse(l));

  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<link rel="stylesheet" href="file://${VENDOR}/xterm.css">
<style>
  html, body { margin: 0; background: #0b0f14; }
  #wrap { padding: 18px 22px; }
</style>
</head><body>
<div id="wrap"><div id="term"></div></div>
<script src="file://${VENDOR}/xterm.js"></script>
<script>
  const term = new Terminal({
    cols: ${header.width}, rows: ${header.height},
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    cursorBlink: false,
    theme: {
      background: "#0b0f14", foreground: "#e6edf3", cursor: "#e6edf3",
      selectionBackground: "#3b4a5c",
    },
  });
  term.open(document.getElementById("term"));
  window.term = term;
</script>
</body></html>`;

  fs.mkdirSync(OUT, { recursive: true });
  const htmlPath = path.join(OUT, "replay.html");
  fs.writeFileSync(htmlPath, html);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    recordVideo: { dir: OUT, size: { width: 1080, height: 620 } },
    viewport: { width: 1080, height: 620 },
  });
  const page = await ctx.newPage();
  await page.goto(`file://${htmlPath}`);
  await page.waitForFunction(() => window.term && window.term._core);
  await sleep(600);

  const startWall = Date.now() / 1000;
  const t0 = events.length ? events[0][0] : 0;
  for (const [t, kind, data] of events) {
    if (kind !== "o") continue;
    const wait = (t - t0) / SPEED - (Date.now() / 1000 - startWall);
    if (wait > 0) await sleep(wait * 1000);
    await page.evaluate((d) => window.term.write(d), data);
  }
  await sleep(1200 / SPEED);

  const video = page.video();
  await page.close();
  await ctx.close();
  await browser.close();
  console.log(await video.path());
})().catch((e) => { console.error(e); process.exit(1); });
