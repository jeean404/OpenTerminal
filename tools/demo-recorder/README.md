# demo-recorder —— README 头图录制管线

两张头图 `docs/images/demo-web.gif`（web）与 `docs/images/demo-terminal.gif`
（终端）都不是手绘 mock：分别录制 `ot web` 真界面与单管线 `ot` 真终端，
**确定性录屏**（脚本化 TaskRunner，无需模型网关），任何时候可重录。

## 剧情（两版共用一份，动图永远对齐）

```
ls /tmp/ot-demo              ① 普通命令，真 shell 彩色输出
看看 /tmp/ot-demo 下哪些目录最占空间，清掉 build-cache，给我一张表
                             ② 自然语言任务
think ×2                     ③ 思考流
token 流式分析                ④ 分析卡流式成型
tool_start(du)               只读探查：策略 auto，命令卡不长审批按钮
                             ——「看一眼不花钱」这半句是真演出来的
tool_start(rm -rf …)         ⑤ 改动磁盘：策略 approve + 高危，命令卡长出
                             执行/修改/拒绝/始终允许，等审批
点「执行」→「确认执行」       ⑥ 高危二次确认后真执行（core.backend.aexecute，
                             与真 agent 的 execute 工具同一注入路径）
final 总结卡                  markdown 表格行来自真 du 输出，内外一致
```

剧情集中在 `serve_demo.py` 的 `make_demo_runner(backend_of)` 工厂：web 版
把 `backend_of` 指向 `REGISTRY[-1].backend`，终端版指向闭包里的 `core.backend`。
改剧情只改这一个文件，两张动图自然同步。

## web 版（playwright 真浏览器操作 + 录屏）

```sh
# 1. 起 demo 服务（种 /tmp/ot-demo 中性数据；中性身份见下）
OPENTERMINAL_HOME=/tmp/ot-demo-home \
    python tools/demo-recorder/serve_demo.py --port 8099

# 2. playwright 真浏览器操作 + 录屏（输出 webm 路径与 TRIM 秒数）
NODE_PATH=$(npm root -g) node tools/demo-recorder/record.cjs /tmp/vid 8099

# 3. webm → gif（TRIM 裁掉片头连接死等；两趟 palette 保 CJK/配色）
tools/demo-recorder/make_gif.sh /tmp/vid/<page>.webm docs/images/demo-web.gif <TRIM>
```

## 终端版（pty 驱动真 CLI + cast 回放录屏，无需 asciinema/tmux）

```sh
# 1+2. pty.fork 起 serve_terminal.py，脚本化按键，输出 asciinema v2 格式 cast
python tools/demo-recorder/record_terminal.py /tmp/ot-term.cast

# 3. cast 灌进 vendored xterm.js 回放，playwright 录屏出 webm
NODE_PATH=$(npm root -g) node tools/demo-recorder/render_terminal.cjs \
    /tmp/ot-term.cast /tmp/vid-term

# 4. webm → gif（第 4 参是时长，收在总结卡上不带 /exit 尾巴）
tools/demo-recorder/make_gif.sh /tmp/vid-term/<page>.webm \
    docs/images/demo-terminal.gif <TRIM> <DURATION>
```

依赖（两版相同）：playwright（npm，含 chromium）+ ffmpeg；
终端版额外零依赖（录制是纯 stdlib pty，渲染用仓库内置 xterm.js）。

## 中性身份：公开动图不露本机

提示符是 `[\u@\H \w]`（bash）/ `[%n@%M %~]`（zsh）。`\u`/`%n` 由 uid 反查
passwd、`\H`/`%M` 取主机名——**环境变量改不动**（bash 会用 gethostname
覆盖 `HOSTNAME`；zsh 启动时同样重写 `USERNAME`）。旧动图因此漏过
`wujian@… ~/vscodeDemo/…`。

正解是把整个录制丢进 user+UTS+mount 三个 namespace，用**假 passwd + 假
主机名**（uid 0 在 `/etc/passwd` 里叫 `demo`）：

```sh
unshare -r -u -m bash -c '
  mount --bind /tmp/ot-ns-passwd /etc/passwd
  hostname openterminal
  export USER=demo LOGNAME=demo USERNAME=demo
  cd /tmp/ot-demo
  exec "$@"' bash <录制命令>
```

配合从 `/tmp/ot-demo` 起跑（`\w` 显示演示目录而非真实家目录），提示符恒为
`demo@openterminal /tmp/ot-demo`。`ZDOTDIR=zdot` 那套只对 zsh 初始提示符
有效，hook 接管后就不作数了，保留只为 zsh 路径兜底。

## 两条踩过的坑（改剧情前先读）

**① patch 点是 `openterminal.agent.runner.TaskRunner`。** ai_flow 的调用点
是函数体内的 `from ..agent.runner import TaskRunner`，每次任务重解析模块
属性。打在 `openterminal.agent.TaskRunner` 只改了包的惰性转发槽，调用点
根本不看它——剧情会整个滑回真模型（真机现象：模型重试 3 次
`AnthropicConnectionError`，屏幕上出一张失败总结卡）。

**② `tool_start` 必须发。** paced 显示下 token 攒在段缓冲里，`_live` 只在
`tool_start` 调 `_flush_seg` 把段落格成分析卡。只发 `think`/`token` 就要
审批，分析卡永远不出；审批按钮也靠 `claim_seq` 认领这张命令卡，认领不到
就回落成模态弹框。另外 `du` 这种只读命令策略判 auto、不长审批按钮，硬要
审批只能拿到模态——剧情里的「只读直跑 + 删除审批」是照策略真演的。

## 其他约定

- **等待一律事件驱动**（`wait_for` 输出子串 / playwright selector），
  不死等固定秒数。
- **脱敏另有两处**：子进程 `USER/LOGNAME/USERNAME=demo`（ready 行的
  `getpass.getuser()`），以及录制端从 `/tmp/ot-demo` 起跑。
- **模型永不被调用**：`DemoRunner` 整个替掉 `TaskRunner`。演示 home 里放
  一份占位 `.env`（`ANTHROPIC_BASE_URL` + 假 key）只为消掉 UI 上那张
  「未配置模型协议」红警告卡——它会原样进动图。
- **`make_gif.sh` 的 trim 放在 `-i` 之后**（输出侧精确 seek）。放在 `-i`
  前是关键帧粗跳，playwright 的 webm 关键帧稀疏时 `-ss 6.6` 实际从 0 开始，
  片头死等一点裁不掉。渲染回放在真正开始回放前还有 600ms 静置，算 TRIM
  时记得加进去。
- **`render_terminal.cjs` 先量字格再定画布**：viewport 与 `recordVideo` 的
  size 同源同值。旧版写死 1080×620，字宽一偏就把终端右侧裁掉（旧头图
  「markdown 表给你」被切就是这么来的）。
