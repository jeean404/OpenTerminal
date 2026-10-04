#!/bin/sh
# webm → README 动图：两趟 palette，960 宽 10fps（CJK/配色由真浏览器渲染保证）。
# 用法：tools/demo-recorder/make_gif.sh <in.webm> <out.gif> [trim_start_sec]
set -e
in="$1"; out="$2"; trim="${3:-0}"
ffmpeg -y -loglevel error -ss "$trim" -i "$in" \
  -vf "fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  "$out"
ls -la "$out"
