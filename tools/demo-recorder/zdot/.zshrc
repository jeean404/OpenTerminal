# demo 录制专用 zsh 环境（serve_demo.py 经 ZDOTDIR 指向本目录）：
# 中性提示符——公开动图不露真用户名/主机名；空 rc 也让 local tab 秒连。
# hook 的 PS1 用 %n@%m 展开，而 zsh 的 %n/%m 读的就是 USERNAME/HOST 参数。
USERNAME=demo
HOST=openterminal
PROMPT='demo@openterminal %1~ %# '
RPROMPT=''
export CLICOLOR_FORCE=1
HISTFILE=/dev/null
