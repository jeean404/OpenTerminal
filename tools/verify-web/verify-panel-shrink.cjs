// 文件面板弹出时终端应自适应收缩（不再被面板覆盖）。
// 量法：真浏览器读 .term / .files-panel 的 getBoundingClientRect +
// 状态栏 cols×rows。不依赖 SSH 登录——面板 toggle 即建元素，登录弹框
// 盖在上面不影响几何测量。
// 用法: node tools/verify-web/verify-panel-shrink.cjs [port]
"use strict";
const { REPO, startServer, launch, openTab, pickTarget } = require("./lib");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT = Number(process.argv[2] || 8401);
const TARGET = "smoke-ssh";
let fails = 0;
function record(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
}

// 隔离 HOME + 种一条 SSH 目标（本机 local 终端没有 📁 入口，验不到面板）
const home = path.join(REPO, ".tmp", "live", "shrink-fp-home");
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
function pythonExe() {
  for (const c of [
    path.join(REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}
{
  const r = spawnSync(pythonExe(), [
    path.join(REPO, "tools", "verify-web", "fixtures", "seed-saved-conn.py")], {
    cwd: REPO,
    env: {
      ...process.env, OPENTERMINAL_HOME: home, PYTHONIOENCODING: "utf-8",
      OT_SEED_NAME: TARGET, OT_SEED_HOST: "127.0.0.1",
      OT_SEED_PORT: "2222", OT_SEED_USER: "ubuntu",
      OT_SEED_COMMANDS: "cd /tmp",
    },
    encoding: "utf8",
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.status !== 0 || out.indexOf(TARGET) === -1) {
    throw new Error("seed connections.db 失败: " + out);
  }
}

(async () => {
  const { base, server } = await startServer(PORT, {
    env: { OPENTERMINAL_HOME: home },
  });
  const browser = await launch();
  try {
    const { page, errors } = await openTab(browser, base);
    record("页面加载无 JS 报错", errors.length === 0, errors.join(" | "));

    await pickTarget(page, TARGET);
    await page.waitForTimeout(2500);

    const btn = page.locator(".files-toggle").first();
    record("📁 入口按钮存在", (await btn.count()) > 0);

    // 几何量法：面板左缘 ≥ 终端右缘 = 无水平遮挡
    const geom = () => page.evaluate(() => {
      const term = document.querySelector(".pane.active .term");
      const panel = document.querySelector(".files-panel");
      const box = el => el ? el.getBoundingClientRect().toJSON() : null;
      const size = document.querySelector(".pane.active .status-size");
      return { term: box(term), panel: box(panel),
               size: size ? size.textContent : null,
               panelHidden: panel ? panel.hidden : null };
    });

    const before = await geom();
    record("初始面板隐藏", before.panel == null || before.panelHidden === true,
      `panel=${before.panel ? "存在" : "未构建"}`);
    record("初始有 cols×rows", /\d+×\d+/.test(before.size || ""), before.size);

    await btn.click();
    await page.waitForTimeout(600);
    const open = await geom();
    record("面板已显示", open.panelHidden === false && open.panel && open.panel.width > 0,
      JSON.stringify(open.panel));

    const gap = open.panel.left - open.term.right;
    record("终端收缩：面板不遮挡终端（面板左缘≥终端右缘）", gap >= -1,
      `term.right=${open.term.right.toFixed(0)} panel.left=${open.panel.left.toFixed(0)} gap=${gap.toFixed(0)}`);

    const colsOpen = open.size ? Number((open.size.match(/(\d+)×/) || [])[1]) : null;
    const colsBefore = before.size ? Number((before.size.match(/(\d+)×/) || [])[1]) : null;
    record("PTY 列宽同步收缩（cols 变小）", colsOpen !== null && colsBefore !== null && colsOpen < colsBefore,
      `${colsBefore} → ${colsOpen}`);

    // 关闭面板：终端应恢复原宽
    const x = page.locator(".files-panel [data-act='close']").first();
    await x.click();
    await page.waitForTimeout(600);
    const closed = await geom();
    record("面板已隐藏", closed.panelHidden === true);
    const widthRestored = Math.abs(closed.term.width - before.term.width) <= 2;
    record("终端宽度恢复", widthRestored,
      `before=${before.term.width.toFixed(0)} after=${closed.term.width.toFixed(0)}`);
    const colsClosed = closed.size ? Number((closed.size.match(/(\d+)×/) || [])[1]) : null;
    record("PTY 列宽恢复", colsClosed === colsBefore, `${colsBefore} → ${colsClosed}`);

    record("全程无 JS 报错", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close().catch(() => {});
    if (server) server.kill();
  }
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("FATAL:", e); process.exit(2); });
