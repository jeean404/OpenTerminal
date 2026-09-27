# OpenTerminal 流程图

> 状态：与代码同步（分支 feat/single-pipeline，2026-09）
> 配套阅读：[架构文档](architecture.md) · [设计说明](design.md)
> 全部为 mermaid，GitHub / VS Code 直接渲染。

## 1. 启动与连接建立（CLI）

```mermaid
flowchart TD
    A["ot 启动<br/>app.py main()"] --> B{argv}
    B -->|"ot web"| W["FastAPI + uvicorn<br/>（非回环绑定强制 token）"]
    B -->|"ot exec / ot list"| H["headless.py<br/>结构化输出 + 退出码分层"]
    B -->|"ot connect &lt;target&gt;"| D["直进管线"]
    B -->|无参数| C["主菜单（光标选择）<br/>连接主机 / 管理主机 / 退出"]
    C -->|连接主机| C1["连接目标菜单<br/>local · 直接连接（记住的连接）"]
    C -->|管理主机| C2["添加 / 编辑 / 删除<br/>（落 connections.db + keyring）"]
    C1 --> D
    D --> E["CliCore + TermFrontend<br/>两段构造 → frontend.run()"]
    E --> F["open_session(target)<br/>local: LocalPtySession<br/>ssh: SshPtySession"]
    F --> G{SSH?}
    G -->|是| G1["keyring 记住密码先试<br/>→ PermissionDenied 交互询问<br/>→ 指纹未知走 TOFU（§6）"]
    G -->|否| H1["openpty 起本地 shell"]
    G1 --> I
    H1 --> I["会话 start() 成功<br/>_backfill_password 补存凭据"]
    I --> J["系统画像（sysprobe，SSH 才有；<br/>local 用内置画像，hosts.toml 缓存）"]
    J --> J2["能力探测（probe）<br/>识别 shell 族 / su - 换壳"]
    J2 --> M["history.db 近期命令灌回远端<br/>shell 历史（裸 shell 阶段，<br/>须在集成脚本之前）"]
    M --> K["分片注入 shell 集成脚本<br/>OSC 133/6337 hook + 青色回显<br/>（失败静默回退纯直通，AI 不可用）"]
    K --> N["ServerMsg ready + status<br/>「已连接 host [AI 就绪]」"]
    N --> O["启动 PTY 泵 → Ctrl+L 重画提示符<br/>→ 命令集执行（如有，密码行经<br/>cmdset @引用 应答）→ 单管线循环（§2）"]
```

## 2. 输入分类与命令执行（单管线主循环）

```mermaid
flowchart TD
    A["键盘字节<br/>stdin 泵（raw 态）"] --> B{_CaptureLayer<br/>待决态?}
    B -->|"审批/rescue/密码态"| B1["决策键本地消费（§4/§5/§7）<br/>其余字节透传"]
    B -->|普通态| C["core.feed_input<br/>直发 PTY"]
    C --> D["shell 原生处理<br/>（回显/补全/历史 全免费）"]
    D --> E{Enter hook 分类}
    E -->|"! 前缀"| F["剥前缀强制执行命令"]
    E -->|"/ 前缀"| G["OSC 6337 上报<br/>核心 _handle_slash<br/>/target /system /clear /model /exit"]
    E -->|"? 前缀或判定为自然语言"| H["OSC 6337;AI 上报<br/>→ AI 任务（§3）"]
    E -->|命令| I["OSC 133;C 开帧<br/>shell 原生执行"]
    F --> I
    I --> J["PTY 字节 → StreamRouter<br/>记账：history_db / 退出码 / cwd"]
    J --> K["字节原样转发前端<br/>（唯一显示管线，核心不做路由）"]
    K --> L["OSC 133;D;&lt;ec&gt; 收帧"]
    L --> M{ec ≠ 0 且非 130/143?}
    M -->|是| N["救援卡（§5）"]
    M -->|否| O["回到提示符<br/>hook 青色重绘输入回显"]
```

## 3. AI 任务时序（自然语言 → 工具执行 → 总结）

```mermaid
sequenceDiagram
    participant U as 用户
    participant FE as TermFrontend<br/>(CliRenderer)
    participant CORE as PipelineCore
    participant AG as TaskRunner<br/>(agent.py)
    participant PTY as PTY/shell

    U->>PTY: "帮我看看磁盘占用" + Enter
    PTY->>CORE: OSC 6337;AI 上报（hook 判定自然语言）
    CORE->>FE: event task_start
    Note over FE: 状态行点亮（spinner+计时+token）<br/>擦除协议 \r\x1b[K
    CORE->>AG: 起任务（thread_id 上下文）
    loop 流式
        AG->>CORE: think chunk
        CORE->>FE: event ai_think
        Note over FE: 蓝色思考框：行缓冲+显示宽折行<br/>（宽<24 退裸暗灰流）
        AG->>CORE: token chunk
        CORE->>FE: event ai_token
        Note over FE: 关思考框（无摘要行）<br/>正文流式直写（\n→\r\n 防阶梯）
    end
    AG->>CORE: 工具命令（如 df -h）
    CORE->>CORE: Policy 分级
    alt approve（高危）
        CORE->>FE: approval（§4 审批时序）
    else auto
        CORE->>PTY: __ot_exec__ 注入（幕帘闸扣留 live 文本）
        PTY-->>CORE: OSC 6337;EXEC 报告 + 输出字节
        CORE->>FE: 输出字节直写主终端（原样可见）
    end
    CORE->>FE: event ai_collapse（命令面板定格）
    AG->>CORE: final 总结
    CORE->>FE: event final / ai_card
    Note over FE: 关思考框 + 「… 思考 N 行」<br/>总结框（rich Panel）
    CORE->>FE: usage（token 计数）
    Note over FE: 状态行熄灭，无残留
    FE-->>U: 提示符可继续（AI 工作期间用户照样能敲命令）
```

## 4. 审批时序（HIL）

```mermaid
sequenceDiagram
    participant U as 用户
    participant CAP as _CaptureLayer
    participant FE as CliRenderer
    participant CORE as PipelineCore
    participant PTY as PTY/shell

    CORE->>CORE: Policy → approve<br/>_approval_risk → high/normal
    CORE->>FE: ServerMsg approval（命令+理由+主机+风险级）
    Note over FE: 面板：high 红框 / normal 蓝框<br/>提示行 bold yellow<br/>「Enter 执行 · Backspace 拒绝 · e 编辑」
    FE->>CAP: enter_approval(risk)
    Note over CAP: 截获态：决策键不再进 PTY
    alt Enter（执行）
        U->>CAP: \r
        CAP->>CORE: ClientMsg decision approve
        CAP->>FE: 本地合成回执「✓ 已执行」（不等往返）
        CORE->>PTY: __ot_exec__ 注入真执行
    else Backspace（拒绝）
        U->>CAP: \x7f
        CAP->>CORE: decision reject
        CAP->>FE: 回执「✗ 已拒绝」
        CORE->>CORE: 拒绝原因回给模型（任务继续）
    else e（编辑）
        U->>CAP: e
        CAP->>FE: 摘挂 stdin reader<br/>prompt_toolkit 编辑流（预填原命令）
        FE->>CORE: 编辑后命令 → decision approve(edited)
        Note over FE: 编辑完复原 raw 态 + 状态行复活
    else Ctrl+C（待决期钉死）
        U->>CAP: \x03
        CAP->>CORE: decision reject
    end
    CAP->>CAP: exit_approval（回普通透传态）
```

## 5. 失败救援流程

```mermaid
flowchart TD
    A["用户命令收帧<br/>OSC 133;D;&lt;ec&gt;"] --> B{"ec ≠ 0<br/>且 ec ∉ {130,143}?"}
    B -->|否| Z["正常回提示符"]
    B -->|是| C["event rescue<br/>红框面板：失败命令 + 退出码 + 输出尾部 12 行"]
    C --> D["_CaptureLayer.enter_rescue<br/>截获 y/n"]
    D -->|y / Y| E["rescue accept=True<br/>回执「✓ 已交给 AI」"]
    E --> F["以失败上下文起 AI 任务<br/>（自然语言优先解读原意 → 修复）"]
    D -->|"n / N / Ctrl+C"| G["rescue accept=False<br/>回执「已忽略」"]
    G --> Z
    F --> Z
```

## 6. SSH 安全与韧性

```mermaid
flowchart TD
    A["SshPtySession.start()"] --> B["asyncssh.connect<br/>keyring 记住密码优先"]
    B --> C{认证结果}
    C -->|PermissionDenied| D["交互询问密码<br/>（本地截获，不回显）<br/>记入 last_password"]
    D --> B2["重试一次"]
    C -->|HostKeyNotVerifiable| E{known_hosts<br/>已有条目?}
    E -->|"有但不符"| F["硬失败：可能重装系统或中间人<br/>绝不静默覆盖"]
    E -->|无| G["TOFU：临时免校验取指纹<br/>询问「信任并写入?」"]
    G -->|y| H["写 known_hosts<br/>复用已建连接"]
    G -->|n| I["拒绝连接"]
    C -->|成功| J["create_process(PTY)<br/>term_size=(cols,rows)"]
    J --> K["运行中…"]
    K -->|通道 EOF / 断线| L["_recover_connection<br/>close → 用 last_password 重连"]
    L --> M{重连成功?<br/>（仅试一次）}
    M -->|是| N["event: 已重连<br/>灌回历史 + 重启命令集；hook 在下次<br/>AI 任务/提交时惰性重注入（_ensure_integrated）"]
    M -->|否| O["ServerMsg closed<br/>前端「会话已结束」→ 回主菜单"]
```

## 7. 认证截获（密码 / 主机密钥）

```mermaid
sequenceDiagram
    participant SSH as SshPtySession
    participant CORE as PipelineCore
    participant FE as 前端（CLI/Web）
    participant U as 用户

    SSH->>CORE: password_prompt 回调（认证需密码）
    CORE->>FE: ask_password（label）
    Note over FE: CLI：截获态输入不回显<br/>Web：浏览器弹窗
    U->>FE: 密码（可勾「记住」）
    FE->>CORE: ClientMsg auth（remember?）
    CORE->>SSH: 回调返回密码
    CORE->>CORE: remember → keyring 存<br/>（与重连 load_password 同键）
    Note over CORE: 连接成功后 last_password<br/>供断线重连与 _backfill_password
```

## 8. Web 多 tab 数据面

```mermaid
sequenceDiagram
    participant B as 浏览器（xterm.js）
    participant S as web/server.py
    participant C as PipelineCore（每 tab 一个）

    B->>S: POST /api/tabs（target）
    S->>C: 建核心 + 会话
    B->>S: WS /ws/{tab_id}
    loop 数据面
        B->>S: 二进制帧（键盘字节）
        S->>C: feed_input
        C->>S: PTY 字节
        S->>B: WS 二进制帧 → term.write
        C->>S: ServerMsg（JSON）
        S->>B: WS 文本帧 → 卡片层<br/>（decoration 锚定：分析卡/总结卡/审批卡）
        B->>S: pad / boundary_settled（占位行账目）
    end
    Note over B,S: 管理面 REST：/api/targets · /api/saved CRUD<br/>非回环绑定强制 x-ot-token
```

## 9. 存储读写总览

```mermaid
flowchart LR
    subgraph 运行时
        CORE[PipelineCore]
        CLI[cli.py 菜单]
        WEB[web/server.py]
        HL[headless.py]
    end
    subgraph "~/.openterminal/"
        CFG[config.toml<br/>模型/策略/手写目标]
        DB1[(connections.db<br/>saved: name/host/port/user/commands)]
        DB2[(history.db WAL<br/>命令历史)]
        TOML[connections.toml.migrated<br/>（旧格式留档）]
    end
    KR[["OS 钥匙串（keyring）<br/>连接密码 · cmdset:名称"]]
    KH[["~/.ssh/known_hosts<br/>主机指纹"]]

    CLI & WEB -->|CRUD| DB1
    CLI & WEB -->|"删除主机时清凭据"| KR
    CORE -->|每命令 append| DB2
    DB2 -->|重连灌回 shell history| CORE
    CORE -->|"load/store/backfill"| KR
    CORE -->|TOFU 写入| KH
    CFG -->|Config.load| CLI & WEB & CORE & HL
    TOML -.->|"首次访问一次性迁移"| DB1
```
