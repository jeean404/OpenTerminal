# demo-recorder —— README 头图录制管线

头图 `docs/images/demo-web.gif` 不是手绘 mock：它是 `ot web` 真界面的
**确定性录屏**（脚本化 TaskRunner，无需模型网关），任何时候可重录：

```sh
# 1. 起 demo 服务（种 /tmp/ot-demo 中性数据；ZDOTDIR=zdot 中性化提示符主机名）
OPENTERMINAL_HOME=/tmp/ot-demo-home \
    python tools/demo-recorder/serve_demo.py --port 8099

# 2. playwright 真浏览器操作 + 录屏（输出 webm 路径与 TRIM 秒数）
NODE_PATH=$(npm root -g) node tools/demo-recorder/record.cjs /tmp/vid 8099

# 3. webm → gif（TRIM 裁掉片头连接死等；两趟 palette 保 CJK/配色）
tools/demo-recorder/make_gif.sh /tmp/vid/<page>.webm docs/images/demo-web.gif <TRIM>
```

依赖：playwright（npm 全局，含 chromium）+ ffmpeg。

剧情改两处、保持对齐：`serve_demo.py` 的 `DemoRunner`（思考/分析/审批/
总结的事件与文案，审批放行后经 `core.backend.aexecute` 真执行，总结表
由真输出汇总）与 `record.cjs` 的按键 beat 与停顿。
