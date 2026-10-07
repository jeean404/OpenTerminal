"""Agent 装配：模型、系统提示词、审批/拒绝、有界任务执行。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, ToolMessage

from .token_est import count_tokens
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError

from .backend import PtyShellBackend
from .config import Config, ModelConfig
from .policy import Policy
from .skills import skill_routes, skill_sources
from .sysprobe import SystemProfile

_DIALECT_TABLE = """
| 意图 | debian/Ubuntu | rhel CentOS7 | rhel Rocky/Fedora | alpine | darwin |
|---|---|---|---|---|---|
| 安装软件 jq | sudo apt-get install -y jq | sudo yum install -y jq | sudo dnf install -y jq | sudo apk add jq | brew install jq |
| 重启 nginx | sudo systemctl restart nginx | 同左 | 同左 | sudo rc-service nginx restart | brew services restart nginx |
| 查监听端口 | ss -ltnp | netstat -ltnp | ss -ltnp | netstat -ltnp | lsof -i |
"""


def build_system_prompt(p: SystemProfile) -> str:
    tools = ", ".join(sorted(p.tools)) or "未探测到额外工具"
    return f"""你是 OpenTerminal，一个运行在用户自带终端里的运维助手。

## 当前目标系统
- 主机：{p.host}
- 系统：{p.distro}（family={p.os_family}, version={p.version}, kernel={p.kernel}）
- 包管理器：{p.pkg_manager}；服务管理器：{p.service_mgr}；shell：{p.shell}
- 已探测工具：{tools}

## 命令翻译规则
1. 所有命令必须适配上面的系统画像，禁止在非 debian 系上使用 apt。
2. 方言映射：
{_DIALECT_TABLE}
3. 软件安装/服务操作/删除等高危命令会触发用户审批，命令要尽量短小、可读。
4. 如果目标是远程主机，读写远程文件一律用 execute（cat/sed/tee 等），不要用
   read_file/write_file 等内置文件工具——它们作用于运行本程序的本机。
   例外：/skills/ 挂载的 SKILL.md 按 Skills 清单指引正常用 read_file 加载。
5. 命令失败时：先读懂 stderr 与 exit code，再换方案；同一个失败命令原样重试不超过
   一次；`command not found` 先用 `command -v` 探测；包管理器报错先核对系统画像。
6. 被安全策略拒绝或被用户拒绝的命令不得换皮重试，要给出替代方案或向用户说明。
7. 任务完成后用一句中文总结结果；没有完成时说明已尝试的命令、失败原因和建议。
8. 结论与多条命令的分析结果要美化输出：适合表格呈现的数据（多项对比、结果汇总、
   参数/指标列表）整理成 Markdown 表格，而不是堆文字；排版前可先 read_file 加载
   markdown-tables skill（见 Skills 清单）按其规范书写。小节标题单独成行并用 `##`
   开头（如 `## 内存使用`，可带 emoji）；结尾「结论」等段落用普通段落、关键短语加粗。
9. 命令保持简单、可读：够用就好，不要画蛇添足。除非用户明确要求，不加单位换算、
   computed property、内联脚本块、多余管道或 && 拼接，也不手动格式化输出——交给
   系统默认即可。PowerShell 优先短别名（Sort/Select/Where），POSIX 优先基础命令
   （ls/find/grep/df）。清晰胜过炫技：用户要的是结果，不是一行看起来很专业的命令。
"""


def build_chat_model(cfg: ModelConfig) -> Any:
    """按 cfg.provider 构造 langchain 聊天模型。

    anthropic → ChatAnthropic（缺省，走 base_url 网关）；openai → ChatOpenAI，
    任何 OpenAI 兼容协议网关（base_url 留空则用 SDK 官方端点）。langchain_openai
    在分支内惰性导入：anthropic 配置既不付导入耗时也不要求安装该包。
    """
    api_key = os.environ.get(cfg.api_key_env, "not-set")
    if cfg.provider == "openai":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=cfg.model,
            base_url=cfg.base_url or None,
            api_key=api_key,
            max_tokens=4096,
        )
    return ChatAnthropic(
        model=cfg.model,
        base_url=cfg.base_url,
        api_key=api_key,
        max_tokens=4096,
    )


class DenyMiddleware(AgentMiddleware):
    """灾难命令：不执行，直接把拒绝原因作为 tool 错误回模型。"""

    def __init__(self, policy: Policy) -> None:
        self.policy = policy

    async def awrap_tool_call(self, request, handler):
        tc = request.tool_call
        if tc.get("name") == "execute":
            cmd = tc.get("args", {}).get("command", "")
            d = self.policy.classify(cmd)
            if d.level == "deny":
                return ToolMessage(
                    content=f"命令被 OpenTerminal 安全策略拒绝：{cmd}\n原因："
                            f"{'；'.join(d.reasons)}。请换一个方案，不要换皮重试。",
                    tool_call_id=tc["id"],
                    status="error",
                )
        return await handler(request)


def build_agent(
    profile: SystemProfile,
    session,
    cfg: Config,
    policy: Policy | None = None,
    *,
    model: Any = None,
):
    """返回 (compiled_agent, session_allowed_commands)。"""
    policy = policy or Policy(
        mode=cfg.policy.mode,
        auto_extra=cfg.policy.auto_extra,
        approve_extra=cfg.policy.approve_extra,
        deny_extra=cfg.policy.deny_extra,
    )
    allowed: set[str] = set()
    backend = PtyShellBackend(session)

    def _when(req) -> bool:
        cmd = req.tool_call.get("args", {}).get("command", "")
        if cmd in allowed:
            return False
        return policy.classify(cmd).level == "approve"

    def _description(tc, state, runtime) -> str:
        cmd = tc.get("args", {}).get("command", "")
        reasons = "；".join(policy.classify(cmd).reasons) or "高危命令"
        return f"高危命令需要审批\n\n目标主机：{profile.host}\n风险点：{reasons}\n命令：{cmd}"

    middleware = [
        DenyMiddleware(policy),
    ]
    from langchain.agents.middleware import HumanInTheLoopMiddleware

    middleware.append(HumanInTheLoopMiddleware(interrupt_on={"execute": {
        "allowed_decisions": ["approve", "edit", "reject"],
        "when": _when,
        "description": _description,
    }}))

    agent = create_deep_agent(
        model=model or build_chat_model(cfg.model),
        backend=_with_skills(backend, middleware),
        system_prompt=build_system_prompt(profile),
        middleware=middleware,
        checkpointer=MemorySaver(),
    )
    return agent, allowed, backend


def _with_skills(backend: PtyShellBackend, middleware: list):
    """给 agent 挂上内置/用户两层 Agent Skills（渐进式披露）。

    skill 目录在文件沙箱（shell cwd）之外，故经 CompositeBackend 以
    /skills/... 虚拟前缀挂进文件系统：SkillsMiddleware 把 skill 清单
    注入系统提示词，模型按需 read_file 加载 SKILL.md 全文；用户目录
    后挂，同名 skill 覆盖内置。backend 本身原样返回给调用方（回调、
    cwd 语义不变），composite 只作为 agent 的文件/命令入口。
    """
    routes = skill_routes()
    if not routes:
        return backend
    agent_backend: Any = CompositeBackend(
        default=backend,
        routes={p: FilesystemBackend(root_dir=str(d)) for p, d in routes.items()},
    )
    middleware.append(
        SkillsMiddleware(backend=agent_backend, sources=skill_sources())
    )
    return agent_backend


@dataclass
class TaskEvent:
    kind: str
    text: str = ""
    command: str = ""
    reasons: list[str] = field(default_factory=list)
    name: str = ""      # tool_start/tool_end：工具名
    index: int = 0      # tool_start/tool_end：start/end 配对序号
    failed: bool = False  # tool_end：ToolMessage status=error


def _tool_args_summary(name: str, args: dict) -> str:
    """工具卡参数摘要：逐工具取关键参数（deepagents 内置文件工具的路径
    参数名是 file_path），未命中按常见参数名兜底，再取首个非空字符串值。"""
    keyed = {"read_file": "file_path", "write_file": "file_path",
             "edit_file": "file_path", "ls": "path", "glob": "pattern",
             "grep": "pattern", "load_skill": "file_path"}
    for key in (keyed.get(name), "file_path", "path", "pattern"):
        v = args.get(key) if key else None
        if isinstance(v, str) and v:
            return v[:120]
    return next((v[:120] for v in args.values() if isinstance(v, str) and v), "")


class TaskRunner:
    """一次用户任务的执行器：处理流式事件、中断暴露、resume 与轮次预算。"""

    def __init__(
        self, agent, thread_id: str, max_tool_turns: int = 10, *,
        on_event: Callable[[TaskEvent], None] | None = None,
    ) -> None:
        self.agent = agent
        self.cfg = {"configurable": {"thread_id": thread_id}}
        self.max_tool_turns = max_tool_turns
        self.on_event = on_event
        self.interrupt_payload: dict | None = None
        self._tool_calls = 0
        # 非 execute 工具的 start/end 配对记账（前端工具调用小卡）
        self._tool_seq = 0
        self._pending_tools: dict[str, tuple[int, str]] = {}
        self.input_tokens = 0    # 本次任务的累计输入 token（usage_metadata）
        self.output_tokens = 0   # 本次任务的累计输出 token
        # 会话栏 token 估算（tiktoken，token_est）：网关不回传 usage_metadata
        # 时的兜底口径。攒本轮驱动新流入的双向文本，驱动结束一次计价。
        self.est_input_tokens = 0
        self.est_output_tokens = 0
        self._est_in: list[str] = []
        self._est_out: list[str] = []

    def _add(self, events: list[TaskEvent], ev: TaskEvent) -> None:
        """live 事件：收集进返回列表的同时实时投递给展示层。"""
        events.append(ev)
        if self.on_event is not None:
            self.on_event(ev)

    def _config(self) -> dict:
        # 每个模型+工具往返约消耗 2 个 superstep，加固定余量
        return self.cfg

    async def run(self, text: str) -> list[TaskEvent]:
        self._est_in.append(text)
        return await self._drive(
            {"messages": [{"role": "user", "content": text}]}
        )

    async def resume(self, decisions: list[dict]) -> list[TaskEvent]:
        from langgraph.types import Command

        return await self._drive(Command(resume={"decisions": decisions}))

    async def _drive(self, payload) -> list[TaskEvent]:
        events: list[TaskEvent] = []
        self.interrupt_payload = None
        # 偏离计划（最小）：langgraph 1.2.11 中 astream(recursion_limit=...)
        # 属于已废弃且被静默忽略的 kwarg（实测不会生效，图会跑到默认上限），
        # 必须写进 config 顶层键才生效；实测每轮模型+工具约耗 3 个 superstep。
        run_cfg = {**self.cfg, "recursion_limit": self.max_tool_turns * 2 + 4}
        try:
            stream = self.agent.astream(
                payload, run_cfg,
                stream_mode=["updates", "messages"],
            )
            async for mode, chunk in stream:
                if mode == "messages":
                    msg, meta = chunk
                    if isinstance(msg, AIMessage) and msg.content and \
                            meta.get("langgraph_node") == "model":
                        # 思考块与正文分开流式：思考过程实时进前端分析卡
                        # （中间过程可见），正文继续走 token 通道
                        think, text = _split_content(msg.content)
                        if think:
                            self._est_out.append(think)
                            self._add(events, TaskEvent("think", think))
                        if text:
                            self._est_out.append(text)
                            self._add(events, TaskEvent("token", text))
                    # Anthropic 流式在 chunk 的 usage_metadata 里累计
                    # input/output token，取峰值即为该次调用的完整用量
                    usage = getattr(msg, "usage_metadata", None) or {}
                    if usage:
                        self.input_tokens = max(
                            self.input_tokens, usage.get("input_tokens") or 0)
                        self.output_tokens = max(
                            self.output_tokens, usage.get("output_tokens") or 0)
                elif mode == "updates":
                    for node, val in (chunk or {}).items():
                        for m in val.get("messages", []) if isinstance(val, dict) else []:
                            await self._absorb(m, node, events)
        except GraphRecursionError:
            self._flush_est()
            self._add(events, TaskEvent(
                "limit",
                f"已达到工具调用预算（{self.max_tool_turns} 轮），任务停止。"
                "请缩小目标或换一种问法。",
            ))
            return events
        self._flush_est()

        state = await self.agent.aget_state(self.cfg)
        for task in state.tasks:
            if task.interrupts:
                self.interrupt_payload = task.interrupts[0].value
                ar = self.interrupt_payload.get("action_requests", [{}])[0]
                events.append(TaskEvent(
                    "interrupt", command=ar.get("args", {}).get("command", ""),
                ))
        if not self.interrupt_payload:
            final = self._final_text(state)
            if final:
                events.append(TaskEvent("final", final))
        return events

    def _flush_est(self) -> None:
        """把本轮驱动攒下的双向文本一次计价（tiktoken 按整段切，边界准确）。"""
        if self._est_in:
            self.est_input_tokens += count_tokens("".join(self._est_in))
            self._est_in = []
        if self._est_out:
            self.est_output_tokens += count_tokens("".join(self._est_out))
            self._est_out = []

    async def _absorb(self, m, node: str, events: list[TaskEvent]) -> None:
        if isinstance(m, ToolMessage):
            # 工具结果回灌模型上下文 = 下轮输入 token 的大头（命令输出）
            self._est_in.append(m.content if isinstance(m.content, str)
                                else str(m.content))
            # start/end 按 tool_call_id 配对：execute 也发（远程目标上模型几乎
            # 只走 execute，不发卡则全程无工具卡可见），命令本体展示仍走
            # ai_collapse/输出流原生路径，卡片只做状态 Trail
            pending = self._pending_tools.pop(m.tool_call_id, None)
            if pending is not None:
                self._add(events, TaskEvent(
                    "tool_end", name=pending[1], index=pending[0],
                    failed=m.status == "error"))
        if isinstance(m, AIMessage) and m.tool_calls:
            for tc in m.tool_calls:
                if tc["name"] == "execute":
                    self._tool_calls += 1
                    self._add(events, TaskEvent(
                        "tool_call", command=tc["args"].get("command", "")
                    ))
                    self._tool_seq += 1
                    self._pending_tools[tc["id"]] = (self._tool_seq, "execute")
                    self._add(events, TaskEvent(
                        "tool_start", name="execute",
                        text=tc["args"].get("command", "")[:120],
                        index=self._tool_seq,
                    ))
                else:
                    self._tool_seq += 1
                    self._pending_tools[tc["id"]] = (self._tool_seq, tc["name"])
                    self._add(events, TaskEvent(
                        "tool_start", name=tc["name"],
                        text=_tool_args_summary(tc["name"], tc.get("args", {})),
                        index=self._tool_seq,
                    ))
        if isinstance(m, ToolMessage) and m.status == "error" and "安全策略拒绝" in m.content:
            self._add(events, TaskEvent("denied", text=m.content))

    def _final_text(self, state) -> str:
        for m in reversed(state.values.get("messages", [])):
            if isinstance(m, AIMessage) and m.content and not m.tool_calls:
                return message_text(m)
        return ""


def _split_content(content) -> tuple[str, str]:
    """消息 content 拆成 (思考, 正文) 两段。

    网关模型的 content 有多种形态（实测 127.0.0.1:15721 网关）：
    - 字符串：纯正文；
    - block 列表：[{'type': 'thinking', 'thinking': ...}, {'type': 'text',
      'text': ...}]（ainvoke/state 消息形态）；
    - 裸字符串混排列表：['', {'type': 'thinking', ...}, '正文']（astream
      chunk 合并形态——正文是裸 str 元素而非 text 块）。
    思考块单独返回，供前端分析卡展示模型的中间过程。
    """
    if isinstance(content, str):
        return "", content
    thinks: list[str] = []
    texts: list[str] = []
    for block in content or []:
        if isinstance(block, dict):
            if block.get("type") == "thinking":
                thinks.append(block.get("thinking", ""))
            elif block.get("type") == "text":
                texts.append(block.get("text", ""))
        elif isinstance(block, str):
            texts.append(block)
    return "".join(thinks), "".join(texts)


def message_text(msg: AIMessage) -> str:
    """从 AIMessage 取纯文本正文（思考块不进 final 总结）。"""
    return _split_content(msg.content)[1]


def thinking_text(msg: AIMessage) -> str:
    """从 AIMessage 取思考过程文本（无则空串）。"""
    return _split_content(msg.content)[0]
