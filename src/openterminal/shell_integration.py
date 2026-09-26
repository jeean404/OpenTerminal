"""Agent 模式交互式 shell 集成：注入脚本 + OSC 标记流解析器。

单管线真终端（设计文档 §5.5/§5.6）：前端唯一渲染管线是全屏 xterm 的 PTY
字节直写，shell 集成只负责两件事——用带内标记向 worker 记账（历史库/
退出码/AI 上下文），以及在提交时做输入回显美化（青色重绘 + 提示符配色）。
终端能力（Tab 补全、历史、全屏程序、嵌套 shell、clear）全部归原生。

两组带内标记：

1. OSC 133 语义标记（带实例号 i，区分父/嵌套 shell）：
   - ``ESC]133;A;<i>BEL``      提示符开始
   - ``ESC]133;B;<i>BEL``      提示符结束（用户输入开始）
   - ``ESC]133;C;<i>BEL``      命令开始执行（Enter hook 放行前发出）
   - ``ESC]133;D;<ec>;<i>;<cwd>BEL`` 执行结束（PROMPT_COMMAND / prompt() 发出）
2. 私有行报告 ``ESC]6337;<i>;<KIND>;<line>BEL``（KIND ∈ CMD/AI/EXEC）：
   Enter hook 对每个非空行发出。CMD=原样原生执行；AI=自然语言被拦截（清空
   缓冲、写入 shell 历史）；EXEC=worker 注入通道（``__ot_exec__ `` 前缀）。

Enter hook 分类顺序：``__ot_exec__ `` 前缀→注入执行（任何模式下都处理）；
``__ot_off=1``→纯透传（Shell 模式=普通终端）；空行→原生；``?`` 前缀→AI；
``!`` 前缀→剥掉后强制执行（CMD）；首词能被 command -v / Get-Command 解析→
CMD；否则→AI。

StreamRouter 把 PTY 字节流按标记切成两类数据：live（INPUT 阶段：提示符+输入
回显）与 exec（EXEC 阶段：命令输出），worker 除需吞除/记账的字节外原样转发
给前端主 xterm（唯一显示管线）；跨 chunk 的半截转义序列会被挂起等待后续
字节（在字节层统一解决）。
"""

from __future__ import annotations

import base64
import codecs
import re
import shlex

EXEC_PREFIX = "__ot_exec__ "
PROBE_TAG = "__OTPROBE__"
#: 行报告 KIND
KIND_CMD = "CMD"
KIND_AI = "AI"
KIND_EXEC = "EXEC"

_ANSI_RE = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"   # OSC … BEL / ST
    r"|\x1b\[[0-9;:?]*[ -/]*[@-~]"          # CSI
    r"|\x1b[@-Z\\-_]"                        # 其余双字节转义
)


def strip_ansi(text: str) -> str:
    """去掉 ANSI/OSC 转义序列，得到纯文本（提示符捕获、DOM 展示用）。"""
    return _ANSI_RE.sub("", text)


def _to_int(s: str, default):
    try:
        return int(s)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# 注入脚本（bash / zsh / PowerShell 5.1+）
# ---------------------------------------------------------------------------
# 交付方式：脚本 base64 成单行，posix 用 eval "$(echo …|base64 -d)"、
# PS 用 iex(FromBase64String(…))——避免引号/$/换行在 readline 层的任何转义问题。

_BASH_SCRIPT = r'''
__ot_i=@@INST@@
__ot_off=0
# 单管线（§5.6）：历史自然累积进唯一 xterm 的 scrollback，不再每命令清屏
__ot_clear=0
__ot_last_ec=0
export PAGER=cat GIT_PAGER=cat
# su - 等 login shell 会继承 readline 裸模式留下的 termios（-echo -icanon -isig：
# 按键不可见、Ctrl+C 失效，真机「su - 后黑屏」根因）——bash 不在 bind -x 回调
# 前后恢复 termios，而命令又在回调内 eval 自执行，su/ssh 等子 shell 原样继承裸
# 模式且自身行编辑救不回来。两段对策：注入时检出回显丢失先 stty sane 自愈当前
# tty 并快照正常态；回调内每次 eval 子命令前按快照恢复（子 shell 从正常 tty 起步）。
case " $(stty -a 2>/dev/null) " in *" -echo "*) stty sane 2>/dev/null ;; esac
__ot_tty_save=$(stty -g 2>/dev/null)
# 半行保存/恢复（真机「任务期打字只剩尾巴」根因）：agent 命令注入前的 \x15
# 原生 unix-line-discard 会把用户正在敲的半行杀进 kill ring 且不恢复——任务
# 跑着时打的字被后续注入的每个 \x15 无声吞掉，只剩最后一次注入之后敲的尾巴。
# 重绑 ^U/^Y 为自有原语：^U 把半行存 __ot_saved 再清行（不经 kill ring），
# ^Y 仅在 __ot_saved 非空时把存档接回行首、光标落在拼接点。空行零副作用
# （原生 \x15\x19 对在空行会把 kill ring 旧内容复活——bash PTY 实测得
# "helloecho MARK"）。注入方（InteractiveRunner/_shell_pad）保证每 \x15 配
# 一 \x19；hook 不在位（su - 重置）时 worker 不发 \x19，退回原生丢弃语义。
__ot_saved=
__ot_kill_line() {
  __ot_saved="$READLINE_LINE"
  READLINE_LINE=""; READLINE_POINT=0
}
__ot_yank_line() {
  if [ -n "$__ot_saved" ]; then
    READLINE_LINE="$__ot_saved$READLINE_LINE"
    READLINE_POINT=${#__ot_saved}
    __ot_saved=
  fi
}
bind -x '"\C-u": __ot_kill_line'
bind -x '"\C-y": __ot_yank_line'
__ot_prompt_cmd() {
  local ec=$?
  printf '\033]133;D;%s;%s;%s\007' "$ec" "$__ot_i" "$PWD"
  if [ "$__ot_off" != 1 ] && [ "$__ot_clear" = 1 ]; then printf '\033[H\033[2J'; fi
  if [ -n "$__ot_pc_orig" ]; then eval "$__ot_pc_orig"; fi
  return 0
}
if [ -z "$__ot_pc_mine" ]; then __ot_pc_orig="$PROMPT_COMMAND"; __ot_pc_mine=1; fi
PROMPT_COMMAND=__ot_prompt_cmd
if [ -z "$__ot_ps1_orig" ]; then __ot_ps1_orig="$PS1"; fi
# PS1 不另行配色（观感对齐 main 分支：提示符用终端默认前景白，输入文本青色）；
# 原生 PS1 存 __ot_ps1_orig 备用
PS1='\[\033]133;A;'"$__ot_i"'\007\][\u@\h \w]\$ \[\033]133;B;'"$__ot_i"'\007\]'
# 提交后重绘（§5.6）：bind -x 吞掉 Enter（accept-line 不再发生），但 readline
# 进回调前已把 \C-m 的换行画完——光标在回显行的下一行行首（真机 bash 5.1 对照
# 实验：回调内 \r\033[2K 只擦到空行，白回显行恒漏）。故先 CUU 上一行回到回显行、
# 清行、提示符（默认色）+命令重画、\n 收束本行（输出紧随其后）。
# 颜色 $2 可选：默认 51 青（工具命令/用户命令），AI 自然语言行传 33 蓝
# （Workbench 观感：用户输入蓝、命令青）。
# bash readline 不支持输入中变色，仅提交后变色。
__ot_repaint() {
  local p="${PWD/#$HOME/\~}" c='#'
  [ "$EUID" != 0 ] && c='$'
  # 回显行可能折行（长命令）：按 提示符+文本 显示宽算视觉行数 K，循环 CUU+EL
  # K 次把回显的每个折行段全擦掉——只擦一行会漏首折行段（真机「__ot_exec__
  # 长命令白漏半行」根因）。宽算法：字符数 + UTF-8 额外字节/2（CJK/emoji 双宽
  # 恰准）；向下取整宁漏勿过——多擦会毁上一行真实输出。
  local prompt="[${USER:-$(id -un)}@$HOSTNAME $p]$c "
  local s="$prompt$1" ch by w k i
  # $3=same：同行擦除。空行提交时 readline 不为 \C-m 画换行（无回显字符可收束），
  # 光标仍停在提示符行——上移擦会吃掉上一行（真机：连按 Enter 逐行吃掉连接
  # 横幅、提示符不前进＝"Enter 不换行"根因）。非空行 readline 已画换行，走上移。
  if [ "${3:-up}" = same ]; then
    printf '\r\033[2K'
  else
    ch=${#s}
    by=$(printf %s "$s" | wc -c | tr -d ' ')
    w=$(( ch + (by - ch) / 2 ))
    k=$(( (w + ${COLUMNS:-80} - 1) / ${COLUMNS:-80} ))
    (( k < 1 )) && k=1
    for ((i=0; i<k; i++)); do printf '\033[1A\033[2K'; done
  fi
  printf '%s\033[38;5;%sm%s\033[0m\n' "$prompt" "${2:-51}" "$1"
}
# bind -x 会吞掉 Enter（accept-line 不再发生），所以 CMD/EXEC/off 路径由 hook
# 自执行：报告 → C → eval → D → 清屏；hook 返回后 readline 必然重画提示符
# （A…B），完成一个视觉上的"命令周期"。历史引用（!! 等）在记入 history 前用
# history -p 展开，保持原生语义。fzf 的 bind -x TUI 是此模式可行性的先例。
__ot_run() {
  local ec
  printf '\033]133;C;%s\007' "$__ot_i"
  (exit ${__ot_last_ec:-0}) 2>/dev/null
  # 子命令（su/ssh/vim…）从正常 termios 起步：本回调处于 readline 裸模式，
  # bash 不代为恢复，不还原则子 shell 继承 -echo 裸态（按键不可见）
  [ -n "$__ot_tty_save" ] && stty "$__ot_tty_save" 2>/dev/null
  eval "$1"
  ec=$?
  __ot_last_ec=$ec
  # 还回 readline 裸模式（见 __ot_submit 快照注释）：全屏应用退出后亦以此为准
  [ -n "$__ot_rl_tty" ] && stty "$__ot_rl_tty" 2>/dev/null
  printf '\033]133;D;%s;%s;%s\007' "$ec" "$__ot_i" "$PWD"
  if [ "$__ot_off" != 1 ] && [ "$__ot_clear" = 1 ]; then printf '\033[H\033[2J'; fi
  return 0
}
# EXEC 注入体还原可读命令后青色重绘再执行：注入行经过 tty 回显，明文时是
# "__ot_exec__ <命令>"、非打印字符时是 base64 包装——直接留在屏上就是内部
# 语法残留。这里把包装解码回原命令，回显行重绘为 提示符+青色命令（§5.6），
# 再交 __ot_run 执行原注入体。
__ot_exec_run() {
  local d="$1"
  case "$1" in
    'eval "$(echo '*)
      d="${1#*echo }"; d="${d%% | base64*}"
      d="$(printf %s "$d" | base64 -d 2>/dev/null)" || d="$1" ;;
  esac
  [ -z "$d" ] && d="$1"
  __ot_repaint "$d"
  __ot_run "$1"
}
# 首词可解析性判定（回显 CMD/AI）：先剥反斜杠转义；$VAR 与 $VAR/剩余 形式先
# 替换变量值再查——type -t 按字面查 "$EDITOR"、"$JAVA_HOME/bin/java" 恒落空，
# 会把真命令误送 AI（真机复现）。变量未设值时展开为空 → 判 AI 交模型兜底。
__ot_resolve() {
  local w="$1" vn val
  case "$w" in "\\"*) w="${w#\\}" ;; esac
  case "$w" in
    '$'*)
      vn="${w#\$}"; vn="${vn%%[!A-Za-z0-9_]*}"; val=""
      [ -n "$vn" ] && val="${!vn-}"
      w="${val}${w#\$"$vn"}"
      [ -z "$w" ] && { echo AI; return; } ;;
  esac
  case "$(type -t "$w" 2>/dev/null)" in
    alias|builtin|file|function|keyword) echo CMD ;;
    *) echo AI ;;
  esac
}
# 高危英文自然语言：首词是「一跑就错/阻塞/静默成功」的裸 builtin（read/wait
# 阻塞 stdin、clear/exit 退出码 0 连救援卡都不弹），且行内含英文虚词 → 判自然
# 语言。真命令（read -r line、kill -9 123、set -o vi）不含虚词，不受影响。
__ot_nl_en() {
  case "$1" in
    read|wait|clear|exit|logout|help|test|time|export|source|kill|jobs|history|set|let|dirs|pushd|popd) ;;
    *) return 1 ;;
  esac
  set -f
  local w
  for w in $2; do
    case "$w" in
      the|a|an|and|or|but|for|to|from|with|into|about|after|before|then|than|me|my|your|our|their|this|that|these|those|please|is|are|was|were|be|will|would|should|could|again|up)
        set +f; return 0 ;;
    esac
  done
  set +f
  return 1
}
__ot_submit() {
  local line="$READLINE_LINE" kind t first exp rest r0 r1
  # readline 裸模式快照：__ot_run 在 eval 前按 __ot_tty_save 恢复正常态（子命令
  # 所需），eval 后必须按本快照还回 readline 裸模式——readline 自认终端仍预置、
  # 不会重新 prep，不还则下个提示符跑在 canonical 态：Tab 补全/↑ 历史/Ctrl+R
  # 全被字面回显失效（真机：首条命令后 ↑ 打出 ^[[A、Tab 无补全）
  __ot_rl_tty=$(stty -g 2>/dev/null)
  case "$line" in
    # __ot_pad N：清掉回显行后打印 N 个空行（卡片占位行由 shell 打印，
    # 远端无 ConPTY 但同理：占位行必须存在于 shell 的输出流里）
    '__ot_pad '*)
      t="${line:9}"
      case "$t" in ''|*[!0-9]*) t=1 ;; esac
      (( t > 50 )) && t=50
      READLINE_LINE=""; READLINE_POINT=0
      # 不擦行：bash 5.x 的 readline 进 bind -x 回调前已自行发 \r\x1b[K 把
      # 「提示符+__ot_pad N」回显行整个擦掉，光标停在回显行行首（真机
      # CentOS bash 5.1.8 字节级实测：Enter 后先到 \r[K 再进回调）。此处的
      # 光标几何随 bash 版本变——旧实测「已画换行、光标在回显行下一行」与
      # 5.x 相反，相对 CUU 在 5.x 上必然上移一行把上一行内容吃掉（真机：
      # AI 蓝色提交行、命令输出行被 pad 擦掉）。故只补 N 个换行：光标行的
      # 空行 + N 个换行恰得 N 行占位，回显行已由 readline 自清。
      printf '\n%.0s' $(seq 1 "$t")
      return 0 ;;
    '__ot_exec__ '*)
      t="${line:12}"
      printf '\033]6337;%s;%s;%s\007' "$__ot_i" EXEC "$t"
      READLINE_LINE=""; READLINE_POINT=0
      __ot_exec_run "$t"
      return 0 ;;
  esac
  t="${line#"${line%%[![:space:]]*}"}"
  # 空行也走重绘：只 printf '\r\n' 的话，bind -x 返回后 readline 的重绘会
  # 擦掉先前画好的提示符——连按 Enter 只剩最后一个提示符、上方一片空行
  if [ -z "$t" ]; then
    # 真空行 readline 不为 \C-m 画换行（光标停在提示符行）→ 同行擦；纯空白行
    # 有回显字符、readline 画了换行 → 上移擦（残留空格不可见，无害）
    if [ -z "$line" ]; then __ot_repaint "" 51 same; else __ot_repaint ""; fi
    return 0
  fi
  if [ "$__ot_off" = 1 ]; then
    exp=$(builtin history -p -- "$line" 2>/dev/null) || exp=$line
    [ -n "$exp" ] || exp=$line
    history -s -- "$line" 2>/dev/null
    READLINE_LINE=""; READLINE_POINT=0
    printf '\r\n'
    (exit ${__ot_last_ec:-0}) 2>/dev/null
    [ -n "$__ot_tty_save" ] && stty "$__ot_tty_save" 2>/dev/null
    eval "$exp"
    __ot_last_ec=$?
    [ -n "$__ot_rl_tty" ] && stty "$__ot_rl_tty" 2>/dev/null
    return 0
  fi
  case "$t" in
    '?'*) kind=AI ;;
    '!'*) t="${t:1}"; kind=CMD ;;
    '('*) kind=CMD ;;   # 子 shell 开头必是 shell 语法（首词被 ( 截空须直判）
    '$('*) kind=CMD ;;  # 命令替换开头（$(which py) x.py）：$ 不在操作符集里，落默认分支首词截成 $ 会误 AI
    '`'*) kind=CMD ;;   # 反引号替换开头同理
    '{'*) kind=CMD ;;   # 花括号组 { ls; }：首词 { 查不到会被误 AI
    '#'*) kind=CMD ;;   # 注释行交 shell 按注释 eval（无副作用），不为备注起 AI 任务
    *'|'*|*'&'*|*';'*|*'>'*|*'<'*|*'`'*)
       # 含操作符：首个操作符前的首词须可解析为命令（或赋值）才算命令，
       # 否则是自然语言（"把日志保存>log.txt"、"注意a|b的区别"不再整行执行）
       first="${t%%[[:space:]]*}"; first="${first%%[;|&()<>]*}"
       case "$first" in
         '') kind=CMD ;;   # 重定向开头（>log / >>a cmd）：剥掉 <> 后首词空，合法 shell 语法
         [A-Za-z_]*=*) kind=CMD ;;
         *)
           kind=$(__ot_resolve "$first")
           if [ "$kind" = CMD ] && __ot_nl_en "$first" "$t"; then kind=AI; fi ;;
       esac ;;
    *) first="${t%%[[:space:]]*}"; first="${first%%[;|&()<>]*}"
       # 赋值/环境前缀只在首词是合法标识符时才算命令（FOO=bar / arr[0]=x）：
       # 自然语言里带 "="（"把ll=ls设为别名"）首词非标识符，落回 type -t
       # 判成 AI——原 "*=*" 会把整行当命令执行报 "command not found"
       case "$first" in
         [A-Za-z_]*=*)
           # NAME=value 后还有词 = 环境前缀，仅当后续首词可解析为命令；
           # 否则是自然语言（裸 "ll=ls -al的别名设置为永久" 由此兜住）。
           # 连续多变量前缀（A=1 B=2 cmd）须逐个剥——旧版只看 rest 首词，
           # r1 取到第二个赋值查不到，真命令被误 AI（真机复现）
           rest="${t#"$first"}"
           rest="${rest#"${rest%%[![:space:]]*}"}"
           while :; do
             case "$rest" in
               [A-Za-z_]*=*)
                 r0="${rest%%[[:space:]]*}"
                 rest="${rest#"$r0"}"
                 rest="${rest#"${rest%%[![:space:]]*}"}" ;;
               *) break ;;
             esac
           done
           if [ -z "$rest" ]; then kind=CMD
           else
             r1="${rest%%[[:space:]]*}"; r1="${r1%%[;|&()<>]*}"
             kind=$(__ot_resolve "$r1")
           fi ;;
         *)
           # type -t 覆盖 keyword/builtin/alias/function/file——command -v 找不到
           # exit/if/for 等关键字，会把它们误判成自然语言吞掉
           kind=$(__ot_resolve "$first")
           if [ "$kind" = CMD ] && __ot_nl_en "$first" "$t"; then kind=AI; fi ;;
       esac ;;
  esac
  printf '\033]6337;%s;%s;%s\007' "$__ot_i" "$kind" "$t"
  if [ "$kind" = AI ]; then
    history -s -- "$line" 2>/dev/null
    READLINE_LINE=""; READLINE_POINT=0
    # 蓝色重绘（§5.6）：AI 行默认色回显清掉，提示符+原文按主题蓝重画
    # （Workbench 观感：用户自然语言蓝，工具/用户命令青）
    __ot_repaint "$t" 33
    return 0
  fi
  exp=$(builtin history -p -- "$t" 2>/dev/null) || exp=$t
  [ -n "$exp" ] || exp=$t
  history -s -- "$line" 2>/dev/null
  READLINE_LINE=""; READLINE_POINT=0
  # 注入管线内部行（__ot_inj 分片装配 / eval 解包）不青色重绘：重绘会把
  # base64 分片当命令回显画进主屏（内部语法不该出现在屏幕上）
  case "$t" in
    __ot_inj=*|_ot_inj=*|'eval "$(echo "$__ot_inj"'*) ;;
    *) __ot_repaint "$exp" ;;
  esac
  __ot_run "$exp"
  return 0
}
bind -x '"\C-m": __ot_submit'
bind -x '"\C-j": __ot_submit'
# 子 shell 继承（bug 修复：su 不带 - 切 root 后集成与主题色丢失）：非 login
# 子 shell 继承导出的变量/函数/PROMPT_COMMAND/PS1；su - 等 login shell 会被
# root 的 profile 重置，无法覆盖
export __ot_i __ot_off __ot_clear __ot_last_ec __ot_pc_mine __ot_pc_orig __ot_ps1_orig
export __ot_tty_save
export PROMPT_COMMAND PS1
export -f __ot_prompt_cmd __ot_run __ot_submit __ot_repaint __ot_exec_run
# 尾部吸收行：分片二次追加的拼接点必须落在本行参数上，
# 否则上一行 export -f 名单会被拼接改名成不存在的假函数名
: __ot_script_end
'''.strip()

_ZSH_SCRIPT = r'''
__ot_i=@@INST@@
__ot_off=0
# 单管线（§5.6）：历史自然累积进唯一 xterm 的 scrollback，不再每命令清屏
__ot_clear=0
export PAGER=cat GIT_PAGER=cat
__ot_precmd() {
  local ec=$?
  printf '\033]133;D;%s;%s;%s\007' "$ec" "$__ot_i" "$PWD"
  if (( __ot_off != 1 && __ot_clear == 1 )); then printf '\033[H\033[2J'; fi
  return 0
}
case " ${precmd_functions[*]} " in
  *" __ot_precmd "*) ;;
  *) precmd_functions=(__ot_precmd $precmd_functions) ;;
esac
if [[ -z "$__ot_ps1_orig" ]]; then __ot_ps1_orig="$PS1"; fi
# PS1 不另行配色（观感对齐 main 分支：提示符用终端默认前景白）；原生 PS1
# 存 __ot_ps1_orig 备用。
# zsh 的提示符展开不处理反斜杠转义（bash 的 PS1 会，zsh 不会）：
# 单引号里的 \033 会按字面输出，OSC 133 标记永远不出现。必须用 $'...'
# ANSI-C 引用让 ESC/BEL 在赋值期就变成真实字节。
PS1=$'%{\e]133;A;'"$__ot_i"$'\a%}[%n@%m %~]# %{\e]133;B;'"$__ot_i"$'\a%}'
# 首词可解析性判定（回显 CMD/AI）：先剥反斜杠转义；$VAR 与 $VAR/剩余 形式先
# 替换变量值再查——whence 按字面查 "$EDITOR"、"$JAVA_HOME/bin/java" 恒落空，
# 会把真命令误送 AI（真机复现）。变量未设值时展开为空 → 判 AI 交模型兜底。
__ot_resolve() {
  local w="$1" vn val
  case "$w" in "\\"*) w="${w#\\}" ;; esac
  case "$w" in
    '$'*)
      vn="${w#\$}"; vn="${vn%%[!A-Za-z0-9_]*}"; val=""
      [[ -n "$vn" ]] && val="${(P)vn}"
      w="${val}${w#\$"$vn"}"
      [[ -z "$w" ]] && { echo AI; return; } ;;
  esac
  if whence -w -- "$w" >/dev/null 2>&1; then echo CMD; else echo AI; fi
}
# 高危英文自然语言（语义同 bash 侧 __ot_nl_en 注释）：裸 builtin 首词 + 英文虚词
# → 判自然语言；read -r line / kill -9 123 这类真命令不含虚词，不受影响。
__ot_nl_en() {
  case "$1" in
    read|wait|clear|exit|logout|help|test|time|export|source|kill|jobs|history|set|let|dirs|pushd|popd) ;;
    *) return 1 ;;
  esac
  setopt localoptions noglob
  local w
  for w in ${=2}; do
    case "$w" in
      the|a|an|and|or|but|for|to|from|with|into|about|after|before|then|than|me|my|your|our|their|this|that|these|those|please|is|are|was|were|be|will|would|should|could|again|up)
        return 0 ;;
    esac
  done
  return 1
}
__ot_submit() {
  # extendedglob：strip 表达式里的 # 量词需要；localoptions 只在本函数内生效
  setopt localoptions extendedglob
  local line="$BUFFER" kind t first show rest r0 r1
  # POSTEDIT 是持久参数：上一次 accept-line 设的青色重绘会在本次 accept-line
  # 时原样输出（pad/空行/off 早退路径每提交一次就泄一行旧回显，卡片盖住垃圾行）。
  # 先统一清掉，正常路径末尾再按本次 $show 重新赋值。
  POSTEDIT=""
  case "$line" in
    # __ot_pad N：打印 N 个空行后清行提交（占位行由 shell 打印）
    '__ot_pad '*)
      t="${line:9}"; [[ -z "$t" || "$t" == *[!0-9]* ]] && t=1
      (( t > 50 )) && t=50
      BUFFER=""
      # 抹掉「提示符+__ot_pad N」回显行再打空行（bash 侧清 READLINE_LINE 同理）：
      # 不清则每注入多残留一行，占位行数漂移、卡片盖不住 pad 出现裸空白
      printf '\r\033[2K'
      repeat "$t" print ""
      zle .accept-line
      return ;;
    '__ot_exec__ '*)
      t="${line:12}"; kind=EXEC
      # 显示用还原：base64 包装解码回原命令（青色回显不出现包装语法）
      show="$t"
      if [[ "$t" == 'eval "$(echo '* ]]; then
        local b="${t#*echo }"
        b="${b%% | base64*}"
        show="$(printf %s "$b" | base64 -d 2>/dev/null)" || show="$t"
        [[ -z "$show" ]] && show="$t"
      fi
      BUFFER="$t"; CURSOR=${#t} ;;
    *)
      if (( __ot_off == 1 )); then zle .accept-line; return; fi
      # 去掉行首空白（## [[:space:]]#）。原写法 ${line#"${line%%[![:space:]]#}"}
      # 有两处错：无 extendedglob 时 # 是字面量、t 恒空，整个 hook 静默失效；
      # 有 extendedglob 也会把无前导空白的行的第一个词吞掉（"echo xy"→"xy"）
      t="${line##[[:space:]]#}"
      if [[ -z "$t" ]]; then zle .accept-line; return; fi
      show="$t"
      case "$t" in
        '?'*) kind=AI ;;
        '!'*) t="${t:1}"; kind=CMD; show="$t"; BUFFER="$t"; CURSOR=${#t} ;;
        '('*) kind=CMD ;;   # 子 shell 开头必是 shell 语法（首词被 ( 截空须直判）
        '$('*) kind=CMD ;;  # 命令替换开头（$(which py) x.py）：$ 不在操作符集里，落默认分支首词截成 $ 会误 AI
        '`'*) kind=CMD ;;   # 反引号替换开头同理
        '{'*) kind=CMD ;;   # 花括号组 { ls; }：首词 { 查不到会被误 AI
        '#'*) kind=CMD ;;   # 注释行交 shell 按注释 eval（无副作用），不为备注起 AI 任务
        *'|'*|*'&'*|*';'*|*'>'*|*'<'*|*'`'*)
          # 含操作符：首个操作符前的首词须可解析为命令（或赋值）才算命令，
          # 否则是自然语言（"把日志保存>log.txt"、"注意a|b的区别"不再整行执行）
          first="${t%%[[:space:]]*}"; first="${first%%[;|&()<>]*}"
          if [[ -z "$first" ]]; then kind=CMD   # 重定向开头（>log）：剥掉 <> 后首词空，合法 shell 语法
          elif [[ "$first" == [A-Za-z_]*=* ]]; then kind=CMD
          else
            kind="$(__ot_resolve "$first")"
            if [[ "$kind" == CMD ]] && __ot_nl_en "$first" "$t"; then kind=AI; fi
          fi ;;
        *) first="${t%%[[:space:]]*}"; first="${first%%[;|&()<>]*}"
           # 赋值/环境前缀只在首词是合法标识符时才算命令（FOO=bar / arr[0]=x）：
           # 自然语言里带 "="（"把ll=ls设为别名"）首词非标识符，落回 whence
           # 判成 AI——原 "*=*" 会把整行当命令执行报 "command not found"
           if [[ "$first" == [A-Za-z_]*=* ]]; then
             # NAME=value 后还有词 = 环境前缀，仅当后续首词可解析为命令；
             # 否则是自然语言（裸 "ll=ls -al的别名设置为永久" 由此兜住）。
             # 连续多变量前缀（A=1 B=2 cmd）须逐个剥——旧版只看 rest 首词，
             # r1 取到第二个赋值查不到，真命令被误 AI（真机复现）
             rest="${t#"$first"}"; rest="${rest##[[:space:]]#}"
             while [[ "$rest" == [A-Za-z_]*=* ]]; do
               r0="${rest%%[[:space:]]*}"
               rest="${rest#"$r0"}"; rest="${rest##[[:space:]]#}"
             done
             if [[ -z "$rest" ]]; then kind=CMD
             else
               r1="${rest%%[[:space:]]*}"; r1="${r1%%[;|&()<>]*}"
               kind="$(__ot_resolve "$r1")"
             fi
           # whence -w 覆盖 reserved word/builtin/alias/function/path，且必须按
           # 退出码判：zsh 5.9 对不存在的名字输出非空的"名字: none"，旧的
           # [[ -n "$(...)" ]] 恒真——zsh 侧自然语言曾被整判成 CMD（同 bash
           # 的 *=* 事故）。command -v 找不到 exit/if/for 等关键字，会误判
           else
             kind="$(__ot_resolve "$first")"
             if [[ "$kind" == CMD ]] && __ot_nl_en "$first" "$t"; then kind=AI; fi
           fi ;;
      esac ;;
  esac
  printf '\033]6337;%s;%s;%s\007' "$__ot_i" "$kind" "$t"
  # 注入管线内部行（__ot_inj 分片装配 / eval 解包）不做青色重绘：它们是内部
  # 语法，重绘会把 base64 分片当命令回显画进主屏（且重绘字节落在 C…D exec
  # 相位，绕过 worker 的 _suppress_live 吞除，每任务泄 ~8 行垃圾）
  case "$t" in
    '__ot_inj='*|'_ot_inj='*|'eval "$(echo "$__ot_inj"'*) ;;
    *)
      local p="${PWD/#$HOME/\~}" c='#' col=51
      [[ $EUID != 0 ]] && c='%'
      # 用户自然语言（AI）蓝色、命令青色（Workbench 观感：输入蓝/命令青）
      [[ "$kind" == AI ]] && col=33
      POSTEDIT=$'\e[F\e[2K['"$USER@$HOST $p"$']'"$c"$' \e[38;5;'"$col"$'m'"$show"$'\e[0m\n' ;;
  esac
  if [[ "$kind" == AI ]]; then
    print -s -- "$line"
    BUFFER=""
    zle .accept-line
  else
    printf '\033]133;C;%s\007' "$__ot_i"
    zle .accept-line
  fi
}
# 半行保存/恢复（同 bash 侧 __ot_kill_line/__ot_yank_line）：注入 \x15 杀行
# 前把半行存 __ot_saved（不经 kill ring），注入收尾的 \x19 仅在有存档时接回
# 行首、光标落拼接点——空行零副作用。任务期用户打字与注入交错时打字内容
# 原样接回（真机「任务跑着打字只剩尾巴」根因）。worker 保证每 \x15 配一 \x19。
__ot_saved=
__ot_kill_line() { __ot_saved="$BUFFER"; BUFFER=""; CURSOR=0; }
__ot_yank_line() {
  if [[ -n "$__ot_saved" ]]; then
    BUFFER="$__ot_saved$BUFFER"; CURSOR=${#__ot_saved}; __ot_saved=
  fi
}
zle -N __ot_kill_line
zle -N __ot_yank_line
bindkey '^U' __ot_kill_line
bindkey '^Y' __ot_yank_line
zle -N __ot_submit
bindkey '^M' __ot_submit
# PTY 开 ICRNL：发送端 \r 会被内核翻成 \n（^J）才到 zle，必须同时绑 ^J
# （与 bash 脚本绑 \C-m + \C-j 同理），否则 Enter 走默认 accept-line、hook 不上报
bindkey '^J' __ot_submit
# 尾部吸收行（同 bash）：分片拼接尾巴不得改写上面的绑定行
: __ot_script_end
'''.strip()

# PowerShell 5.1 + PSReadLine 2.0.0：无 SetBufferState，AI/注入路径用
# AddToHistory+CancelLine（清缓冲）与 $global:__ot_pending + prompt() 内执行
# （注入命令）达成。prompt() 顶部发 D（上一条 AcceptLine 命令的退出码）、
# pending 执行内联发 C…D（不能等下一个 prompt——那会把用户输入期挂进 EXEC 相位）。
_PS_SCRIPT = r'''
$global:__ot_i = @@INST@@
$global:__ot_off = 0
# 单管线（§5.6）：历史自然累积进唯一 xterm 的 scrollback，不再每命令清屏
$global:__ot_clear = 0
$global:__ot_skip_d = $false
$global:__ot_pad_rows = 0
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
# 输入即时青色（§5.6）：PSReadLine 按 token 着色——main 分支的输入区是
# 统一青色文本，所以把各 token 类一并染青（仅 Comment 留灰），无提交后重绘
try {
  Set-PSReadLineOption -Colors @{
    Default = '#39c5cf'; Command = '#39c5cf'; Parameter = '#39c5cf'
    String = '#39c5cf'; Number = '#39c5cf'; Variable = '#39c5cf'
    Operator = '#39c5cf'; Keyword = '#39c5cf'; Type = '#39c5cf'
    Comment = '#9aa0a6'
  }
} catch {}
function global:__ot_osc([string]$body) {
  [Console]::Out.Write(([char]27).ToString() + ']' + $body + ([char]7).ToString())
}
# 清空当前输入行并触发新提示符周期：优先 RevertLine（无 ^C 视觉），失败或
# 缓冲未清空时回退 CancelLine（会显示 ^C，但保证缓冲清空）。
function global:__ot_clearline {
  $l = 'x'
  try {
    [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine($null, $null)
    $c = 0; $l = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$l, [ref]$c)
  } catch { $l = 'x' }
  if ($null -ne $l -and $l -eq '') {
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
  } else {
    [Microsoft.PowerShell.PSConsoleReadLine]::CancelLine()
  }
}
if (-not $global:__ot_orig_prompt) {
  $global:__ot_orig_prompt = (Get-Item Function:\prompt -ErrorAction SilentlyContinue).ScriptBlock
  if (-not $global:__ot_orig_prompt) { $global:__ot_orig_prompt = { "PS $((Get-Location).Path)> " } }
}
# 提示符不另行配色（观感对齐 main 分支：提示符默认前景白，输入青色）
function global:prompt {
  # D 标记：handler 内联执行过（EXEC/!）后由 __ot_skip_d 抑制孤儿 D；
  # 原生 AcceptLine 路径（CMD）在这里发上一条命令的 D。
  if ($global:__ot_skip_d) {
    $global:__ot_skip_d = $false
  } else {
    $ec = 0
    if ($null -ne $global:LASTEXITCODE) { $ec = $global:LASTEXITCODE }
    elseif (-not $?) { $ec = 1 }
    __ot_osc("133;D;$ec;$($global:__ot_i);$((Get-Location).Path)")
  }
  $global:LASTEXITCODE = $null
  if ($global:__ot_off -ne 1 -and $global:__ot_clear -eq 1) {
    [Console]::Out.Write(([char]27).ToString() + '[H' + ([char]27).ToString() + '[2J')
  }
  $e = ([char]27).ToString()
  # pad 占位空行：Enter handler 存的行数在这里并入提示符串（见 __ot_pad 分支）
  $padLines = ''
  if ($global:__ot_pad_rows -gt 0) {
    $padLines = ("`n" * $global:__ot_pad_rows)
    $global:__ot_pad_rows = 0
  }
  return ($padLines + $e + "]133;A;$($global:__ot_i)" + ([char]7).ToString() +
          'PS ' + $((Get-Location).Path) + '> ' +
          $e + "]133;B;$($global:__ot_i)" + ([char]7).ToString())
}
# EXEC/! 路径的内联执行：C → iex|Out-Host → D。必须在 Enter handler 里跑而
# 不是 prompt() 里——prompt() 是函数作用域，`$x=1`/`__ot_off=1` 这类赋值会随
# 函数返回丢失；handler ScriptBlock 捕获的是全局会话状态。输出必须 Out-Host
# 直写主机，否则会被收集进 prompt 返回值、在 D 标记之后才显示。
function global:__ot_exec_inline([string]$cmd) {
  __ot_osc("133;C;$($global:__ot_i)")
  $global:LASTEXITCODE = $null
  $ok = $true
  try { Invoke-Expression $cmd | Out-Host } catch { Write-Host $_.Exception.Message; $ok = $false }
  $ec = 0
  if ($null -ne $global:LASTEXITCODE) { $ec = $global:LASTEXITCODE } elseif (-not $ok) { $ec = 1 }
  __ot_osc("133;D;$ec;$($global:__ot_i);$((Get-Location).Path)")
  $global:__ot_skip_d = $true
  $global:LASTEXITCODE = $null
}
# 高危英文自然语言（语义同 bash/zsh 侧 __ot_nl_en 注释）：首词是「一跑就错/
# 阻塞/静默成功」的裸命令且行内含英文虚词 → 自然语言。真命令不含虚词，不受影响。
function global:Test-OtNlEn([string]$first, [string]$line) {
  $risk = @('read','wait','clear','exit','logout','help','test','time',
            'export','source','kill','jobs','history','set','let','dirs')
  if ($risk -notcontains $first) { return $false }
  $stop = @('the','a','an','and','or','but','for','to','from','with','into',
            'about','after','before','then','than','me','my','your','our',
            'their','this','that','these','those','please','is','are','was',
            'were','be','will','would','should','could','again','up')
  foreach ($w in ($line -split '\s+')) {
    if ($stop -contains $w.ToLower()) { return $true }
  }
  return $false
}
Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
  $line = $null; $cur = 0
  [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cur)
  if ($null -eq $line) { $line = '' }
  # __ot_pad N：清掉自身回显行后打印 N 个空行（卡片占位行由 shell 打印，
  # ConPTY 模型一致）。空行不能在 handler 里 [Console]::Write——PSReadLine
  # 随后的提示符重绘会整块覆盖非它渲染的内容；改成把空行并入 prompt 返回
  # 串（__ot_pad_rows），由 PSReadLine 自己渲染进输出流。
  if ($line.StartsWith('__ot_pad ')) {
    $t = 1
    if (-not [int]::TryParse($line.Substring(9).Trim(), [ref]$t)) { $t = 1 }
    if ($t -lt 1) { $t = 1 } elseif ($t -gt 50) { $t = 50 }
    $global:__ot_pad_rows = $t
    __ot_clearline
    return
  }
  if ($line.StartsWith('__ot_exec__ ')) {
    $inj = $line.Substring(12)
    __ot_osc("6337;$($global:__ot_i);EXEC;$inj")
    __ot_exec_inline $inj
    __ot_clearline
    return
  }
  if ($global:__ot_off -eq 1) { [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine(); return }
  $t = $line.TrimStart()
  if ($t -eq '') { [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine(); return }
  if ($t.StartsWith('?')) {
    __ot_osc("6337;$($global:__ot_i);AI;$line")
    [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($line)
    __ot_clearline
    return
  }
  if ($t.StartsWith('!')) {
    $t = $t.Substring(1).TrimStart()
    __ot_osc("6337;$($global:__ot_i);CMD;$t")
    [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($line)
    __ot_exec_inline $t
    __ot_clearline
    return
  }
  if ($t.StartsWith('/')) {
    # 斜杠命令（/clear 等）交给 worker 拦截：按 AI 上报并清缓冲。
    # 必须放在路径规则（$first -match '[\\/]'）之前——否则被误判 CMD 原生执行报错
    __ot_osc("6337;$($global:__ot_i);AI;$line")
    [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($line)
    __ot_clearline
    return
  }
  $first = ($t -split '[\s;|&()]+')[0]
  # 关键字（exit/if/for…）必须走原生执行：Get-Command 查不到关键字，误判 AI
  # 会把 exit 这类行直接吞掉
  $kw = @('exit','quit','if','else','elseif','foreach','for','while','do',
          'switch','try','catch','finally','function','return','break',
          'continue','throw','param','begin','process','end','in')
  if ($kw -contains $first) {
    __ot_osc("6337;$($global:__ot_i);CMD;$t")
    __ot_osc("133;C;$($global:__ot_i)")
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    return
  }
  $resolves = ($first -ne '') -and
              [bool](Get-Command $first -ErrorAction SilentlyContinue)
  if ($resolves -and (Test-OtNlEn $first $t)) {
    # 高危英文自然语言（read the log… / clear up the mess…）：首词可解析但
    # 整句是英文话——送 AI，避免 read/wait 阻塞 stdin、clear/exit 静默成功
    __ot_osc("6337;$($global:__ot_i);AI;$line")
    [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($line)
    __ot_clearline
    return
  }
  if ($resolves) {
    __ot_osc("6337;$($global:__ot_i);CMD;$t")
    __ot_osc("133;C;$($global:__ot_i)")
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    return
  }
  # 首词不可解析时的原生执行白名单：shell 语法开头（$var=、(expr)、{组、
  # `替换）、路径（.\x、/x、C:\x）、剥括号后首词空（(get-date).Day、>log）。
  # 旧规则「整行任意位置含 =|&;><`{}() 即 CMD」不看首词，英文自然语言
  # （what does a=b mean、rename "a(1).txt"）会被整行原生执行报错
  if ($first -eq '' -or $t -match '^\s*[\$({`~]' -or $first -match '[\\/]') {
    __ot_osc("6337;$($global:__ot_i);CMD;$t")
    __ot_osc("133;C;$($global:__ot_i)")
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    return
  }
  __ot_osc("6337;$($global:__ot_i);AI;$line")
  [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($line)
  __ot_clearline
}
# Windows EditMode 默认 Ctrl+U 未绑定（字面入 buffer）、Ctrl+Y=Redo。
# InteractiveRunner 的 Ctrl+U/Ctrl+Y kill-ring 括号依赖这两个显式绑定。
Set-PSReadLineKeyHandler -Chord 'Ctrl+u' -Function BackwardKillLine
Set-PSReadLineKeyHandler -Chord 'Ctrl+y' -Function Yank
'''.strip()

_SCRIPTS = {"bash": _BASH_SCRIPT, "zsh": _ZSH_SCRIPT, "powershell": _PS_SCRIPT}


def build_script(shell: str, instance: int) -> str:
    """生成指定 shell / 实例号的集成脚本（多行文本）。"""
    return _SCRIPTS[shell].replace("@@INST@@", str(instance))


def injection_lines(shell: str, instance: int,
                    b64flag: str = "-d", chunk: int = 700) -> list[bytes]:
    """注入行拆成分片列表（每片一条完整 shell 行，以 \\r 结尾）。

    单行注入动辄 2~4KB，超过 tty canonical 输入缓冲（macOS 本地 ~1024、
    Linux ~4096）会被静默丢弃，集成注入随缘失败。拆成多条短行：前几行
    分段赋值拼接 base64，末行 eval 还原执行。每片 < chunk 字节，远小于
    最小的 canonical 缓冲；调用方在片间稍作停顿，等 shell 消费完再发下片。
    b64 字母表不含引号，单引号包裹安全。
    """
    b64 = base64.b64encode(build_script(shell, instance).encode()).decode()
    if shell == "powershell":
        cmd = ("iex ([Text.Encoding]::UTF8.GetString("
               f"[Convert]::FromBase64String('{b64}')))")
        return [cmd.encode() + b"\r"]
    parts = [b64[i:i + chunk] for i in range(0, len(b64), chunk)]
    lines = [f"__ot_inj='{parts[0]}'"]
    for p in parts[1:]:
        lines.append(f"__ot_inj=\"$__ot_inj\"'{p}'")
    lines.append(f'eval "$(echo "$__ot_inj" | base64 {b64flag})"')
    return [l.encode() + b"\r" for l in lines]


def injection_line(shell: str, instance: int, b64flag: str = "-d") -> bytes:
    """首次注入行（无 hook 的裸 shell 直接执行，以 \\r 结尾）。

    单行版本：仅适用于 canonical 缓冲足够大的会话（远端 SSH）；本地
    macOS 会话请用 injection_lines 分片发送。
    """
    return b"".join(injection_lines(shell, instance, b64flag))


def history_inject_line(shell: str, commands: list[str],
                        b64flag: str = "-d") -> bytes:
    """历史记忆注入行：把 DB 里的近期命令灌进远端 shell 历史（单行、\\r 结尾）。

    在集成脚本注入前（裸 shell 阶段）发送：bash 用 ``history -r``、zsh 用
    ``fc -R`` 读入临时文件，使 ``history`` 命令与 ↑ 键原生可见；bash 再用
    ``history -d "$HISTCMD"`` 删掉注入行自身，避免超长 base64 污染历史。
    PowerShell 尽力而为：追加进 PSReadLine 历史文件（下一会话生效）。
    """
    # 连续重复去重（同一条命令反复执行是常态）+ 丢弃空行
    seen: list[str] = []
    for c in commands:
        c = c.strip()
        if c and (not seen or seen[-1] != c):
            seen.append(c)
    if not seen:
        return b""
    b64 = base64.b64encode("\n".join(seen).encode("utf-8")).decode()
    if shell == "powershell":
        cmd = (
            "$p=(Get-PSReadLineOption).HistorySavePath;"
            "$t=[Text.Encoding]::UTF8.GetString("
            f"[Convert]::FromBase64String('{b64}'));"
            "[IO.File]::AppendAllText($p, $t + \"`n\")"
        )
    elif shell == "zsh":
        # zsh 无便捷的「删当前历史项」内建，注入行自身会留在历史里（可接受）
        cmd = (f'echo {b64} | base64 {b64flag} > "$HOME/.ot_hist_$$" && '
               f'fc -R "$HOME/.ot_hist_$$" && rm -f "$HOME/.ot_hist_$$"')
    else:  # bash
        cmd = (f'echo {b64} | base64 {b64flag} > "$HOME/.ot_hist_$$" && '
               f'history -r "$HOME/.ot_hist_$$" && rm -f "$HOME/.ot_hist_$$"; '
               f'[ -n "$HISTCMD" ] && history -d "$HISTCMD" 2>/dev/null')
    return cmd.encode() + b"\r"


_INTERNAL_LINE_PREFIXES = ("_ot_inj", "__ot_inj", "__ot_exec__", "__ot_pad")
_INTERNAL_LINE_EVAL = 'eval "$(echo "$__ot_inj"'


def is_internal_line(line: str) -> bool:
    """注入管线内部行（分片装配 / 回显包装）判定。

    这些行不入历史库：每次任务 _ensure_integrated 重发 ~8 条 ~700B 分片，
    记进 history 后回灌单行迅速超过 tty canonical 缓冲（macOS ~1KB），
    截断让 shell 卡在续行态、写通道 EAGAIN 死锁（黑屏）。
    """
    s = (line or "").lstrip()
    return s.startswith(_INTERNAL_LINE_PREFIXES) or s.startswith(_INTERNAL_LINE_EVAL)


def agent_exec_line(shell: str, command: str, b64flag: str = "-d") -> bytes:
    """AI 工具命令的注入行：``__ot_exec__ `` 前缀 + 命令本体。

    优先明文注入：tty 回显即命令本身（青色，§5.6 观感），且不吞回显——
    Windows ConPTY 按自己的缓冲区模型发绝对光标定位重绘，任何被 worker 吞掉
    的字节都会让 xterm 与 ConPTY 光标失步（实测提示符叠印/内容覆盖的根因）。
    仅含换行或非打印字符时回落 base64 包装（任意引号安全）。
    """
    if "\n" not in command and "\r" not in command \
            and all(0x20 <= ord(c) <= 0x7e for c in command):
        return (EXEC_PREFIX + command).encode() + b"\r"
    b64 = base64.b64encode(command.encode("utf-8")).decode()
    if shell == "powershell":
        body = ("iex ([Text.Encoding]::UTF8.GetString("
                f"[Convert]::FromBase64String('{b64}')))")
    else:
        body = f'eval "$(echo {b64} | base64 {b64flag})"'
    return (EXEC_PREFIX + body).encode() + b"\r"


def toggle_line(shell: str, agent_on: bool) -> bytes:
    """Agent/Shell 模式切换：hook 纯透传开关（__ot_exec__ 通道，静默执行）。

    PowerShell 的赋值必须显式 ``$global:``——iex 在函数/handler 作用域里跑，
    裸赋值会随作用域销毁（bash 函数内裸赋值默认写全局变量，无此问题）。
    """
    val = 0 if agent_on else 1
    name = "$global:__ot_off" if shell == "powershell" else "__ot_off"
    return f"{EXEC_PREFIX}{name}={val}".encode() + b"\r"


def probe_command(os_family: str) -> str:
    """能力探测命令（旧哨兵 run 通道执行）：shell 种类 + base64 解码参数。"""
    if os_family == "windows":
        return (f"if (Get-Module PSReadLine) {{ Write-Output "
                f"'{PROBE_TAG}powershell|ok' }} else {{ Write-Output "
                f"'{PROBE_TAG}none|none' }}")
    return (
        'v=""; [ -n "$BASH_VERSION" ] && v="bash$BASH_VERSION"; '
        '[ -n "$ZSH_VERSION" ] && v="zsh$ZSH_VERSION"; d="none"; '
        '[ "$(echo aGVsbG8= | base64 -d 2>/dev/null)" = hello ] && d="-d"; '
        '[ "$d" = none ] && [ "$(echo aGVsbG8= | base64 -D 2>/dev/null)" = hello ] '
        '&& d="-D"; '
        f'echo "{PROBE_TAG}${{v:-none}}|$d"'
    )


def parse_probe(output: str) -> tuple[str | None, str]:
    """解析探测输出 → (shell 或 None, base64 解码参数)。None = 走旧批处理模型。"""
    # 版本段用「到 | 为止」的宽松捕获：$BASH_VERSION 真实值形如
    # "5.1.8(1)-release"（带括号/连字符），字符类匹配会在 ( 处截断导致
    # 整体不匹配 → bash 主机永远静默回退批处理模型
    m = re.search(re.escape(PROBE_TAG) + r"([^\r\n|]*)\|([^\r\n]*)", output or "")
    if not m:
        return None, "-d"
    ver, flag = m.group(1), m.group(2).strip()
    if ver.startswith("bash"):
        major = _to_int(re.match(r"bash(\d+)", ver).group(1), 0)
        return ("bash" if major and major >= 4 else None), (flag or "-d")
    if ver.startswith("zsh"):
        return "zsh", (flag or "-d")
    if ver == "powershell":
        return "powershell", "-d"
    return None, "-d"


# ---------------------------------------------------------------------------
# 增量流解析器
# ---------------------------------------------------------------------------

class StreamRouter:
    """按 OSC 标记切分 PTY 字节流的增量解析器。

    相位：SWALLOW（注入回显/横幅，丢弃数据但解析标记）→ INPUT（live）⇄
    EXEC（exec）。feed() 返回事件列表：

    - ``("live", text)`` / ``("exec", text)``：已解码文本（相邻同通道合并）
    - ``("prompt_start", inst)``：A 标记
    - ``("prompt", plain)``：B 标记，plain 为去 ANSI 的提示符纯文本
    - ``("exec_start", inst)``：C 标记
    - ``("exec_end", inst, exit_code|None, cwd|None)``：D 标记
    - ``("report", inst, kind, line)``：6337 行报告（CMD/AI/EXEC）
    """

    SWALLOW = "swallow"
    INPUT = "input"
    EXEC = "exec"

    #: 未终结 OSC 的最大挂起长度，超过按普通数据放行（防恶意/损坏流卡死）
    MAX_OSC = 65536

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._buf = b""
        self.phase = self.SWALLOW
        self.inst = 0
        self._dec = codecs.getincrementaldecoder("utf-8")("replace")
        self._in_prompt = False
        self._prompt_raw = bytearray()

    def feed(self, data: bytes) -> list[tuple]:
        events: list[tuple] = []
        self._buf += data
        while self._buf:
            i = self._buf.find(b"\x1b")
            if i < 0:
                self._emit(self._buf, events)
                self._buf = b""
                break
            if i > 0:
                self._emit(self._buf[:i], events)
                self._buf = self._buf[i:]
                continue
            # buf 以 ESC 开头
            if len(self._buf) < 2:
                break                            # 序列类型未知，等下一块
            if self._buf[1:2] != b"]":
                # 非 OSC 转义（CSI 等）：ESC 原样放行，后续字节按数据处理
                self._emit(b"\x1b", events)
                self._buf = self._buf[1:]
                continue
            found = self._osc_end()
            if found is None:
                if len(self._buf) > self.MAX_OSC:
                    self._emit(self._buf, events)
                    self._buf = b""
                break                            # OSC 未终结，等下一块
            body, consumed = found
            self._buf = self._buf[consumed:]
            self._osc(body, events)
        return events

    def _osc_end(self) -> tuple[bytes, int] | None:
        """在 _buf（以 ESC ] 开头）里找 BEL 或 ESC \\ 终结符。"""
        b = self._buf
        j = 2
        while j < len(b):
            if b[j] == 0x07:
                return b[2:j], j + 1
            if b[j] == 0x1B and b[j + 1:j + 2] == b"\\":
                return b[2:j], j + 2
            j += 1
        return None

    def _emit(self, payload: bytes, events: list[tuple]) -> None:
        if not payload:
            return
        if self._in_prompt:
            self._prompt_raw.extend(payload)
        if self.phase == self.SWALLOW:
            return
        text = self._dec.decode(payload)
        if not text:
            return
        kind = "exec" if self.phase == self.EXEC else "live"
        if events and events[-1][0] == kind and len(events[-1]) == 2:
            events[-1] = (kind, events[-1][1] + text)
        else:
            events.append((kind, text))

    def _osc(self, body: bytes, events: list[tuple]) -> None:
        s = body.decode("utf-8", "replace")
        parts = s.split(";")
        head = parts[0]
        if head == "133" and len(parts) >= 2:
            code = parts[1]
            if code == "A":
                if len(parts) > 2:
                    self.inst = _to_int(parts[2], self.inst)
                self.phase = self.INPUT
                self._in_prompt = True
                self._prompt_raw = bytearray()
                events.append(("prompt_start", self.inst))
            elif code == "B":
                self._in_prompt = False
                plain = strip_ansi(
                    self._prompt_raw.decode("utf-8", "replace")).rstrip()
                self._prompt_raw = bytearray()
                events.append(("prompt", plain))
            elif code == "C":
                if len(parts) > 2:
                    self.inst = _to_int(parts[2], self.inst)
                self.phase = self.EXEC
                events.append(("exec_start", self.inst))
            elif code == "D":
                ec = _to_int(parts[2], None) if len(parts) > 2 else None
                inst = _to_int(parts[3], self.inst) if len(parts) > 3 else self.inst
                cwd = ";".join(parts[4:]) if len(parts) > 4 else ""
                self.phase = self.INPUT
                events.append(("exec_end", inst, ec, cwd or None))
        elif head == "6337" and len(parts) >= 4:
            inst = _to_int(parts[1], self.inst)
            events.append(("report", inst, parts[2], ";".join(parts[3:])))
