"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BlockStream, canCut, isShellSwitch, isCmdEcho, pickCmdEcho, ensureCmdEcho, styleCmdEcho,
} = require("../../src/openterminal/web/frontend/static/block_stream.js");

function mk(prefix) { return new BlockStream(); }

test("append：id 全会话唯一，卡片块出生即定型", () => {
  const s = mk();
  const a = s.append({ id: "card-1", kind: "card" });
  const b = s.append({ id: "cmd-1", kind: "term" });
  assert.equal(s.length, 2);
  assert.equal(a.state, "frozen", "卡片块出生即定型（born-complete）");
  assert.equal(b.state, "live", "文本块默认还在收输出");
  assert.deepEqual(s.list().map(x => x.id), ["card-1", "cmd-1"]);
});

test("append 幂等：同 id 重复补块不落两次（断线重连不重复）", () => {
  const s = mk();
  s.append({ id: "card-1", kind: "card" });
  assert.equal(s.append({ id: "card-1", kind: "card" }), null);
  assert.equal(s.length, 1);
});

test("insertAfter：并行工具的输出各回各家，后面的卡自然下移", () => {
  // 一批 3 个 tool_call 一次宣告（runner 按模型顺序发 tool_start），
  // 串行执行。输出按 after:card-N 归位——这是「多卡片不乱」的机制本体。
  const s = mk();
  s.append({ id: "card-1", kind: "card" });
  s.append({ id: "card-2", kind: "card" });
  s.append({ id: "card-3", kind: "card" });
  assert.deepEqual(s.list().map(x => x.id), ["card-1", "card-2", "card-3"]);

  // out-1 插到 card-1 后，card-2/card-3 整体下移
  s.insertAfter("card-1", { id: "out-1", kind: "term" });
  assert.deepEqual(s.list().map(x => x.id),
    ["card-1", "out-1", "card-2", "card-3"]);

  // out-2 插到 card-2 后：即使 out-1 还在流式增长，也不影响别的块位置
  s.insertAfter("card-2", { id: "out-2", kind: "term" });
  assert.deepEqual(s.list().map(x => x.id),
    ["card-1", "out-1", "card-2", "out-2", "card-3"]);

  s.insertAfter("card-3", { id: "out-3", kind: "term" });
  assert.deepEqual(s.list().map(x => x.id),
    ["card-1", "out-1", "card-2", "out-2", "card-3", "out-3"]);
});

test("insertAfter 不认识的锚点：落到末尾，绝不插进一段中间（降级决策）", () => {
  const s = mk();
  s.append({ id: "cmd-1", kind: "term" });
  s.append({ id: "cmd-2", kind: "term" });
  // 归属认不出（hook 挂 / 块已被移除）→ 位置稍粗，但不能乱插
  s.insertAfter("gone-id", { id: "out-1", kind: "term" });
  assert.deepEqual(s.list().map(x => x.id), ["cmd-1", "cmd-2", "out-1"]);
});

test("update：原地换徽标/换装，不产生增删（零布局位移）", () => {
  const s = mk();
  s.append({ id: "card-1", kind: "card" });
  const evs = [];
  s.subscribe(e => evs.push(e.type));
  s.update("card-1", { payload: { state: "✓ 完成" } });
  s.update("card-1", { kind: "card", payload: { type: "summary" } });
  assert.deepEqual(evs, ["update", "update"], "只 update，不该有 add/remove");
  assert.equal(s.length, 1);
  assert.equal(s.get("card-1").payload.type, "summary");
});

test("update 不许改身份", () => {
  const s = mk();
  s.append({ id: "card-1", kind: "card" });
  s.update("card-1", { id: "hacked" });
  assert.equal(s.get("card-1").id, "card-1");
  assert.equal(s.get("hacked"), null);
});

test("remove / removeMany / clear：整块消失，不留半截", () => {
  const s = mk();
  s.append({ id: "a", kind: "card" });
  s.append({ id: "b", kind: "card" });
  s.append({ id: "c", kind: "card" });
  assert.equal(s.remove("b"), true);
  assert.equal(s.remove("b"), false);
  assert.deepEqual(s.list().map(x => x.id), ["a", "c"]);
  assert.equal(s.removeMany(["a", "nope", "c"]), 2);
  assert.equal(s.length, 0);
  s.append({ id: "x", kind: "term" });
  s.clear();
  assert.equal(s.length, 0);
  assert.equal(s.get("x"), null);
});

test("铁律：等用户点按钮的卡永不移除（除非显式 force）", () => {
  // 用户决策：虚拟化/收束扫尾任一处手抖都不许让「按钮没了 = 审批死锁」。
  // 做成结构性闸门，不是口头约定。
  const s = mk();
  s.append({ id: "card-1", kind: "card", keepAlive: true });   // 正在等审批
  s.append({ id: "card-2", kind: "card" });

  assert.equal(s.remove("card-1"), false, "未决审批卡不许被收束/虚拟化删掉");
  assert.equal(s.length, 2);
  assert.equal(s.removeMany(["card-1", "card-2"]), 1, "只删掉没有 keepAlive 的那张");
  assert.equal(s.get("card-1") != null, true);

  // 决策下 → 摘掉 keepAlive，才允许正常收束
  s.update("card-1", { keepAlive: false });
  assert.equal(s.remove("card-1"), true);

  // 任务中断 / /clear 是显式终态：force 越过闸门
  const t = mk();
  t.append({ id: "k", kind: "card", keepAlive: true });
  assert.equal(t.remove("k", { force: true }), true);
});

test("after / lastOfKind / filter：收束扫尾按身份圈定", () => {
  const s = mk();
  s.append({ id: "cmd-1", kind: "term" });
  s.append({ id: "card-1", kind: "card", gen: 1 });
  s.append({ id: "card-2", kind: "card", gen: 1 });
  s.append({ id: "card-3", kind: "card", gen: 2 });

  assert.deepEqual(s.after("cmd-1").map(x => x.id),
    ["card-1", "card-2", "card-3"]);
  assert.equal(s.lastOfKind("card").id, "card-3");
  assert.deepEqual(s.filter(b => b.gen === 1).map(x => x.id),
    ["card-1", "card-2"]);
});

test("canCut：L0 标记 → L1 提示符 → L2 静默 → L3 不切", () => {
  assert.equal(canCut({ marker: true }).level, "L0");
  assert.equal(canCut({ promptSeen: true, quietMs: 400 }).level, "L1");
  assert.equal(canCut({ promptSeen: true, quietMs: 100 }).ok, false);
  assert.equal(canCut({ quietMs: 400, cursorAtLineStart: true }).level, "L2");
  assert.equal(canCut({ quietMs: 400, cursorAtLineStart: false }).ok, false);
  // L3 是默认安全态：切不动就不切
  assert.deepEqual(canCut({}), { ok: false, level: "L3", conf: 0 });
});

test("isShellSwitch：只认我方敲进去的换壳/跳板指令", () => {
  for (const ln of [
    "sudo su -", "sudo su", "su -", "su root", "su - testuser",
    "ssh testuser@10.0.0.12", "ssh -p 2222 ubuntu@127.0.0.1",
    "  sudo   su  -  ", "exec bash", "login", "screen -r",
  ]) {
    assert.equal(isShellSwitch(ln), true, "应判换壳: " + JSON.stringify(ln));
  }
  for (const ln of [
    "", "ls -la", "cd /tmp", "df -h", "sudo apt install nginx",
    "exit", "cat su.txt", "ps aux | grep ssh", "echo su -",
  ]) {
    assert.equal(isShellSwitch(ln), false, "不该判换壳: " + JSON.stringify(ln));
  }
});

// \-\ 回显行：工具卡下的输出块要带命令行 \-\-\-\-\-\-\-\-\-\-\-\-\
const N = "\n";
const ECHO = "[root@x /tmp]# ps aux --sort=-%mem";

test("isCmdEcho：只认「提示符尾符 + 这条命令」整行", () => {
  assert.equal(isCmdEcho(ECHO, "ps aux --sort=-%mem"), true);
  assert.equal(isCmdEcho("some note about ps aux --sort=-%mem",
                         "ps aux --sort=-%mem"), false, "输出里恰好以命令结尾不算");
  assert.equal(isCmdEcho("[root@x /tmp]# ls -la", "ps aux"), false, "命令对不上");
  assert.equal(isCmdEcho(ECHO, ""), false, "空命令不做认定");
});

test("pickCmdEcho：从缓冲里认最后一行非空的回显", () => {
  assert.equal(pickCmdEcho("out1" + N + ECHO, "ps aux --sort=-%mem"), ECHO);
  assert.equal(pickCmdEcho("out1" + N + ECHO + N + N, "ps aux --sort=-%mem"), ECHO,
               "尾部空行不算数");
  assert.equal(pickCmdEcho("out1" + N + "out2", "ps aux --sort=-%mem"), "",
               "末行不是回显就认不出，宁缺勿猜");
});

test("ensureCmdEcho：回显在开头就原样", () => {
  const t = ECHO + N + "USER  PID";
  assert.equal(ensureCmdEcho(t, ECHO), t);
});

test("ensureCmdEcho：回显被啃掉了就补回去", () => {
  assert.equal(ensureCmdEcho("USER  PID" + N + "root 1", ECHO),
               ECHO + N + "USER  PID" + N + "root 1");
});

test("ensureCmdEcho：回显在中间就把前面的提示符重绘噪声丢掉", () => {
  assert.equal(ensureCmdEcho("[root@x /tmp]$" + N + ECHO + N + "USER  PID", ECHO),
               ECHO + N + "USER  PID");
});

test("ensureCmdEcho：没有回显可补就原样返回", () => {
  const t = "USER  PID";
  assert.equal(ensureCmdEcho(t, ""), t);
  assert.equal(ensureCmdEcho(t, null), t);
});

test("colored command echoes are deduplicated without losing their styles", () => {
  const styled = styleCmdEcho(ECHO, "ps aux --sort=-%mem");
  assert.equal(styled, "[root@x /tmp]# \x1b[38;5;51mps aux --sort=-%mem\x1b[0m");
  assert.equal(isCmdEcho(styled, "ps aux --sort=-%mem"), true);
  assert.equal(pickCmdEcho(styled + "\n\x1b[0m", "ps aux --sort=-%mem"), styled);
  assert.equal(ensureCmdEcho(styled + "\nUSER PID", ECHO), styled + "\nUSER PID");
  assert.equal(ensureCmdEcho(ECHO + "\nUSER PID", styled), styled + "\nUSER PID");
  assert.equal(ensureCmdEcho("USER PID", styled), styled + "\nUSER PID");
});

test("command styling does not guess ordinary output or override existing colors", () => {
  assert.equal(styleCmdEcho("output ending in ls", "ls"), "output ending in ls");
  assert.equal(styleCmdEcho(ECHO, "other command"), ECHO);
  const custom = "[root@x /tmp]# \x1b[32mls\x1b[0m";
  assert.equal(styleCmdEcho(custom, "ls"), custom);
});

