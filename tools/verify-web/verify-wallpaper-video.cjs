// 真机浏览器验证：外观 →「我的图片 / 视频」上传 MP4/WebM，静音循环作背景。
// 覆盖：视频上传→解码→循环、画面真的在动且非黑帧、object-fit 映射、播放开关、
//       切回图片不残留、类型/体积拒绝、刷新后从 IndexedDB 恢复、减少动效时停播。
//
// 浏览器选择：优先系统 Chrome / Edge（含 H.264，即用户和参考站的真实格式）；
// 只有自带 Chromium 时退化为 VP9-in-MP4 测容器路径——自带包不含 H.264 专有编解码器，
// 这是测试环境限制，不是应用缺陷（Firefox/Chrome/Edge 均支持 H.264）。
//
// 测试片段由 ffmpeg 现场生成（testsrc 有连续运动，便于断言画面在动）。
// 用法: node tools/verify-web/verify-wallpaper-video.cjs [port]
"use strict";
const lib = require("./lib");
const { chromium } = require("playwright");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const PORT = Number(process.argv[2] || 8421);
const FIX = path.join(lib.OUT, "wallpaper-fixtures");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  say(ok ? "PASS" : "FAIL", name, detail ? `(${detail})` : "");
}

async function waitFor(page, fn, label, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      last = await page.evaluate(fn);
      if (last) return last;
    } catch (e) { last = String(e.message); }
    await sleep(200);
  }
  throw new Error(`超时：${label}（最后取值 ${JSON.stringify(last)}）`);
}

// ffmpeg 生成：2s 640x360 testsrc
function makeFixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  const specs = [
    ["clip.mp4", ["-c:v", "libx264", "-profile:v", "baseline", "-level", "3.0",
                  "-pix_fmt", "yuv420p", "-movflags", "+faststart"]],
    ["clip-vp9.mp4", ["-c:v", "libvpx-vp9", "-b:v", "400k",
                      "-pix_fmt", "yuv420p", "-movflags", "+faststart"]],
    ["clip.webm", ["-c:v", "libvpx-vp9", "-b:v", "400k", "-pix_fmt", "yuv420p"]],
    ["clip.png", null],
  ];
  for (const [name, enc] of specs) {
    const out = path.join(FIX, name);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) continue;
    const args = ["-y", "-v", "error", "-f", "lavfi",
                  "-i", "testsrc=size=640x360:rate=15:duration=2"];
    if (!enc) args.push("-frames:v", "1", out);
    else args.push(...enc, out);
    const r = spawnSync("ffmpeg", args, { stdio: "ignore" });
    if (r.status !== 0 || !fs.existsSync(out))
      throw new Error(`ffmpeg 生成 ${name} 失败（PATH 里需要 ffmpeg）`);
    say("生成", name, `${fs.statSync(out).size} B`);
  }
}

// 系统 Chrome/Edge 才有 H.264；自带 Chromium 只能走 VP9
async function launchBrowser() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  for (const opts of [
    { channel: "chrome", label: "系统 Chrome（H.264）" },
    { channel: "msedge", label: "系统 Edge（H.264）" },
    { label: "Playwright 自带 Chromium（无 H.264）" },
  ]) {
    try {
      const browser = await chromium.launch({ headless: true, args, ...(opts.channel ? { channel: opts.channel } : {}) });
      return { browser, label: opts.label, h264: !!opts.channel };
    } catch (e) { /* 换下一个 */ }
  }
  throw new Error("无法启动任何 Chromium 内核浏览器");
}

async function upload(page, name, mimeType, buffer) {
  await page.setInputFiles("#wallpaper-image-input", { name, mimeType, buffer });
}

// 磁贴文本里含文件名；用完整文件名定位，避免 clip. 前缀误点到别的背景
async function clickTile(page, name) {
  await page.locator("#wallpaper-gallery [data-wallpaper-image]", { hasText: name })
    .first().click();
  await sleep(600);
}

function readVideo(page) {
  return page.evaluate(() => {
    const v = document.getElementById("wallpaper-video");
    if (!v) return null;
    const root = document.documentElement;
    return {
      hidden: v.hidden, paused: v.paused, muted: v.muted, loop: v.loop,
      currentTime: v.currentTime, duration: v.duration,
      videoWidth: v.videoWidth, readyState: v.readyState, src: v.src,
      objectFit: getComputedStyle(v).objectFit, opacity: getComputedStyle(v).opacity,
      active: root.dataset.wallpaperActive || "",
      imageVar: root.style.getPropertyValue("--wallpaper-image") || "",
    };
  });
}

// 把当前帧画到 32x18 画布上取特征：avg 判非黑帧，sig 判画面在动
function frameSignature(page) {
  return page.evaluate(() => {
    const v = document.getElementById("wallpaper-video");
    const c = document.createElement("canvas");
    c.width = 32; c.height = 18;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, 0, 32, 18);
    const d = ctx.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return { avg: sum / (d.length / 4), sig: c.toDataURL().slice(-48) };
  });
}

// 已解码帧数：循环回绕时 currentTime 会归零，totalVideoFrames 单调递增，
// 用它判断「在播」才不会被 2 秒短夹具的回绕误判成停播
function decodedFrames(page) {
  return page.evaluate(() => {
    const v = document.getElementById("wallpaper-video");
    const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    return q ? q.totalVideoFrames : -1;
  });
}

async function shot(page, name) {
  const out = path.join(lib.OUT, `wallpaper-${name}.png`);
  await page.screenshot({ path: out });
  say("截图", out);
}

async function openAppearance(page, base) {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { timeout: 20000 });
  await page.click("#btn-settings");
  await page.waitForFunction(() => {
    const v = document.getElementById("settings-view");
    return v && !v.hidden;
  });
  await page.click('[data-settings-section="appearance"]');
  await page.waitForSelector("#wallpaper-upload", { timeout: 10000 });
}

async function main() {
  makeFixtures();
  const { base, server } = await lib.startServer(PORT);
  say("服务端", base, server ? "本次拉起" : "复用已有");
  const { browser, label: browserLabel, h264 } = await launchBrowser();
  say("浏览器", browserLabel, h264 ? "→ 用 H.264 clip.mp4" : "→ 用 VP9 clip-vp9.mp4");
  const mp4 = h264 ? "clip.mp4" : "clip-vp9.mp4";
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => {
    if (m.type() !== "error") return;
    const loc = m.location() ? m.location().url : "";
    // favicon 404 是历史遗留，与背景无关；按 URL 而不是文案过滤
    if (/favicon/i.test(m.text()) || /favicon/i.test(loc)) return;
    errors.push(`console: ${m.text()} @ ${loc}`);
  });
  page.on("response", r => {
    if (r.status() >= 400) say("HTTP", r.status(), r.url());
  });

  try {
    await openAppearance(page, base);

    // --- 1. 上传 MP4 ---
    await upload(page, mp4, "video/mp4", fs.readFileSync(path.join(FIX, mp4)));
    const tile = await waitFor(page, () => {
      const t = [...document.querySelectorAll("#wallpaper-gallery [data-wallpaper-image]")]
        .find(el => (el.textContent || "").includes("clip"));
      return t ? { id: t.dataset.wallpaperImage, text: t.textContent.trim() } : null;
    }, "MP4 落库并出现在画廊");
    check("MP4 上传后出现在「我的图片 / 视频」", !!tile, tile && tile.text);
    check("视频角标显示 ▶ 与片长", !!tile && /▶/.test(tile.text), tile && tile.text);
    // 截证前等缩略图解码完，否则拍到的是空磁贴
    await waitFor(page, () => {
      const img = document.querySelector("#wallpaper-gallery [data-wallpaper-image] img");
      return img && img.complete && img.naturalWidth > 0;
    }, "磁贴缩略图解码");
    check("磁贴缩略图已解码出画面", true);
    await page.locator("#wallpaper-gallery").scrollIntoViewIfNeeded();
    await sleep(200);
    await shot(page, "01-uploaded");

    // --- 2. 循环播放 + 画面真的在动 ---
    const v1 = await waitFor(page, () => {
      const v = document.getElementById("wallpaper-video");
      return v && !v.hidden && v.readyState >= 2 ? {
        hidden: v.hidden, muted: v.muted, loop: v.loop,
        currentTime: v.currentTime, videoWidth: v.videoWidth, src: v.src,
      } : null;
    }, "视频图层就绪并开始解码");
    check("视频图层显示且解码出画面", !v1.hidden && v1.videoWidth > 0, `videoWidth=${v1.videoWidth}`);
    check("静音（自动播放策略要求）", v1.muted === true);
    check("loop 开启（循环播放）", v1.loop === true);
    check("blob: 本地对象 URL，不上传服务端", v1.src.startsWith("blob:"), v1.src.slice(0, 24));
    const t0 = v1.currentTime;
    await sleep(900);
    const t1 = (await readVideo(page)).currentTime;
    check("currentTime 在走", t1 > t0, `${t0.toFixed(3)} → ${t1.toFixed(3)}`);
    const f1 = await frameSignature(page);
    await sleep(700);
    const f2 = await frameSignature(page);
    check("解出的帧不是黑屏", f1.avg > 8, `平均亮度 ${f1.avg.toFixed(1)}`);
    check("画面在动（帧特征变化）", f1.sig !== f2.sig);
    const st = await readVideo(page);
    check("根节点标记 wallpaperActive=video", st.active === "video", st.active);
    check("静态图层已撤下 --wallpaper-image", st.imageVar === "", st.imageVar || "(空)");
    await shot(page, "02-playing");

    // 关掉设置看真实桌面效果：视频应该铺在终端下面
    await page.click("#btn-close-settings");
    await sleep(400);
    await shot(page, "02b-as-background");
    await page.click("#btn-settings");
    await page.click('[data-settings-section="appearance"]');
    await sleep(300);

    // --- 3. object-fit 映射 ---
    for (const [fit, expect] of [["contain", "contain"], ["stretch", "fill"], ["cover", "cover"]]) {
      await page.selectOption("#wallpaper-fit", fit);
      await sleep(150);
      const got = (await readVideo(page)).objectFit;
      check(`显示方式「${fit}」→ object-fit:${expect}`, got === expect, got);
    }

    // --- 4. 播放开关 ---
    await page.uncheck("#wallpaper-video-play");
    await sleep(300);
    check("关掉「播放视频背景」后停播", (await readVideo(page)).paused === true);
    await page.check("#wallpaper-video-play");
    await sleep(300);
    const fa = await decodedFrames(page);
    await sleep(500);
    const fb = await decodedFrames(page);
    const resumed = await readVideo(page);
    check("重新打开后继续播放",
      resumed.paused === false && (fa < 0 || fb > fa),
      `paused=${resumed.paused} 已解码帧 ${fa}→${fb}`);
    await page.locator(".wallpaper-check").scrollIntoViewIfNeeded();
    await sleep(200);
    await shot(page, "04-controls");

    // --- 5. WebM 也收，且能切回 MP4 ---
    await upload(page, "clip.webm", "video/webm", fs.readFileSync(path.join(FIX, "clip.webm")));
    const tileW = await waitFor(page, () => {
      const t = [...document.querySelectorAll("#wallpaper-gallery [data-wallpaper-image]")]
        .find(el => (el.textContent || "").includes("clip.webm"));
      return t ? t.textContent.trim() : null;
    }, "WebM 落库");
    check("WebM 上传同样接受", !!tileW, tileW);
    await clickTile(page, mp4);
    const backToMp4 = await readVideo(page);
    check("可切回先前的 MP4 并继续播放",
      backToMp4.active === "video" && !backToMp4.paused,
      `active=${backToMp4.active} paused=${backToMp4.paused}`);

    // --- 6. 图片路径不回退 ---
    await upload(page, "clip.png", "image/png", fs.readFileSync(path.join(FIX, "clip.png")));
    await waitFor(page, () => {
      const t = [...document.querySelectorAll("#wallpaper-gallery [data-wallpaper-image]")]
        .find(el => (el.textContent || "").includes("clip.png"));
      return !!t;
    }, "PNG 落库");
    const imgState = await readVideo(page);
    check("切到图片后视频图层隐藏", imgState.hidden === true);
    check("切到图片后视频停播", imgState.paused === true);
    check("切到图片后 --wallpaper-image 回来", imgState.imageVar.includes("blob:"), imgState.imageVar);
    check("根节点标记 wallpaperActive=image", imgState.active === "image", imgState.active);
    await shot(page, "03-image-fallback");

    // --- 7. 拒绝路径 ---
    await upload(page, "note.txt", "text/plain", Buffer.from("hello"));
    await waitFor(page, () => {
      const e = document.getElementById("wallpaper-error");
      return e && !e.hidden && e.textContent ? e.textContent : null;
    }, "非法类型错误提示");
    check("非图片/视频类型被拒绝并提示", /请选择/.test(
      await page.textContent("#wallpaper-error")), (await page.textContent("#wallpaper-error")).slice(0, 50));

    // setInputFiles 的 buffer 上限 50 MB，超过只能走磁盘路径
    const hugePath = path.join(FIX, "huge.mp4");
    if (!fs.existsSync(hugePath) || fs.statSync(hugePath).size !== 65 * 1024 * 1024)
      fs.writeFileSync(hugePath, Buffer.alloc(65 * 1024 * 1024));
    await page.setInputFiles("#wallpaper-image-input", hugePath);
    await waitFor(page, () => {
      const e = document.getElementById("wallpaper-error");
      return e && !e.hidden && /64 MB/.test(e.textContent || "") ? e.textContent : null;
    }, "超体积错误提示");
    check("超过 64 MB 的视频被拒绝", true, (await page.textContent("#wallpaper-error")).slice(0, 50));
    fs.rmSync(hugePath, { force: true });
    await shot(page, "04-reject");

    // --- 8. 刷新后从 IndexedDB 恢复 ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-settings", { timeout: 20000 });
    await page.click("#btn-settings");
    await page.click('[data-settings-section="appearance"]');
    await waitFor(page, () => {
      const t = [...document.querySelectorAll("#wallpaper-gallery [data-wallpaper-image]")]
        .find(el => (el.textContent || "").includes("clip.png"));
      return !!t;
    }, "刷新后画廊恢复");
    check("刷新后自定义背景从 IndexedDB 恢复", true);
    await clickTile(page, mp4);
    const after = await waitFor(page, () => {
      const v = document.getElementById("wallpaper-video");
      return v && !v.hidden && v.readyState >= 2 && !v.paused
        ? { muted: v.muted, loop: v.loop, videoWidth: v.videoWidth } : null;
    }, "刷新后视频重新解码并播放");
    check("刷新后视频仍能静音循环播放",
      after.muted && after.loop && after.videoWidth > 0,
      `videoWidth=${after.videoWidth}`);
    await shot(page, "05-after-reload");

    // --- 9. prefers-reduced-motion 停播 ---
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-settings", { timeout: 20000 });
    await page.click("#btn-settings");
    await page.click('[data-settings-section="appearance"]');
    await clickTile(page, mp4);
    await sleep(800);
    const reduced = await readVideo(page);
    check("prefers-reduced-motion 下停在静止画面", reduced.paused === true,
      `paused=${reduced.paused} hidden=${reduced.hidden}`);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const relevant = errors.filter(e => /wallpaper|settings|probe|video|thumb/i.test(e));
    check("无背景/设置相关页面报错", relevant.length === 0, relevant.join(" | ") || "无");
    if (errors.length) say("全部控制台错误：", errors.join(" | "));
    await shot(page, "06-final");
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  const failed = results.filter(r => !r.ok);
  say(`\n浏览器 ${browserLabel} · MP4 夹具 ${mp4} · 合计 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length) {
    failed.forEach(f => say("  ✗", f.name));
    process.exitCode = 1;
  } else {
    say("DONE 全部通过");
  }
}

main().catch(error => {
  say("BLOCKED", error.message);
  process.exitCode = 1;
});
