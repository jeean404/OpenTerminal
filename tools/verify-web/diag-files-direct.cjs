// 文件面板改造·真机链路：直连登录 → 落登录用户家目录 → 选中/双击/下载按钮
// → 记住密码后二次自动连。拓扑用 docker ot-repro（127.0.0.1:2222 端口映射，
// 宿主可直达——容器内网 172.17.0.2 从 Windows 宿主不可路由，直连必须走映射端口）。
//
// 覆盖需求 1/2/3/4：
//   1 弹框四栏 + 默认值来自终端最终服务器/当前用户
//   2 记住密码后二次打开自动连接、不再弹框
//   3 登录成功默认进当前用户目录
//   4 单击＝选中，双击才进入/打开，下载是独立按钮
"use strict";
const { REPO, startServer, launch, openTab, pickTarget } = require("./lib");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT = Number(process.argv[2] || 8411);
const TARGET = "fp-direct";
const HOST = "127.0.0.1", PORT_N = 2222, USER = "ubuntu";
const PASS = process.env.OT_FP_PASS || "ub123456";
let fails = 0;
function record(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
}

const home = path.join(REPO, ".tmp", "live", "fp-direct-home");
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
      OT_SEED_NAME: TARGET, OT_SEED_HOST: HOST,
      OT_SEED_PORT: String(PORT_N), OT_SEED_USER: USER,
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
  // 凭据库隔离：fake_keyring 落 JSON 文件。不隔离的话「记住密码」写进
  // Windows 凭据管理器，下次运行就直接自动连，验不到首次弹框那条路径。
  const keyringJson = path.join(home, "keyring.json");
  fs.rmSync(keyringJson, { force: true });
  const { base, server } = await startServer(PORT, {
    env: {
      OPENTERMINAL_HOME: home,
      PYTHONIOENCODING: "utf-8",
      PYTHONPATH: path.join(REPO, "tools", "verify-web", "fixtures"),
      PYTHON_KEYRING_BACKEND: "fake_keyring.Keyring",
      OT_FAKE_KEYRING: keyringJson,
    },
  });
  const browser = await launch();
  try {
    const { page, errors } = await openTab(browser, base);
    await pickTarget(page, TARGET);

    // 终端自己的 TOFU：隔离 HOME 下 known_hosts 为空，连 SSH 必弹「主机密钥」，
    // 不点掉它整页被遮罩挡着，📁 入口点不到。
    await page.waitForTimeout(1500);
    for (let i = 0; i < 3; i++) {
      const hostKey = await page.locator("#modal-root .modal h3", {
        hasText: "主机密钥",
      }).count();
      if (!hostKey) break;
      await page.locator("#modal-root .modal-btns button.primary").click();
      await page.waitForTimeout(1500);
    }
    record("终端 TOFU 主机密钥确认框已处理",
      (await page.locator("#modal-root .modal").count()) === 0);
    await page.waitForTimeout(2500);

    // --- 需求 1：点 📁 弹四栏，默认值来自终端最终服务器/当前用户 ---
    await page.locator(".files-toggle").first().click();
    await page.waitForTimeout(1200);
    console.log("  [diag] 面板 =", JSON.stringify(await page.evaluate(() => {
      const panel = document.querySelector(".files-panel");
      return {
        panelExists: !!panel,
        hidden: panel ? panel.hidden : null,
        btnHidden: (document.querySelector(".files-toggle") || {}).hidden,
        list: (document.querySelector(".files-panel .fp-list") || {}).innerHTML,
        path: (document.querySelector(".files-panel .fp-path") || {}).innerHTML,
        modal: (document.getElementById("modal-root") || {}).innerHTML,
      };
    })).slice(0, 500));
    record("首次（凭据库为空）点 📁 弹出登录表单",
      (await page.locator("#modal-root .modal").count()) > 0);

    const host = await page.locator("#fp-host").inputValue();
    const port = await page.locator("#fp-port").inputValue();
    const user = await page.locator("#fp-user").inputValue();
    record("IP 默认＝终端连接的最终服务器", host === HOST, `got ${host}`);
    record("端口默认＝终端连接的端口", port === String(PORT_N), `got ${port}`);
    record("用户名默认＝终端当前用户", user === USER, `got ${user}`);

    const passType = await page.locator("#fp-pass").getAttribute("type");
    record("密码栏是密文且不预填", passType === "password",
      `type=${passType}`);

    // --- 登录（勾记住密码）---
    await page.locator("#fp-pass").fill(PASS);
    await page.locator("#fp-remember").check();
    await page.locator("#modal-root .modal-btns button.primary").click();
    await page.waitForTimeout(2500);

    // TOFU：隔离 HOME 下 known_hosts 为空，首次连必弹「确认未知主机」。
    // 代际号必须守住——否则这个确认框会被登录框的 close 清掉（表现为点了没反应）
    const tofu = await page.locator("#modal-root .modal h3", {
      hasText: "确认未知主机",
    }).count();
    if (tofu) {
      const fpText = await page.locator("#modal-root .modal-body").innerText();
      record("未知主机弹 TOFU 确认框并展示指纹",
        /SHA256|密钥未知/.test(fpText), fpText.replace(/\s+/g, " ").slice(0, 90));
      await page.locator("#modal-root .modal-btns button.primary").click();
      await page.waitForTimeout(3500);
    } else {
      record("未知主机弹 TOFU 确认框并展示指纹", true, "known_hosts 已有记录，无需 TOFU");
    }

    const afterLogin = await page.evaluate(() => {
      const list = document.querySelector(".files-panel .fp-list");
      return {
        modalOpen: !!document.querySelector("#modal-root .modal"),
        rows: Array.from(document.querySelectorAll(".files-panel .fp-row .fp-name"))
          .map(n => n.textContent),
        path: (document.querySelector(".files-panel .fp-path") || {}).textContent,
        badge: (document.querySelector(".files-panel .fp-badge") || {}).textContent,
      };
    });
    record("登录后弹框关闭、列出目录", !afterLogin.modalOpen && afterLogin.rows.length > 0,
      JSON.stringify(afterLogin).slice(0, 200));

    // --- 需求 3：默认进登录用户的家目录（不是终端的 cd /tmp）---
    const homePath = afterLogin.path || "";
    record("登录后落在登录用户家目录（不是终端 cwd）",
      /home\/ubuntu|^~|^\/home\/ubuntu/.test(homePath) ||
        afterLogin.rows.includes(".bashrc") || afterLogin.rows.includes(".profile"),
      `path=${homePath} rows=${afterLogin.rows.slice(0, 8).join(",")}`);
    record("没有跟终端的 cd /tmp 走", !/^\/tmp/.test(homePath), `path=${homePath}`);

    // --- 需求 4：单击＝选中 ---
    const first = page.locator(".files-panel .fp-row").first();
    await first.click();
    await page.waitForTimeout(300);
    const sel1 = await page.evaluate(() => ({
      active: !!document.querySelector(".files-panel .fp-row.active"),
      stillListed: document.querySelectorAll(".files-panel .fp-row").length,
    }));
    record("单击＝选中（高亮且不跳走）",
      sel1.active && sel1.stillListed === afterLogin.rows.length,
      JSON.stringify(sel1));

    // --- 需求 4：双击目录进入 ---
    const dirName = await page.evaluate(() => {
      const d = document.querySelector(".files-panel .fp-row.dir .fp-name");
      return d ? d.textContent : null;
    });
    if (dirName) {
      const before = afterLogin.path;
      await page.locator(".files-panel .fp-row.dir").first().dblclick();
      await page.waitForTimeout(1500);
      const after = await page.evaluate(() =>
        (document.querySelector(".files-panel .fp-path") || {}).textContent);
      record("双击目录进入", after !== before, `${before} -> ${after}`);
    } else {
      record("双击目录进入（家目录下无子目录，跳过）", true, "无 dir 行");
    }

    // --- 需求 4：文件行有独立下载按钮 ---
    const dlInfo = await page.evaluate(() => {
      const fileRow = Array.from(document.querySelectorAll(".files-panel .fp-row"))
        .find(r => !r.classList.contains("dir"));
      if (!fileRow) return null;
      const acts = fileRow.querySelector(".fp-acts");
      return acts
        ? Array.from(acts.querySelectorAll("button")).map(b => b.title) : [];
    });
    record("文件行有独立的下载按钮", !!dlInfo && dlInfo.includes("下载"),
      JSON.stringify(dlInfo));

    // --- 工具栏图标 ---
    const acts = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".files-panel .fp-head-acts button"))
        .map(b => ({ text: b.textContent.trim(), title: b.title })));
    record("工具栏图标都带 title", acts.length > 0 && acts.every(a => a.title),
      JSON.stringify(acts));

    // --- 需求 2：断开后再点 📁，用记住的密码自动连、不弹框 ---
    await page.locator('.files-panel [data-act="link"]').click();
    await page.waitForTimeout(600);
    const hasDisconnect = await page.locator("#modal-root .modal-btns button", {
      hasText: "断开连接",
    }).count();
    record("连接设置里可断开当前连接", hasDisconnect > 0);
    if (hasDisconnect) {
      await page.locator("#modal-root .modal-btns button", { hasText: "断开连接" })
        .click();
      await page.waitForTimeout(1500);
    }
    // 断开后弹的是登录框（正确：让用户重新登录）；测「记住密码自动连」
    // 要先把框关掉，再重开面板
    await page.locator("#modal-root .modal-btns button", { hasText: "取消" })
      .click().catch(() => {});
    await page.waitForTimeout(500);
    // 重开面板 → 应静默自动连（不弹框）
    await page.locator(".files-toggle").first().click();   // 关
    await page.waitForTimeout(400);
    await page.locator(".files-toggle").first().click();   // 开
    await page.waitForTimeout(3500);
    const auto = await page.evaluate(() => ({
      modalOpen: !!document.querySelector("#modal-root .modal"),
      rows: document.querySelectorAll(".files-panel .fp-row").length,
    }));
    record("记住密码后二次打开自动连接、不再弹框",
      !auto.modalOpen && auto.rows > 0, JSON.stringify(auto));
    const stored = fs.existsSync(keyringJson)
      ? Object.keys(JSON.parse(fs.readFileSync(keyringJson, "utf8"))).join(",")
      : "";
    record("「记住密码」确实写进了凭据库", !!stored, stored);

    // --- 服务端硬约束：新建不截断同名旧文件、上传文件名不能路径穿越 ---
    const api = async (method, action, params, body) => {
      const q = new URLSearchParams(params || {});
      const tok = await page.evaluate(() => sessionStorage.getItem("ot-token") || "");
      return fetch(`${base}/api/tabs/${tabId}/files/${action}?${q}`, {
        method,
        headers: { "x-ot-token": tok, ...(body ? {"Content-Type": "text/plain"} : {}) },
        body,
      });
    };
    const tabId = await page.evaluate(() => {
      const p = document.querySelector(".pane.active");
      return p ? (p.id || "").replace(/^pane-/, "") : null;
    });

    // 新建同名文件绝不能把旧文件截成 0 字节（"w" 的 FXF_TRUNC 坑）
    await api("POST", "create", { path: "/home/ubuntu" , name: "ot-noclobber.txt" });
    await api("POST", "write", { path: "/home/ubuntu/ot-noclobber.txt" }, "KEEP");
    const clash = await api("POST", "create", {
      path: "/home/ubuntu", name: "ot-noclobber.txt" });
    const after = await (await api("GET", "read", {
      path: "/home/ubuntu/ot-noclobber.txt" })).json();
    record("新建同名文件不破坏已有内容",
      clash.status === 409 && after.content === "KEEP",
      `create=${clash.status} content=${JSON.stringify(after.content)}`);

    // 上传文件名必须剥掉目录成分（真机取证：../../tmp/PWNED.txt 曾逃出目录）
    const escName = "../../tmp/ot-pwned.txt";
    const up = await fetch(
      `${base}/api/tabs/${tabId}/files/upload?path=/home/ubuntu&name=` +
      encodeURIComponent(escName), {
        method: "POST",
        headers: { "x-ot-token": await page.evaluate(() =>
          sessionStorage.getItem("ot-token") || "") },
        body: "PWN",
      });
    const upJ = await up.json().catch(() => ({}));
    const escaped = await api("GET", "list", { path: "/tmp" });
    const escapedJ = await escaped.json().catch(() => ({entries: []}));
    const leaked = (escapedJ.entries || []).some(e => e.name === "ot-pwned.txt");
    record("上传文件名不能路径穿越",
      up.ok && !leaked && (upJ.path || "").indexOf("..") === -1,
      `path=${upJ.path} leaked=${leaked}`);

    // 竞态：慢的旧响应绝不能覆盖新列表（前端按请求序号收口）。
    // 进 .cache（故意拖慢）后立刻回家目录，最终必须显示家目录而不是 .cache
    await page.route("**/api/tabs/*/files/list*", async (route) => {
      if (route.request().url().includes(".cache")) {
        await new Promise(r => setTimeout(r, 1200));
      }
      await route.continue();
    });
    const raceBefore = await page.evaluate(() =>
      (document.querySelector(".files-panel .fp-path") || {}).textContent);
    const dirIdx = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".files-panel .fp-row.dir .fp-name"))
        .findIndex(n => n.textContent === ".cache"));
    if (dirIdx >= 0) {
      await page.locator(".files-panel .fp-row.dir").nth(dirIdx).dblclick();
      await page.waitForTimeout(120);
      await page.locator('.files-panel [data-act="home"]').click();
      await page.waitForTimeout(2000);
    }
    const raceAfter = await page.evaluate(() =>
      (document.querySelector(".files-panel .fp-path") || {}).textContent);
    record("竞态：慢的旧响应不覆盖新列表",
      dirIdx < 0 || /home/.test(raceAfter),
      `before=${raceBefore} after=${raceAfter}`);
    await page.unroute("**/api/tabs/*/files/list*");

    record("全程无 JS 报错", errors.length === 0, errors.join(" | "));
    await page.screenshot({
      path: path.join(REPO, ".tmp", "live", "fp-direct.png"),
    });
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(`\n${fails ? "FAIL" : "PASS"}  ${fails} 项失败`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("诊断脚本异常:", e);
  process.exit(1);
});
