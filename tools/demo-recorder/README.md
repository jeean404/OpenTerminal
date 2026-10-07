# demo-recorder —— README 头图录制管线

两张头图 `docs/images/demo-web.gif`（web）与 `docs/images/demo-terminal.gif`
（终端）都不是手绘 mock：分别录制 `ot web` 真界面与单管线 `ot` 真终端，
**确定性录屏**（脚本化 TaskRunner，无需模型网关），任何时候可重录。

## web 版（playwright 真浏览器操作 + 录屏）

```sh
# 1. 起 demo 服务（种 /tmp/ot-demo 中性数据；ZDOTDIR=zdot 中性化提示符主机名）
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

# 4. webm → gif（TRIM 裁掉片头探针/注入死等，本机实测 ~5.2s）
tools/demo-recorder/make_gif.sh /tmp/vid-term/<page>.webm \
    docs/images/demo-terminal.gif 5.2
```

依赖（两版相同）：playwright（npm 全局，含 chromium）+ ffmpeg；
终端版额外零依赖（录制是纯 stdlib pty，渲染用仓库内置 xterm.js）。

终端版脱敏三件套：`ZDOTDIR=zdot`（中性提示符/主机名）+ 子进程
`USER/LOGNAME/USERNAME=demo`（ready 行的 getpass.getuser() 与蓝色重绘的
$USER）+ 从 `/tmp/ot-demo` 起跑（hook 重绘的 %~ 不露真实家目录）。注意
hook PS1 的 `%n` 由 zsh 从 uid 解析、环境变量改不动——常驻提示符仍显示
真实登录名，属既有先例明确接受的范围（与 git author 同为公开信息）。

等待一律事件驱动：录制器等 ready 提示语「shell 集成已就绪」后才开拍——
hook 注入（探针 + 27 分片）期间打字会混进注入流，把集成都搅掉。

剧情改两处、保持对齐：`serve_demo.py` 的 `DemoRunner`（思考/分析/审批/
总结的事件与文案；`serve_terminal.py` 导入同一份，审批放行后经
`core.backend.aexecute` 真执行，总结表由真输出汇总）与 `record.cjs` /
`record_terminal.py` 的按键 beat 与停顿。
