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
