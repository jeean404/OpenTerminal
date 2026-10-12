// 文件面板改造冒烟：验证「直连 + 四栏登录 + 选中交互 + 图标工具栏」在真浏览器里成立。
// 只跑不需要真实 SSH 的部分：页面无 JS 报错、入口存在、弹框四栏结构与默认值、
// 工具栏是图标 + title。要跑完整登录/列目录走 diag-files-panel.cjs。
"use strict";
const { REPO, startServer, launch, openTab, pickTarget } = require("./lib");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT = Number(process.argv[2] || 8399);
const TARGET = "smoke-ssh";
let fails = 0;
function record(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
}

// 隔离 HOME：不碰用户真实配置/凭据库，并种一条 SSH 目标——本机（local）
// 终端没有「最终服务器」，📁 入口本就该隐藏，验不到登录弹框。
const home = path.join(REPO, ".tmp", "live", "smoke-fp-home");
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
    const title = await btn.getAttribute("title");
    record("入口 title 不再说「跟随终端目录」",
      !!title && !/当前所在目录/.test(title), title);

    await btn.click();
    await page.waitForTimeout(1200);

    // 四栏登录表单
    const modal = page.locator("#modal-root .modal");
    record("点 📁 弹出登录表单", (await modal.count()) > 0);
    for (const [id, label] of [["fp-host", "IP 地址"], ["fp-port", "端口"],
                               ["fp-user", "用户名"], ["fp-pass", "密码"]]) {
      const n = await page.locator(`#${id}`).count();
      record(`表单有「${label}」栏 (#${id})`, n > 0);
    }
    const remember = await page.locator("#fp-remember").count();
    record("表单有「记住密码」", remember > 0);

    const formGrid = await page.locator("#modal-root .form-grid").count();
    record("表单用 .form-grid 布局（复用既有表单范式）", formGrid > 0);

    // 工具栏图标 + title
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => { document.getElementById("modal-root").innerHTML = ""; });
    const acts = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".files-panel .fp-head-acts button"))
        .map(b => ({ text: b.textContent.trim(), title: b.title })));
    record("工具栏按钮都带 title 悬浮提示",
      acts.length > 0 && acts.every(a => a.title), JSON.stringify(acts));
    const TEXT_BTN = ["＋目录", "＋文件", "⌂ 家目录", "⇄ 主机", "上传文件"];
    const hasText = acts.filter(a => TEXT_BTN.includes(a.text));
    record("文字按钮已换成图标", hasText.length === 0,
      hasText.map(a => a.text).join(",") || "无");
    const actTexts = acts.map(a => a.text).join("");
    record("工具栏是图标不是中文文案", !/[一-鿿]/.test(actTexts), actTexts);

    // 底部上传按钮也是图标
    const up = await page.evaluate(() => {
      const b = document.querySelector(".files-panel .fp-up");
      return b ? { text: b.textContent.trim(), title: b.title } : null;
    });
    record("上传按钮是图标 + title",
      !!up && up.title && !/[一-鿿]/.test(up.text), JSON.stringify(up));

    // 页面最终无报错
    record("全程无 JS 报错", errors.length === 0, errors.join(" | "));

    await page.screenshot({
      path: path.join(REPO, ".tmp", "live", "smoke-files-panel.png"),
    });
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(`\n${fails ? "FAIL" : "PASS"}  ${fails} 项失败`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("冒烟脚本异常:", e);
  process.exit(1);
});
