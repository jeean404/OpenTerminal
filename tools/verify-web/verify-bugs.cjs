// 真机浏览器验证套件（真 Chromium + 真 ssh 主机 + 真模型）。
// 阶段 A：bug1 命令集抢跑（目标「腾讯云主机」：ssh / sudo su - / cd /root）
// 阶段 B：bug2 同一问题两轮 + 终端可输入 + 断线自动重连（目标 local）
// 逐条 PASS/FAIL，截图与时间线落 .tmp/live。
// 用法：node tools/verify-web/verify-bugs.cjs [port] [targetA] [question]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8123);
const TARGET_A = process.argv[3] || "腾讯云主机";
const TARGET_B = process.argv[4] || "local";
const QUESTION = process.argv[5] || "查看当前docker容器";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}

// ---- 页面状态 ----
const probe = page => page.evaluate(() => {
  const g = id => {
    const el = document.querySelector(`[id^="${id}-"]`);
    return el ? (el.innerText || "").trim() : "";
  };
  // hidden 元素的 innerText 会回落成 textContent，读文字判不出「是否显示」——
  // 一律以 .hidden 为准，文字只作展示
  const vis = id => {
    const el = document.querySelector(`[id^="${id}-"]`);
    return el ? (el.hidden ? "hidden" : "shown") : "missing";
  };
  const think = document.querySelector('[id^="think-"]');
  const tt = think && think.querySelector ? think.querySelector(".ttext") : null;
  const modal = document.querySelector("#modal-root .modal");
  return {
    conn: g("conn"), connVis: vis("conn"),      // connecting 徽标是否露出
    overlayVis: vis("connov"),                   // 连接中浮层是否盖着终端
    status: g("status"), cs: g("cs"), tokens: g("tokens"),
    think: think ? (think.hidden ? "hidden" : "shown") : "missing",
    thinkText: tt ? (tt.textContent || "").trim() : "",
    modal: modal ? (modal.innerText || "").trim().slice(0, 160) : "",
  };
});

// 清掉挡路的模态。弹窗会一弹再弹（拒绝审批 → 模型换个命令又要审批），
// 点一次根本不够，`.term` 点击会被 #modal-root 挡住 30s 超时。清到连续
// 250ms 无模态为止。审批模态点「批准」让它继续跑；密码/令牌模态点取消
// （不该由 harness 代填）。返回清掉的次数。
async function dismissModal(page, budgetMs = 4000) {
  const t0 = Date.now();
  let cleared = 0, quiet = 0;
  while (Date.now() - t0 < budgetMs && quiet < 2) {
    const hit = await page.evaluate(() => {
      const root = document.querySelector("#modal-root");
      const modal = root && root.querySelector(".modal");
      if (!modal) return false;
      const h3 = modal.querySelector("h3");
      const title = ((h3 && h3.innerText) || "").trim();
      const isApproval = title.indexOf("\u5ba1\u6279") === 0;
      const want = isApproval
        ? /\u6279\u51c6|\u540c\u610f/
        : /\u53d6\u6d88|\u62d2\u7edd|\u5173\u95ed/;
      const btn = Array.from(root.querySelectorAll("button"))
        .find(b => want.test(b.innerText || ""));
      if (btn) btn.click(); else root.innerHTML = "";
      return true;
    });
    if (hit) { cleared++; quiet = 0; await sleep(200); }
    else { quiet++; await sleep(250); }
  }
  return cleared;
}

// 点终端：先清模态再点，被挡就重来一轮（真机上审批模态会连着弹）。
async function clickTerm(page, tries = 5) {
  for (let i = 0; i < tries; i++) {
    await dismissModal(page);
    try {
      await page.locator(".term").click({ timeout: 3000 });
      return true;
    } catch (e) {}
  }
  return false;
}

async function modalState(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    if (!modal) return { open: false, text: "", value: "" };
    const v = document.getElementById("modal-value");
    return {
      open: true,
      text: (modal.innerText || "").trim().slice(0, 160),
      value: v ? v.value : "",
    };
  });
}

// 终端能否收进输入：普通 shell 看回显；password: 之类提示不回显，改成
// 提交一次看 PTY 有没有反应（拒绝/重提示）。两者都没有＝输入被 hold（bug2）。
// 连接就绪闸：连接徽标/浮层都藏起来才算连上。上一轮在「连接中」时提问，
// 键进了 keyBacklog，等 WS 开连才回放——问题实际送达时 180s 窗口已烧完
// （B1 假失败）。
async function waitReady(page, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = await probe(page);
    if (p.connVis === "hidden" && p.overlayVis === "hidden" && p.status) {
      return { ok: true, waited: Date.now() - t0, status: p.status.slice(0, 80) };
    }
    await sleep(400);
  }
  return { ok: false, waited: Date.now() - t0, status: (await probe(page)).status.slice(0, 80) };
}

// ---- 审批应答：扮演用户做决定 ----
// core 的 ask_decision 阻塞等决策，harness 不点批准任务就合法挂起，
// 页面看着正是用户 bug2 的「AI 正在思考」卡死。
async function approvalState(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    // 只认标题以「审批」开头的模态：密码/令牌弹窗不是审批，
    // 认错了 tryApprove 会替用户去点「批准」
    const h3 = modal && modal.querySelector("h3");
    const isApprovalModal = !!modal &&
      (((h3 && h3.innerText) || "").trim().indexOf("\u5ba1\u6279") === 0);
    // 模态标题就是「审批：<命令>」（3 个字前缀）。命令串从标题取：
    // 决策一落 _approvalCmd 就被清空，幽灵模态的 cmd 会记成空串。
    const modalCmd = isApprovalModal
      ? (((h3 && h3.innerText) || "").trim().slice(3)) : "";
    const s = (typeof sessions !== "undefined" && typeof activeTabId !== "undefined") ? (sessions[activeTabId] || null) : null;
    const cards = [];
    try {
      if (s && s._slots) {
        for (const [, slot] of s._slots) {
          if (slot && slot.kind === "approval") {
            cards.push({
              mounted: !!slot.mounted,
              // mounted 且未夹紧（pinnedRows == null）才等于用户真点得到
              clickable: !!slot.mounted && slot.pinnedRows == null,
              hasHost: !!slot.host,
            });
          }
        }
      }
    } catch (e) {}
    return {
      open: !!(s && s._approvalOpen) || isApprovalModal,
      flag: !!(s && s._approvalOpen),
      cmd: (s && s._approvalCmd) || modalCmd,
      modalCmd,
      viaModal: isApprovalModal,
      cards,
    };
  });
}

async function tryApprove(page) {
  const st = await approvalState(page);
  if (!st.open) return null;
  if (st.viaModal) {
    const clicked = await page.evaluate(() => {
      const modal = document.querySelector("#modal-root .modal");
      if (!modal) return false;
      const btn = Array.from(modal.querySelectorAll("button"))
        .find(b => /\u6279\u51c6|\u540c\u610f/.test(b.innerText || ""));
      if (!btn) return false;
      btn.click();
      return true;
    });
    return { ...st, how: clicked ? "模态点「批准」" : "模态无批准按钮" };
  }
  // 岛卡走快捷键（attachCustomKeyEventHandler 路由），焦点必须在终端
  await clickTerm(page, 2);
  await page.keyboard.press("Control+Enter").catch(() => {});
  return { ...st, how: "终端 Ctrl+Enter 批准" };
}

async function canType(page, probeStr) {
  await dismissModal(page);
  await sleep(300);
  const before = await lib.snapshot(page);
  if (!(await clickTerm(page))) {
    return { ok: false, why: "\u70b9\u4e0d\u5230\u7ec8\u7aef\uff08\u6a21\u6001\u6321\u8def\uff09", tail: "" };
  }
  await page.keyboard.type(probeStr, { delay: 15 });
  await sleep(900);
  const mid = await lib.snapshot(page);
  if (mid.includes(probeStr)) {
    await page.keyboard.press("Control+U").catch(() => {});
    await sleep(200);
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(200);
    return { ok: true, why: "回显", tail: mid.slice(-220) };
  }
  await page.keyboard.press("Enter");
  await sleep(1800);
  const after = await lib.snapshot(page);
  const ok = after !== before;
  return { ok, why: ok ? "不回显但 PTY 有反应" : "无回显且屏幕无任何变化",
           tail: (ok ? after : mid).slice(-220) };
}

async function ask(page, text) {
  if (!(await clickTerm(page))) {
    throw new Error("ask: \u70b9\u4e0d\u5230\u7ec8\u7aef\uff08\u6a21\u6001\u6321\u8def\uff09");
  }
  await sleep(200);
  await page.keyboard.type(text, { delay: 25 });
  await page.keyboard.press("Enter");
}

function startSampler(page) {
  const timeline = [];
  let prev = null, stop = false;
  const t0 = Date.now();
  (async () => {
    while (!stop) {
      const [txt, p] = await Promise.all([lib.snapshot(page), probe(page)]);
      const sig = txt + " " + p.cs + " " + p.modal;
      if (sig !== prev) {
        timeline.push({ t: Date.now() - t0, text: txt, cs: p.cs, modal: p.modal });
        prev = sig;
      }
      await sleep(120);
    }
  })();
  return {
    timeline,
    stop() { stop = true; return timeline; },
    firstAt(re) {
      for (const ev of timeline) {
        const m = ev.text.match(re);
        if (m) return { t: ev.t, line: m[0].trim() };
      }
      return null;
    },
  };
}

async function waitTaskEnd(page, { startTimeout = 30000, endTimeout = 180000,
                                    label = "", autoApprove = true } = {}) {
  let started = false, t0 = Date.now();
  while (Date.now() - t0 < startTimeout) {
    if ((await probe(page)).think === "shown") { started = true; break; }
    await sleep(300);
  }
  const samples = [], approvals = [], badgeViolations = [];
  let pendingSeen = null;
  let done = false, hiddenStreak = 0;
  // 进度签名：屏幕尾部 + 徽标文案 + 令牌计数 + 命令集状态。四样全静止
  // 而徽标还写「AI 正在思考」＝用户看到的假死（bug2）。status 里有走秒
  // 计时器，不能进签名。
  let tick = 0, lastSig = "", lastProgressAt = Date.now(), maxStall = 0;
  const stalls = [];
  const approvedBy = new Map();   // 命令 → 批准次数（幽灵双决策看这里）
  t0 = Date.now();
  while (Date.now() - t0 < endTimeout) {
    const p = await probe(page);
    samples.push({ t: Date.now() - t0, think: p.think, thinkText: p.thinkText,
                   connVis: p.connVis, overlayVis: p.overlayVis,
                   status: p.status.slice(0, 40), cs: p.cs.slice(0, 40) });
    const st = await approvalState(page);
    tick++;
    let sig = st.cmd + "|" + p.thinkText + "|" + p.tokens + "|" + p.cs;
    if (tick % 4 === 0) {
      sig += "|" + (await lib.snapshot(page)).slice(-300);
    }
    if (sig !== lastSig) {
      lastSig = sig;
      lastProgressAt = Date.now();
    } else {
      const gap = Date.now() - lastProgressAt;
      if (gap > maxStall) maxStall = gap;
      if (gap > 120000 && p.think === "shown" &&
          !stalls.some(x => Date.now() - t0 - x.t < 60000)) {
        stalls.push({ t: Date.now() - t0, gap, thinkText: p.thinkText,
                      pending: st.open, cmd: st.cmd });
      }
    }
    if (st.open) {
      pendingSeen = { t: Date.now() - t0, cmd: st.cmd, cards: st.cards };
      samples[samples.length - 1].pending = st.cmd.slice(0, 80);
    }
    // 未决期徽标必须说实话：审批一冒头还写「AI 正在思考」就是 bug2 的
    // 假死观感。跟点没点批准解耦——不能等 tryApprove 成功才记。
    if (st.open && p.think === "shown" &&
        /AI \u6b63\u5728\u601d\u8003/.test(p.thinkText)) {
      badgeViolations.push({ t: Date.now() - t0, thinkText: p.thinkText,
                             cmd: st.cmd });
    }
    if (autoApprove) {
      const a = await tryApprove(page);
      if (a) {
        approvals.push({ t: Date.now() - t0, how: a.how, cmd: a.cmd,
                         think: p.think, thinkText: p.thinkText, cards: a.cards });
        // 同一条命令被批准两次＝幽灵双决策：第二发决策会落到 core 下一次
        // ask_decision 头上，等于替用户批准一条没看过的命令。
        const key = a.cmd || "(空命令)";
        approvedBy.set(key, (approvedBy.get(key) || 0) + 1);
      }
    }
    hiddenStreak = p.think === "hidden" ? hiddenStreak + 1 : 0;
    if (hiddenStreak >= 4 && Date.now() - t0 > 4000) { done = true; break; }
    await sleep(800);
  }
  const last = await probe(page);
  if (label) {
    fs.writeFileSync(path.join(lib.OUT, `wait-${label}.json`),
      JSON.stringify(samples, null, 1));
    fs.writeFileSync(path.join(lib.OUT, `wait-${label}-screen.txt`),
      await lib.snapshot(page));
    fs.writeFileSync(path.join(lib.OUT, `wait-${label}-approvals.json`),
      JSON.stringify({ approvals, badgeViolations }, null, 1));
  }
  return { started, done, elapsed: Date.now() - t0, think: last.think,
           connVis: last.connVis, overlayVis: last.overlayVis, samples,
           approvals, badgeViolations, thinkText: last.thinkText,
           pendingSeen, maxStall, stalls,
           doubleApprovals: [...approvedBy.entries()]
             .filter(([, n]) => n > 1).map(([cmd, n]) => ({cmd, n})) };
}

async function main() {
  const started = await lib.startServer(PORT);
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用)");
  const browser = await lib.launch();
  const opened = await lib.openTab(browser, started.base);
  const page = opened.page;
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push("console: " + m.text());
  });

  try {
    // ================= 阶段 A：bug1 命令集抢跑 =================
    console.log("\n########## 阶段 A：bug1 命令集抢跑（目标 " + TARGET_A + "）##########");
    await lib.pickTarget(page, TARGET_A);
    const readyA = await waitReady(page, 180000);
    console.log("    连接就绪:", readyA.ok, readyA.waited + "ms", JSON.stringify(readyA.status));
    const sampler = startSampler(page);
    // 等到命令集进入稳态（暂停等密码 或 已跑完）
    let t0 = Date.now(), settled = false;
    while (Date.now() - t0 < 60000) {
      const p = await probe(page);
      if (/命令集暂停|命令集完成|已跳过|未检测到/.test(p.cs) || p.modal) { settled = true; break; }
      await sleep(400);
    }
    await sleep(2500);   // 再留窗口看是否抢跑
    await page.screenshot({ path: path.join(lib.OUT, "a1-cmdset.png") });
    const screenA = await lib.snapshot(page);
    const stateA = await probe(page);
    fs.writeFileSync(path.join(lib.OUT, "a1-screen.txt"), screenA);
    fs.writeFileSync(path.join(lib.OUT, "a1-timeline.json"),
      JSON.stringify(sampler.timeline, null, 1));
    sampler.stop();

    const pwEv = sampler.firstAt(/password\s*[:：]/i);
    const sudoEv = sampler.firstAt(/^\s*sudo su -\s*$/m);
    const cdEv = sampler.firstAt(/^\s*cd \/root\s*$/m);
    console.log("    首现: password=", pwEv && pwEv.t + "ms",
                " sudo su -=", sudoEv && sudoEv.t + "ms",
                " cd /root=", cdEv && cdEv.t + "ms");
    console.log("    命令集状态:", JSON.stringify(stateA.cs), " 弹窗:", JSON.stringify(stateA.modal));

    if (!pwEv) {
      record("A1 ssh 阻塞在密码提示（不抢跑）", false,
             "未等到密码提示，无法判定。屏幕：" + JSON.stringify(screenA.slice(-400)));
    } else if ((sudoEv && sudoEv.t < pwEv.t) || (cdEv && cdEv.t < pwEv.t)) {
      record("A1 ssh 阻塞在密码提示（不抢跑）", false,
             "bug1 复现：sudo su -=" + (sudoEv && sudoEv.t) + "ms / cd /root=" +
             (cdEv && cdEv.t) + "ms 早于密码提示 " + pwEv.t + "ms");
    } else {
      record("A1 ssh 阻塞在密码提示（不抢跑）", true,
             "密码提示 " + pwEv.t + "ms 出现；sudo su - / cd /root 均未早于它");
    }

    if (!pwEv) {
      record("A2 命令集进入「暂停等输入」", false, "未到密码提示");
    } else if (/命令集暂停/.test(stateA.cs)) {
      record("A2 命令集进入「暂停等输入」", true, stateA.cs);
    } else if (sudoEv && cdEv) {
      record("A2 命令集进入「暂停等输入」", true,
             "密码自动填充完成，命令集直接跑完（" + stateA.cs + "）");
    } else {
      record("A2 命令集进入「暂停等输入」", false,
             "命令集状态=" + JSON.stringify(stateA.cs) + " 屏幕尾=" +
             JSON.stringify(screenA.slice(-300)));
    }

    // 抢跑文本的硬断言：屏幕上不得出现早于密码提示的命令行
    const beforePw = pwEv
      ? sampler.timeline.filter(e => e.t <= pwEv.t).map(e => e.text)
      : [];
    const leaked = beforePw.some(t => /^\s*sudo su -\s*$/m.test(t) || /^\s*cd \/root\s*$/m.test(t));
    record("A3 密码提示前屏幕无抢跑命令", !leaked,
           leaked ? "时间线里密码提示前已出现 sudo su -/cd /root" : "时间线干净");

    // A4：密码模态本身能收输入（用户手输密码的通道）
    const mBefore = await modalState(page);
    let mOk = false, mVal = "";
    if (mBefore.open) {
      await page.locator("#modal-value").click();
      await page.keyboard.type("ZAMODAL", { delay: 20 });
      await sleep(300);
      const mAfter = await modalState(page);
      mVal = mAfter.value;
      mOk = mVal.includes("ZAMODAL");
      await dismissModal(page);
      await sleep(600);
    }
    record("A4 密码模态可输入", mBefore.open && mOk,
           mBefore.open
             ? (mOk ? "模态输入框可写（value 含探针）" : "value=" + JSON.stringify(mVal))
             : "未出现密码模态（可能已自动填充）：" + JSON.stringify(mBefore));

    const typedA = await canType(page, "ZAPROBE");
    record("A5 关闭弹窗后终端可输入", typedA.ok,
           typedA.ok ? (typedA.why + "（用户可手输密码）") : (typedA.why + " tail=" + JSON.stringify(typedA.tail)));

    // ================= 阶段 B：bug2 两轮提问 + 断线重连 =================
    console.log("\n########## 阶段 B：bug2 任务收束与输入（目标 " + TARGET_B + "）##########");
    const { page: pageB, errors: errB } = await lib.openTab(browser, started.base);
    for (const e of errB) errors.push(e);
    pageB.on("pageerror", e => errors.push("pageerror(B): " + e.message));
    await lib.pickTarget(pageB, TARGET_B);
    const readyB = await waitReady(pageB, 180000);
    console.log("  local 连接就绪:", readyB.ok, readyB.waited + "ms", JSON.stringify(readyB.status));
    await sleep(1500);
    await pageB.screenshot({ path: path.join(lib.OUT, "b1-local.png") });
    console.log("  local 连接:", JSON.stringify((await probe(pageB)).conn),
                " status:", JSON.stringify((await probe(pageB)).status.slice(0, 60)));

    const rounds = [];
    for (let r = 1; r <= 2; r++) {
      console.log(`  --- 第 ${r} 轮提问「${QUESTION}」---`);
      await ask(pageB, QUESTION);
      const res = await waitTaskEnd(pageB, { label: "round" + r, endTimeout: 360000 });
      const typed = await canType(pageB, "ZB" + r + "PROBE");
      if (typed.ok) {
        await clickTerm(pageB);
        await pageB.keyboard.press("Enter");
        await sleep(300);
      }
      const st = await probe(pageB);
      rounds.push({ round: r, started: res.started, done: res.done, elapsed: res.elapsed,
                    think: res.think, connVis: res.connVis, overlayVis: res.overlayVis,
                    canType: typed.ok, canWhy: typed.why,
                    approvals: res.approvals, badgeViolations: res.badgeViolations,
                    maxStall: res.maxStall, stalls: res.stalls,
                    doubleApprovals: res.doubleApprovals,
                    conn: st.conn, connVis2: st.connVis, status: st.status,
                    tokens: st.tokens });
      console.log("    审批 " + res.approvals.length + " 次" +
                  (res.approvals.length ? "（" + res.approvals.map(x => x.how).join("/") + "）" : "") +
                  " 徽标违规 " + res.badgeViolations.length);
      console.log("    起跑=" + res.started + " 收束=" + res.done + " 用时=" + res.elapsed +
                  "ms 徽标=" + res.think + " 连接徽标=" + res.connVis +
                  " 浮层=" + res.overlayVis + " 可输入=" + typed.ok + "（" + typed.why + "）");
      console.log("    最长静默=" + res.maxStall + "ms 假死点=" + res.stalls.length +
                  " 双决策=" + JSON.stringify(res.doubleApprovals));
      await pageB.screenshot({ path: path.join(lib.OUT, `b2-round${r}.png`) });
    }
    fs.writeFileSync(path.join(lib.OUT, "b2-report.json"), JSON.stringify(rounds, null, 1));

    // bug2 的 UI 契约不是「模型必须很快答完」——目标机 Docker 引擎在报
    // 500 时模型去修 Docker 是合理行为，慢不等于假死。契约是四条 UI 自己
    // 拥有的不变量：徽标不说谎、审批有可点入口、无幽灵双决策、屏幕/令牌
    // 不长期全静止还写「AI 正在思考」。收束与否单独打点，供人工判读。
    const bContract = (r, tag) => {
      if (!r) return record(tag, false, "该轮未跑");
      // 可见入口：模态，或屏幕上真挂着审批卡（hasHost）。卡被夹紧仍可
      // Ctrl+Enter，所以「可点」不是 B 的门槛——C2 单独测。
      const noEntry = (r.approvals || []).filter(a =>
        a.how.indexOf("模态") !== 0 &&
        !(a.cards || []).some(c => c.hasHost || c.clickable));
      const checks = [
        [r.badgeViolations.length === 0, "徽标说谎"],
        [noEntry.length === 0, "审批无可见入口"],
        [(r.doubleApprovals || []).length === 0, "幽灵双决策"],
        [!!r.canType, "终端不可输入"],
        [r.done || r.maxStall < 120000,
         "静默假死 " + r.maxStall + "ms"],
      ];
      const parts = checks.filter(c => !c[0]).map(c => c[1]);
      return record(tag, parts.length === 0,
        "收束=" + r.done + " 用时=" + r.elapsed + "ms 最长静默=" + r.maxStall +
        "ms 假死点=" + (r.stalls || []).length + " 可输入=" + r.canType +
        " 审批=" + (r.approvals || []).length + " 徽标违规=" +
        r.badgeViolations.length + " 双决策=" + JSON.stringify(r.doubleApprovals) +
        (parts.length ? " 违反：" + parts.join("、") : ""));
    };
    bContract(rounds[0], "B1 第一轮提问：不假死（徽标/审批入口/输入/无静默）");
    bContract(rounds[1], "B2 第二轮提问：不假死（bug2 卡死点）");
    record("B1b 第一轮提问最终收束（徽标收回）",
           !!(rounds[0] && rounds[0].think === "hidden" && rounds[0].done),
           JSON.stringify({ done: rounds[0] && rounds[0].done,
                            think: rounds[0] && rounds[0].think,
                            elapsed: rounds[0] && rounds[0].elapsed }));
    record("B2b 第二轮提问最终收束（徽标收回）",
           !!(rounds[1] && rounds[1].think === "hidden" && rounds[1].done),
           JSON.stringify({ done: rounds[1] && rounds[1].done,
                            think: rounds[1] && rounds[1].think,
                            elapsed: rounds[1] && rounds[1].elapsed }));
    record("B3 每轮提问后终端仍可输入",
           rounds.every(x => x.canType),
           JSON.stringify(rounds.map(x => ({ r: x.round, canType: x.canType, conn: x.conn }))));

    // ---- B4：任务中断网，重连后必须恢复 ----
    console.log("  --- 断线重连 ---");
    const ctx = pageB.context();
    await ask(pageB, QUESTION);
    const up = await waitTaskEnd(pageB, { startTimeout: 25000, endTimeout: 0 });
    // waitTaskEnd(endTimeout=0) 只看起跑
    console.log("    任务起跑:", up.started);
    await ctx.setOffline(true);
    await sleep(4000);
    const connDuring = await probe(pageB);
    console.log("    断网时连接栏:", JSON.stringify(connDuring.conn),
                " 徽标:", connDuring.connVis, " 浮层:", connDuring.overlayVis);
    await ctx.setOffline(false);

    let recovered = false;
    t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const c = await probe(pageB);
      // 连接徽标只在 connecting 时露出：hidden ＝ 已连上
      if (c.connVis === "hidden" && c.overlayVis === "hidden") { recovered = true; break; }
      await sleep(500);
    }
    const after = await waitTaskEnd(pageB, { startTimeout: 3000, endTimeout: 150000, label: "after-blip" });
    const typedB4 = await canType(pageB, "ZB4PROBE");
    const finalP = await probe(pageB);
    await pageB.screenshot({ path: path.join(lib.OUT, "b3-after-blip.png") });
    record("B4 断线后自动重连（不再永久停在「连接已关闭」）", recovered,
           "断网时连接徽标=" + connDuring.connVis + " 浮层=" + connDuring.overlayVis +
           "  恢复后连接徽标=" + finalP.connVis + " 浮层=" + finalP.overlayVis +
           " status=" + JSON.stringify(finalP.status.slice(0, 60)));
    record("B5 断线恢复后 AI 徽标能收回（不假死）",
           after.think === "hidden" || after.maxStall < 120000,
           "think=" + after.think + " 收束=" + after.done +
           " 最长静默=" + after.maxStall + "ms 假死点=" + (after.stalls || []).length +
           " 连接徽标=" + finalP.connVis +
           " status=" + JSON.stringify(finalP.status.slice(0, 80)));
    record("B5b 断线恢复后徽标最终收回", after.think === "hidden",
           "think=" + after.think + " 收束=" + after.done +
           " 用时=" + after.elapsed + "ms");
    record("B6 断线恢复后终端可输入", typedB4.ok,
           typedB4.ok ? typedB4.why : (typedB4.why + " tail=" + JSON.stringify(typedB4.tail)));

    fs.writeFileSync(path.join(lib.OUT, "b3-final-screen.txt"), await lib.snapshot(pageB));

    // ================= 阶段 C：审批 UI 可见可点 =================
    // C0 是纯前端契约回归：_ensureFeed 永不落时，未决态也必须同步记账。
    // 旧实现把 _approvalOpen 写在 .then 里——这一测直接挂，正是用户截图
    // 「AI 正在思考」假死（审批 UI 一张不出、core 干等决策）。
    console.log("\n########## 阶段 C：审批 UI 可见可点 ##########");
    const c0 = await pageB.evaluate(async () => {
      const s = (typeof sessions !== "undefined" && typeof activeTabId !== "undefined") ? (sessions[activeTabId] || null) : null;
      if (!s) return { skip: "no session" };
      const origEnsure = s._ensureFeed.bind(s);
      const origOpen = s._approvalOpen, origCmd = s._approvalCmd;
      const r = {};
      try {
        s._ensureFeed = () => new Promise(() => {});   // 永不 resolve
        s._approvalOpen = false;
        s._approvalCmd = null;
        s.handleMsg({ type: "approval", command: "ZACMD-PROBE",
                      reasons: ["测试：未决态同步记账"],
                      host: "h", risk: 1 });
        await new Promise(res => setTimeout(res, 80));
        const el = document.querySelector('[id^="think-"]');
        const tt = el && el.querySelector ? el.querySelector(".ttext") : null;
        r.open = s._approvalOpen === true;
        r.cmd = s._approvalCmd;
        r.thinkText = tt ? (tt.textContent || "").trim() : "";
        r.thinkShown = el ? !el.hidden : false;
      } finally {
        s._ensureFeed = origEnsure;
        s._approvalOpen = origOpen;
        s._approvalCmd = origCmd;
        try { s._refreshThink(); } catch (e) {}
      }
      return r;
    });
    console.log("    C0:", JSON.stringify(c0));
    record("C0 未决态同步记账（卡片层不落也不假死）",
           !!c0 && c0.open === true && c0.cmd === "ZACMD-PROBE" &&
             /等待审批/.test(c0.thinkText || ""),
           JSON.stringify(c0));

    // C1-C4：真问题触发真审批，卡必须可见可点、批准后能收束
    await ask(pageB, "在当前目录创建一个名为 ot-approve-probe.txt 的空文件");
    // 两拍快照：saw=冒出那拍（C1 看徽标），sawCard=卡挂好真点得到那拍
    // （C2 看可点性）。showApproval 先同步置 _approvalOpen 再异步挂卡，
    // 只取第一拍的话 _slots 里还没有 approval 槽，C2 必假失败。
    let saw = null, sawCard = null, seenThink = false;
    // 先等任务起跑再谈收束：ask 刚回车时 task_start 还没到，徽标本就隐藏
    // （think.hidden = !taskActive）。一见 hidden 就 break 会把「尚未起跑」
    // 误判成「已收束」，审批还在后面就跳过了（C1/C2 假失败根因）。
    t0 = Date.now();
    while (Date.now() - t0 < 30000 && !seenThink) {
      if ((await probe(pageB)).think === "shown") seenThink = true;
      else if (await approvalState(pageB).then(x => x.open)) break;
      else await sleep(200);
    }
    t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      const st = await approvalState(pageB);
      if (st.open) {
        const p = await probe(pageB);
        if (!saw) {
          saw = { t: Date.now() - t0, ...st, think: p.think,
                  thinkText: p.thinkText, modal: p.modal.slice(0, 80) };
        }
        if (st.viaModal || (st.cards || []).some(c => c.clickable)) {
          sawCard = { t: Date.now() - t0, ...st, thinkText: p.thinkText };
          break;
        }
      } else if (seenThink && (await probe(pageB)).think === "hidden") {
        break;   // 真起跑过、现在徽标收回＝任务已收束，等不到审批
      }
      await sleep(400);
    }
    console.log("    审批冒头:", JSON.stringify(saw),
                " 可点:", JSON.stringify(sawCard));
    record("C1 审批冒出时徽标是「等待审批」",
           !!saw && /等待审批/.test(saw.thinkText || "") &&
             !/AI 正在思考/.test(saw.thinkText || ""),
           JSON.stringify(saw || { skipped: "未等到审批" }));
    const clickable = !!(sawCard && (sawCard.viaModal ||
      (sawCard.cards || []).some(c => c.clickable)));
    record("C2 审批有可点入口（模态或已挂载未夹紧的卡）", clickable,
           JSON.stringify(sawCard || saw || { skipped: "未等到审批" }));

    const c3 = await waitTaskEnd(pageB, { startTimeout: 3000, endTimeout: 180000,
                                         label: "approve" });
    const typedC = await canType(pageB, "ZCPROBE");
    record("C3 批准后任务能收束",
           !!saw && c3.think === "hidden",
           "审批=" + JSON.stringify(saw && saw.cmd) + " 收束=" + c3.done +
           " think=" + c3.think + " 用时=" + c3.elapsed + "ms " +
           "批准次数=" + c3.approvals.length +
           " 未决=" + JSON.stringify(c3.pendingSeen && c3.pendingSeen.cmd));
    record("C4 审批后终端仍可输入", typedC.ok,
           typedC.ok ? typedC.why : (typedC.why + " tail=" + JSON.stringify(typedC.tail)));
    await pageB.screenshot({ path: path.join(lib.OUT, "c1-approval.png") });

    // ---- C5：幽灵审批模态（真机 B1 的双决策）----
    // 卡被夹紧点不到、用户走 Ctrl+Enter 放行后，grace 看门狗仍可能把
    // _approvalModal 弹出来——再点一次就发第二发决策，落到 core 下一次
    // ask_decision 头上＝替用户批准一条没看过的命令。这里 spy 掉
    // _approvalModal 与 sendJson，端到端钉住「一令只放一发」。
    console.log("########## C5：幽灵审批模态（不双决策） ##########");
    await pageB.evaluate(() => {
      const s = (typeof sessions !== "undefined" && typeof activeTabId !== "undefined")
        ? (sessions[activeTabId] || null) : null;
      if (!s) return;
      s.__ghostCalls = [];
      s.__decisions = [];
      const origModal = s._approvalModal.bind(s);
      s._approvalModal = (cmd, reasons) => {
        s.__ghostCalls.push({ t: Date.now(), cmd: String(cmd || "") });
        return origModal(cmd, reasons);
      };
      const origSend = s.sendJson.bind(s);
      s.sendJson = m => {
        if (m && m.type === "decision") s.__decisions.push({ t: Date.now(), m });
        return origSend(m);
      };
    });
    await ask(pageB, "在当前目录创建一个名为 ot-ghost-probe.txt 的空文件");
    let ghostSaw = null, tDecision = 0;
    t0 = Date.now();
    while (Date.now() - t0 < 60000 && !ghostSaw) {
      const st = await approvalState(pageB);
      if (st.open && !st.viaModal) {
        ghostSaw = { t: Date.now() - t0, cmd: st.cmd, cards: st.cards };
        if (await clickTerm(pageB, 2)) {
          await pageB.keyboard.press("Control+Enter").catch(() => {});
        }
        tDecision = Date.now();
        break;
      }
      await sleep(200);
    }
    await sleep(4500);   // grace 3s + 余量：看门狗要弹就在这窗口里弹
    const ghostStat = await pageB.evaluate(() => {
      const s = (typeof sessions !== "undefined" && typeof activeTabId !== "undefined")
        ? (sessions[activeTabId] || null) : null;
      const m = document.querySelector("#modal-root .modal");
      const h3 = m && m.querySelector("h3");
      return {
        ghostCalls: (s && s.__ghostCalls) || [],
        decisions: (s && s.__decisions) || [],
        modalTitle: (((h3 && h3.innerText) || "").trim()),
      };
    });
    const lateCalls = ghostStat.ghostCalls.filter(x => x.t >= tDecision);
    const lateDecisions = ghostStat.decisions.filter(x => x.t >= tDecision);
    record("C5 已决策后不冒幽灵审批模态（一令只放一发决策）",
           !!ghostSaw && lateCalls.length === 0 && lateDecisions.length === 1,
           "决策点=" + JSON.stringify(ghostSaw) +
           " 决策后弹模态次数=" + lateCalls.length + " " + JSON.stringify(lateCalls) +
           " 决策帧=" + lateDecisions.length +
           " 末态模态=" + JSON.stringify(ghostStat.modalTitle));
    const typedC5 = await canType(pageB, "ZC5PROBE");
    record("C6 幽灵模态检查后终端仍可输入", typedC5.ok,
           typedC5.ok ? typedC5.why : (typedC5.why + " tail=" + JSON.stringify(typedC5.tail)));
    await pageB.screenshot({ path: path.join(lib.OUT, "c5-ghost.png") });

    // ================= 汇总 =================
    console.log("\n\n================ 汇总 ================");
    for (const r of results) console.log("[" + (r.ok ? "PASS" : "FAIL") + "] " + r.name);
    const fails = results.filter(r => !r.ok);
    console.log("\n" + (results.length - fails.length) + "/" + results.length + " 通过");
    console.log("===== JS 错误 =====");
    console.log(errors.length ? errors.join("\n") : "(none)");
    fs.writeFileSync(path.join(lib.OUT, "summary.json"),
      JSON.stringify({ results, errors, rounds }, null, 1));
    process.exitCode = fails.length ? 1 : 0;
  } finally {
    await browser.close();
    if (started.server) started.server.kill();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
