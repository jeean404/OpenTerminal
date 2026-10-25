#!/bin/sh
# webm → README 动图：两趟 palette，900 宽 10fps（CJK/配色由真浏览器渲染保证）。
# 用法：tools/demo-recorder/make_gif.sh <in.webm> <out.gif> [trim_start_sec] [duration_sec]
#
# trim 必须放在 -i **之后**（输出侧精确 seek）。放在 -i 前是关键帧粗跳：
# playwright 录出的 webm 关键帧稀疏时，-ss 6.6 实际从 0 开始，片头死等
# 一点没裁掉（真机：动图前 6 秒只有一句「正在初始化 Agent…」）。
set -e
in="$1"; out="$2"; trim="${3:-0}"; dur="${4:-}"
[ "$trim" = "0" ] && trim_args="" || trim_args="-ss $trim"
[ -n "$dur" ] && dur_args="-t $dur" || dur_args=""
ffmpeg -y -loglevel error -i "$in" $trim_args $dur_args \
  -vf "fps=10,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  "$out"
ls -la "$out"
