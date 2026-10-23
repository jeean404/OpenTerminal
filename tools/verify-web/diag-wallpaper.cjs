// 诊断：外观上传视频后画廊/视频图层/错误提示的实时状态。
// 用法: node tools/verify-web/diag-wallpaper.cjs [port]
"use strict";
const lib = require("./lib");
const fs = require("node:fs");
const path = require("node:path");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8422);
const FIX = path.join(lib.OUT, "wallpaper-fixtures");

(async () => {
  const { base, server } = await lib.startServer(PORT);
  // 自带 Chromium 不含 H.264，MP4 要用系统 Chrome 才测得到
  const { chromium } = require("playwright");
  let browser;
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try {
      browser = await chromium.launch({
        headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], ...opts,
      });
      console.log("浏览器", opts.channel || "bundled");
      break;
    } catch (e) { /* 换下一个 */ }
  }
  if (!browser) throw new Error("无法启动浏览器");
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message, "\n", e.stack));
  page.on("console", m => {
    if (m.type() === "error") console.log("CONSOLE:", m.text());
  });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { timeout: 20000 });
  await page.click("#btn-settings");
  await page.waitForFunction(() => {
    const v = document.getElementById("settings-view");
    return v && !v.hidden;
  });
  await page.click('[data-settings-section="appearance"]');
  await sleep(500);
  console.log("gallery:", await page.evaluate(() => {
    const g = document.getElementById("wallpaper-gallery");
    return g ? g.innerHTML.slice(0, 200) : "NO #wallpaper-gallery";
  }));
  console.log("globals:", await page.evaluate(() => ({
    hasUpload: typeof handleWallpaperUpload,
    hasProbe: typeof probeWallpaperVideo,
    hasSync: typeof syncWallpaperVideo,
    hasSave: typeof saveWallpaperImage,
  })));
  const name = process.argv[3] || "clip.mp4";
  await page.setInputFiles("#wallpaper-image-input", {
    name,
    mimeType: name.endsWith(".webm") ? "video/webm"
      : name.endsWith(".png") ? "image/png" : "video/mp4",
    buffer: fs.readFileSync(path.join(FIX, name)),
  });
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const st = await page.evaluate(() => {
      const errEl = document.getElementById("wallpaper-error");
      const v = document.getElementById("wallpaper-video");
      return {
        tiles: document.querySelectorAll("#wallpaper-gallery [data-wallpaper-image]").length,
        err: errEl ? errEl.textContent : "(no #wallpaper-error)",
        errHidden: errEl ? errEl.hidden : null,
        thumb: (() => {
          const img = document.querySelector("#wallpaper-gallery [data-wallpaper-image] img");
          return img ? {
            complete: img.complete, naturalWidth: img.naturalWidth,
            src: (img.currentSrc || img.src || "").slice(0, 30),
            rendered: img.getBoundingClientRect().width,
          } : null;
        })(),        vid: v ? {
          hidden: v.hidden, src: (v.src || "").slice(0, 22),
          readyState: v.readyState, w: v.videoWidth, paused: v.paused,
        } : null,
        active: document.documentElement.dataset.wallpaperActive || "",
      };
    });
    if (st.tiles > 0 || (st.err && !st.errHidden)) {
      console.log("t=" + i, JSON.stringify(st, null, 1));
      break;
    }
    if (i === 29) console.log("TIMEOUT", JSON.stringify(st, null, 1));
  }
  // 把磁贴缩略图导成 PNG，肉眼核对内容
  const dataUrl = await page.evaluate(() => {
    const img = document.querySelector("#wallpaper-gallery [data-wallpaper-image] img");
    if (!img || !img.naturalWidth) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return { url: c.toDataURL("image/png"), avg: sum / (d.length / 4) };
  });
  if (dataUrl) {
    const out = path.join(lib.OUT, "diag-thumb.png");
    fs.writeFileSync(out, Buffer.from(dataUrl.url.split(",")[1], "base64"));
    console.log("缩略图导出", out, "平均亮度", dataUrl.avg.toFixed(1));
  } else {
    console.log("缩略图导不出去");
  }
  await browser.close();
  if (server) server.kill();
})().catch(e => { console.log("ERR", e.message, e.stack); process.exit(1); });
