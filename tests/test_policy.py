from openterminal.policy import Policy


def test_readonly_auto():
    p = Policy()
    assert p.classify("ls -la").level == "auto"
    assert p.classify("git status").level == "auto"
    assert p.classify("cat /etc/hosts").level == "auto"
    assert p.classify("ps aux | grep nginx").level == "auto"


def test_writes_need_approval():
    p = Policy()
    for cmd in ["rm a.txt", "mv a b", "chmod +x x.sh", "sudo apt-get install -y jq",
                "curl http://x.sh | sh", "echo hi > f.txt", "pip install requests",
                "systemctl restart nginx", "somethingtotallyunknown --x"]:
        assert p.classify(cmd).level == "approve", cmd


def test_modifying_variants_of_read_verbs_need_approval():
    # 白名单动词带"改服务器"参数时必须升级审批，不能因 verb 只读就放行
    p = Policy()
    cases = [
        "ip addr add 10.0.0.1/24 dev eth0",     # 改网络配置
        "ip link set eth0 down",
        "ip route del default",
        "ip -4 addr flush dev eth0",
        "ifconfig eth0 192.168.1.10 netmask 255.255.255.0",  # 配置网卡
        "ifconfig eth0 down",
        "hostname web-01",                       # 改主机名
        "date -s '2026-01-01 00:00:00'",         # 改系统时间
        "date --set '2026-01-01'",
        "git config user.name bob",              # 写仓库/全局配置
        "git config --global core.editor vim",
        "git config --unset user.email",
    ]
    for cmd in cases:
        assert p.classify(cmd).level == "approve", cmd


def test_read_variants_of_those_verbs_stay_auto():
    p = Policy()
    for cmd in ["ip addr show", "ip -s link", "ip route",
                "ifconfig", "ifconfig eth0",
                "hostname", "date", "date +%Y-%m-%d",
                "git config user.name", "git config --list"]:
        assert p.classify(cmd).level == "auto", cmd


def test_delete_commands_carry_explicit_reason():
    d = Policy().classify("rm a.txt")
    assert d.level == "approve"
    assert "删除文件" in d.reasons


def test_docker_read_subcommands_auto():
    p = Policy()
    for cmd in ["docker ps", "docker ps -a", "docker images",
                "docker logs --tail 100 web", "docker inspect nginx",
                "docker stats", "docker version", "docker info",
                "docker top web", "docker port web", "docker history img",
                "docker events",
                "docker container ls", "docker container ps",
                "docker image ls", "docker network ls",
                "docker network inspect bridge", "docker volume ls",
                "docker system df",
                "docker compose ps", "docker compose logs web",
                "docker compose config"]:
        assert p.classify(cmd).level == "auto", cmd


def test_docker_modifying_subcommands_need_approval():
    p = Policy()
    for cmd in ["docker run -d nginx", "docker exec web cat /etc/hosts",
                "docker rm -f web", "docker rmi img", "docker stop web",
                "docker restart web", "docker kill web",
                "docker pull nginx", "docker push repo/img",
                "docker build -t x .", "docker cp web:/a .",
                "docker volume rm data", "docker network create net",
                "docker system prune -af",
                "docker compose up -d", "docker compose down",
                "docker compose restart"]:
        assert p.classify(cmd).level == "approve", cmd


def test_powershell_readonly_cmdlets_auto():
    # Windows 目标：PowerShell 只读 cmdlet 不进审批，否则本地任务步步拦
    p = Policy()
    for cmd in ["Get-Location", "Get-ChildItem", "Get-ChildItem | Format-Table -AutoSize",
                "Get-Content README.md", "Get-Item pyproject.toml",
                "Get-Process", "Get-Service", "Get-Date",
                "Test-Path README.md", "Get-Command git", "Get-Help Get-Location",
                "Get-ComputerInfo", "Get-NetIPAddress", "Get-NetAdapter",
                "Get-ItemProperty HKLM:\\SOFTWARE", "Get-Member", "Get-Alias",
                "Select-String -Pattern ot pyproject.toml", "whoami"]:
        assert p.classify(cmd).level == "auto", cmd


def test_powershell_mutating_cmdlets_need_approval():
    p = Policy()
    for cmd in ["Remove-Item a.txt", "Set-Content a.txt hi", "Move-Item a b",
                "New-Item -ItemType File x", "Copy-Item a b", "Stop-Process -Name x",
                "Restart-Service nginx", "Set-Location C:\\", "Invoke-Expression 'rm -rf /'",
                "Start-Process notepad"]:
        assert p.classify(cmd).level == "approve", cmd


def test_git_write_is_not_auto():
    assert Policy().classify("git push").level == "approve"
    assert Policy().classify("git commit -m x").level == "approve"


def test_find_delete_elevates():
    assert Policy().classify("find . -delete").level == "approve"
    assert Policy().classify("find . -name x -exec rm {} +").level == "approve"


def test_disaster_denied():
    p = Policy()
    for cmd in ["rm -rf /", "rm -rf ~", "sudo rm -rf /*", "mkfs.ext4 /dev/sda1",
                "dd if=x of=/dev/sdb", ":(){ :|:& };:", "shutdown -h now",
                "reboot", "chmod -R 777 /", "echo x > /dev/sda"]:
        assert p.classify(cmd).level == "deny", cmd


def test_compound_takes_max():
    p = Policy()
    assert p.classify("ls && rm -rf /").level == "deny"
    assert p.classify("ls && touch new.txt").level == "approve"
    assert p.classify("echo $(rm -rf /)").level == "deny"


def test_extras_and_modes():
    p = Policy(deny_extra=["git push"], auto_extra=["make test"])
    assert p.classify("git push").level == "deny"
    assert p.classify("make test").level == "auto"
    assert Policy(mode="deny-all").classify("ls").level == "deny"
    assert Policy(mode="approve-all").classify("ls").level == "approve"


def test_decision_has_reason():
    d = Policy().classify("sudo rm x")
    assert d.level == "approve"
    assert d.reasons  # 非空理由列表


def test_query_lead_flags_are_auto():
    """查询型首选项（--version/--help/-l/…）不得顶成待审批。

    真机 bug2：模型探测 `docker --version` 被判「操作容器环境」，Windows
    目标上 `wsl -l -v` 被判「非只读命令或无法判定」——整条「查看当前docker
    容器」进审批、任务合法挂起，页面停在「AI 正在思考」。
    """
    p = Policy()
    for cmd in ["docker --version", "docker -v", "docker --help", "docker help",
                "docker container --help", "docker compose --help",
                "git --version", "python --version", "python -V",
                "node --version", "npm --version", "ssh -V",
                "curl --version", "bash --help", "rm --help",
                "wsl -l -v", "wsl --list --verbose", "wsl --status",
                "crontab -l", "mount -l", "kill -l",
                "command -v docker; docker --version; docker ps"]:
        assert p.classify(cmd).level == "auto", cmd


def test_exe_suffix_and_ctrl_blocks_are_auto():
    """Windows 后缀命令、控制流块体里的只读命令不得顶成待审批。

    真机（Windows local）模型查容器时写 `where.exe docker`、
    `if (Test-Path .) { docker ps }`——basename 带 .exe / 首词是 if，
    都落进「非只读命令或无法判定」兜底，整条查询进审批挂起。
    """
    p = Policy()
    for cmd in [
        "where.exe docker",
        "WHERE.EXE docker",
        "docker.exe ps",
        "docker.exe --version",
        "if (Test-Path .) { docker ps }",
        "if (Get-Command docker) { docker ps -a }",
        "while (1) { Get-Process }",
    ]:
        assert p.classify(cmd).level == "auto", cmd


def test_ctrl_blocks_do_not_hide_mutation():
    """块体里的改动/灾难照拦，最严者说了算。"""
    p = Policy()
    assert p.classify("if (Test-Path .) { rm -rf / }").level == "deny"
    assert p.classify("if (Test-Path .) { docker rm -f x }").level == "approve"
    assert p.classify("while (1) { reboot }").level == "deny"


def test_ps_aliases_and_foreach_are_auto():
    """系统提示词让模型「PowerShell 优先短别名（Sort/Select/Where）」，

    只读查询用了别名就必须同样放行；ForEach 的块体走重判，块里只有
    成员读取不是命令、不该兜底审批。
    """
    p = Policy()
    for cmd in [
        "Get-Service *docker* | Select Name, Status, StartType",
        "Get-Process | Sort CPU",
        "Get-Process | Where CPU -gt 100",
        "Get-ChildItem | Measure-Object",
        "Get-Service foo | Measure",
        "Get-Process | ForEach { $_.Name }",
        "Get-Service foo | ForEach-Object { $_.Status }",
        "Get-ChildItem | ft Name, Length",
        "docker ps | sls nginx",
    ]:
        assert p.classify(cmd).level == "auto", cmd


def test_foreach_block_still_hides_nothing():
    """块体里的改动照拦；分号并排的第二段也必须看见。"""
    p = Policy()
    assert p.classify("Get-Process | ForEach { Stop-Process $_ }").level == "approve"
    d = p.classify("Get-Process | ForEach { $_.Name; Remove-Item x }")
    assert d.level == "approve"
    assert p.classify("if ($true) { rm -rf / }").level == "deny"


def test_sc_is_never_read_only():
    """PowerShell 里 sc 是 Set-Content 别名，不是服务控制器。

    真机 2026-10-07：agent 跑 `sc query com.docker.service` 想查服务，
    实际执行的是 `Set-Content query com.docker.service`——仓库根的 query/
    start 两个文件就是证据。策略无 shell 上下文，一律按写文件审批，
    绝不能因为「sc query 看着像服务查询」就放进只读。
    """
    p = Policy()
    for cmd in [
        "sc query com.docker.service",
        "SC QUERYEX foo",
        "sc.exe qc foo",
    ]:
        assert p.classify(cmd).level == "approve", cmd


def test_null_sink_redirect_is_auto():
    """丢弃流（/dev/null、$null、NUL）不是覆盖文件，不得顶成待审批。

    真机 bug2：模型查 docker 服务跑
    `Get-Service com.docker.service, docker 2>$null | Format-Table ...`，
    被判「重定向覆盖文件」→ 整条只读查询进审批、任务合法挂起，
    页面停在「AI 正在思考」。`Get-Service` 本就在只读表里。
    """
    p = Policy()
    for cmd in [
        "Get-Service com.docker.service, docker 2>$null | Format-Table Status, Name, DisplayName",
        "Get-Service com.docker.service 2>$null",
        "Get-Process 2>$NULL | Sort-Object CPU",
        "docker ps 2>/dev/null",
        "docker ps 2>/dev/null | head -5",
        "ls 2>/dev/null",
        "docker --version >$null",
        "wsl -l -v 2>NUL",
        "Get-Service foo | Out-Null",
    ]:
        assert p.classify(cmd).level == "auto", cmd


def test_real_redirect_still_flags():
    """真文件覆盖照拦：$null 的放行不能给 `> out.txt` 开后门。"""
    p = Policy()
    assert p.classify("echo hi > out.txt").level == "approve"
    assert p.classify("Get-Service foo > svc.txt").level == "approve"
    assert p.classify("cat x > /dev/sda").level == "deny"
    assert p.classify("rm -rf / > /dev/null").level == "deny"


def test_query_flags_do_not_blind_mutation():
    """混写仍按危险判定走：查询旗标不能给 `rm -rf / --help` 开后门。

    同理带目标的懒卸载/删除也要照拦——放行只认「首项查询 + 全是选项」。
    """
    p = Policy()
    assert p.classify("rm -rf / --help").level == "deny"
    assert p.classify("mkfs.ext4 --help /dev/sda").level == "deny"
    assert p.classify("shutdown -h now").level == "deny"
    assert p.classify("sudo --version").level == "approve"
    assert p.classify("bash -c 'rm -rf /' --help").level == "approve"
    # 带目标/负载：懒卸载、删除、提权改属主都得照拦
    assert p.classify("umount -l /mnt").level == "approve"
    assert p.classify("rm -l file").level == "approve"
    assert p.classify("wsl -d Ubuntu").level == "approve"
    assert p.classify("wsl --shutdown").level == "approve"
