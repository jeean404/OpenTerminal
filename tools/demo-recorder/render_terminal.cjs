// 终端 demo 回放录屏：.cast 灌进 vendored xterm.js，playwright 录屏出 webm。
// 用法：node render_terminal.cjs <in.cast> <outdir> [speed]
// 之后再走 make_gif.sh webm→gif。回放用真实时间轴（speed 可加速）。
//
// 画布尺寸按**实测字格**算：先开一页量出 cell 宽高，再据此定 viewport 与
// recordVideo 的 size。旧版写死 1080×620，字宽一偏就把终端右侧裁掉（旧
// 头图「markdown 表给你」被切就是这么来的）——两处必须同源同值。
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const CAST = process.argv[2] || "/tmp/ot-term.cast";
const OUT = process.argv[3] || "/tmp/vid-term";
const SPEED = parseFloat(process.argv[4] || "1");

const REPO = path.resolve(__dirname, "..", "..");
const VENDOR = path.join(REPO, "src/openterminal/web/frontend/vendor");
const PAD_X = 22, PAD_Y = 18;
const FONT = 'Menlo, Monaco, "Courier New", monospace';
const FONT_SIZE = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pageHtml(header) {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<link rel="stylesheet" href="file://${VENDOR}/xterm.css">
<style>
  html, body { margin: 0; background: #0b0f14; }
  #wrap { padding: ${PAD_Y}px ${PAD_X}px; }
</style>
</head><body>
<div id="wrap"><div id="term"></div></div>
<script src="file://${VENDOR}/xterm.js"></script>
<script>
  const term = new Terminal({
    cols: ${header.width}, rows: ${header.height},
    fontSize: ${FONT_SIZE},
    fontFamily: '${FONT}',
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
}

(async () => {
  const lines = fs.readFileSync(CAST, "utf8").trim().split("\n");
  const header = JSON.parse(lines[0]);
  const events = lines.slice(1).map((l) => JSON.parse(l));

  fs.mkdirSync(OUT, { recursive: true });
  const htmlPath = path.join(OUT, "replay.html");
  // file:// 要绝对路径 URL；相对路径在 Windows 上直接 napi 失败
  const htmlUrl = pathToFileURL(path.resolve(htmlPath)).href;
  fs.writeFileSync(htmlPath, pageHtml(header));

  const browser = await chromium.launch();

  // ① 量字格：同一个 HTML、同一套字体，量出来才作数
  const probe = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pp = await probe.newPage();
  await pp.goto(htmlUrl);
  await pp.waitForFunction(() => window.term && window.term._core);
  const cell = await pp.evaluate(() => {
    const d = window.term._core._renderService.dimensions.css.cell;
    return { w: d.width, h: d.height };
  });
  await probe.close();
  const W = Math.ceil(header.width * cell.w) + PAD_X * 2;
  const H = Math.ceil(header.height * cell.h) + PAD_Y * 2;
  console.log(`cell=${cell.w}x${cell.h}  canvas=${W}x${H} (${header.width}x${header.height})`);

  // ② 正式录屏：viewport 与 video size 同值，像素 1:1，不裁边
  const ctx = await browser.newContext({
    recordVideo: { dir: OUT, size: { width: W, height: H } },
    viewport: { width: W, height: H },
  });
  const page = await ctx.newPage();
  await page.goto(htmlUrl);
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
  await sleep(1400 / SPEED);

  const video = page.video();
  await page.close();
  await ctx.close();
  await browser.close();
  console.log(await video.path());
})().catch((e) => { console.error(e); process.exit(1); });
