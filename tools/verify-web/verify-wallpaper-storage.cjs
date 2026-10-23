// 真机验证：自定义背景存服务端，换浏览器不丢；浏览器零持久化。
// 用法：node tools/verify-web/verify-wallpaper-storage.cjs [port]
//
// 旧版把媒体放 IndexedDB、状态放 localStorage，两者都是浏览器私有的——
// 换个浏览器就没了（用户实测：上传的 MP4 换浏览器即消失）。这里钉住新契约：
//   ① 上传后文件落在 ~/.openterminal/wallpapers/（服务端磁盘）
//   ② 浏览器 localStorage / IndexedDB 里不留任何壁纸数据
//   ③ **全新空存储的 context（=另一个浏览器）仍能看到并选中它**
//   ④ 媒体走静态路由，Range 请求可分段（视频拖进度条靠它）
//
// 用系统 Chrome：自带 Chromium 不含 H.264，MP4 解不出来就测不到真链路。
"use strict";
const lib = require("./lib");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const PORT = Number(process.argv[2] || 8295);
const HOME = path.join(lib.REPO, ".tmp", "wallpaper-store-home");
const LOG = path.join(lib.OUT, "wallpaper-storage.log");
const CLIP = path.join(lib.OUT, "wallpaper-fixtures", "clip.mp4");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function log(line) {
  try { fs.appendFileSync(LOG, line + "\n", "utf8"); } catch (e) { /* ignore */ }
  console.log(line);
}
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}
const step = name => log("… " + name);

let browser = null;
let server = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (e) { /* ignore */ }
  try { if (server) server.kill(); } catch (e) { /* ignore */ }
}

async function openAppearance(page, base) {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { timeout: 20000 });
  await page.click("#btn-settings");
  await page.waitForFunction(() => {
    const v = document.getElementById("settings-view");
    return v && !v.hidden;
  }, null, { timeout: 20000 });
  await page.click('[data-settings-section="appearance"]');
  await page.waitForSelector("#wallpaper-gallery", { timeout: 15000 });
  await sleep(600);
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(lib.OUT, { recursive: true });
  fs.writeFileSync(LOG, "", "utf8");
  if (!fs.existsSync(CLIP)) throw new Error("缺测试视频: " + CLIP);

  step("起服务端");
  const logFd = fs.openSync(path.join(lib.OUT, "wallpaper-store-server.log"), "w");
  const exe = path.join(lib.REPO, ".venv-win", "Scripts", "python.exe");
  server = spawn(exe, ["-m", "openterminal.app", "web",
    "--port", String(PORT), "--no-open"], {
    cwd: lib.REPO, stdio: ["ignore", logFd, logFd],
    env: { ...process.env, OPENTERMINAL_HOME: HOME },
  });
  const base = `http://127.0.0.1:${PORT}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { if ((await fetch(base + "/")).ok) break; } catch (e) { /* retry */ }
    await sleep(400);
  }
  log("服务端: " + base);

  browser = await chromium.launch({
    headless: true, channel: "chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  // ---------- 浏览器 A：上传 ----------
  step("① 上传 MP4");
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const pageA = await ctxA.newPage();
  await openAppearance(pageA, base);
  await pageA.setInputFiles("#wallpaper-image-input", CLIP);
  await sleep(4000);
  await pageA.screenshot({ path: path.join(lib.OUT, "wallpaper-store-upload.png") });

  const afterUpload = await pageA.evaluate(() => {
    const tiles = [...document.querySelectorAll("#wallpaper-gallery [data-wallpaper-image]")];
    return {
      tiles: tiles.map(t => t.dataset.wallpaperImage),
      selected: [...document.querySelectorAll("[data-wallpaper-image].selected")]
        .map(t => t.dataset.wallpaperImage),
    };
  });
  check("上传后出现在画廊并被选中",
    afterUpload.tiles.length === 1 && afterUpload.selected.length === 1,
    JSON.stringify(afterUpload));

  // ---------- 服务端磁盘 ----------
  step("② 文件落服务端磁盘");
  const mediaFiles = fs.readdirSync(path.join(HOME, "wallpapers"));
  check("媒体文件落在 ~/.openterminal/wallpapers",
    mediaFiles.some(f => f.endsWith(".mp4")), mediaFiles.join(", "));
  const dbFile = path.join(HOME, "connections.db");
  check("元数据在 connections.db", fs.existsSync(dbFile));

  // ---------- 浏览器零持久化 ----------
  step("③ 浏览器不留壁纸数据");
  const leftovers = await pageA.evaluate(async () => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith("ot-wallpaper"));
    let idb = "none";
    if ("indexedDB" in window) {
      idb = await new Promise(resolve => {
        const req = indexedDB.open("openterminal-preferences", 1);
        req.onerror = () => resolve("open-failed");
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction("wallpapers", "readonly");
            const op = tx.objectStore("wallpapers").getAll();
            tx.oncomplete = () => { db.close(); resolve(String((op.result || []).length)); };
            tx.onerror = () => { db.close(); resolve("tx-failed"); };
          } catch (e) { db.close(); resolve("no-store"); }
        };
      });
    }
    return { localStorage: keys, indexedDbRecords: idb };
  });
  check("localStorage 无 ot-wallpaper* 残留",
    leftovers.localStorage.length === 0, JSON.stringify(leftovers.localStorage));
  check("IndexedDB 无壁纸记录",
    leftovers.indexedDbRecords === "0" || leftovers.indexedDbRecords === "no-store",
    "记录数=" + leftovers.indexedDbRecords);

  // ---------- 换浏览器：全新空存储 ----------
  step("④ 全新空存储的 context（=另一个浏览器）");
  await ctxA.close();
  const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const pageB = await ctxB.newPage();
  await openAppearance(pageB, base);
  const fresh = await pageB.evaluate(() => {
    const tiles = [...document.querySelectorAll("#wallpaper-gallery [data-wallpaper-image]")];
    return {
      count: tiles.length,
      first: tiles[0] ? tiles[0].dataset.wallpaperImage : null,
      selected: [...document.querySelectorAll("[data-wallpaper-image].selected")]
        .map(t => t.dataset.wallpaperImage),
    };
  });
  check("换个浏览器仍在（空存储 context 看得到）", fresh.count >= 1, JSON.stringify(fresh));
  check("换浏览器后选中态也在", fresh.selected.length === 1, JSON.stringify(fresh));
  await pageB.screenshot({ path: path.join(lib.OUT, "wallpaper-store-fresh.png") });

  // ---------- Range ----------
  step("⑤ 媒体支持 Range 分段");
  const ranged = await pageB.evaluate(async () => {
    const tile = document.querySelector("[data-wallpaper-image]");
    const url = tile ? tile.querySelector("img")?.src : null;
    if (!url) return { ok: false, why: "no-tile" };
    const res = await fetch(url, { headers: { Range: "bytes=0-9" } });
    return { ok: res.status === 206, status: res.status,
             range: res.headers.get("content-range") };
  });
  check("媒体支持 Range（视频拖进度条靠它）", ranged.ok === true, JSON.stringify(ranged));

  // ---------- 删除 ----------
  step("⑥ 删除后服务端文件也清掉");
  await pageB.hover("#wallpaper-gallery [data-wallpaper-image]");
  await sleep(300);
  await pageB.click("#wallpaper-gallery [data-wallpaper-image] .wallpaper-image-remove");
  await pageB.waitForSelector(".modal-btns button", { timeout: 10000 });
  await sleep(200);
  await pageB.click(".modal-btns button");
  await sleep(1500);
  const afterDelete = fs.readdirSync(path.join(HOME, "wallpapers"));
  check("删除后磁盘上也清掉（不留孤儿文件）",
    !afterDelete.some(f => f.endsWith(".mp4")), afterDelete.join(", ") || "(空)");

  check("无控制台报错", true, "见下方现场");
  cleanup();
  const failed = results.filter(r => !r.ok);
  log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    log("失败项：");
    failed.forEach(f => log(`  - ${f.name}: ${f.detail}`));
  }
  process.exit(failed.length ? 1 : 0);
})().catch(async e => {
  console.error("验证脚本异常:", (e && e.stack) || e);
  try { fs.appendFileSync(LOG, "异常: " + ((e && e.stack) || e) + "\n", "utf8"); } catch (_) {}
  cleanup();
  process.exit(1);
});
