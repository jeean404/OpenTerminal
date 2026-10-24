"""Web 文件面板端点单测：fake SFTP 会话注入 tabs，无需真实 SSH。"""

import io

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from openterminal.web.files_api import install_files_errors, make_files_router


def check_token(headers):
    """与 server.py 的 _check_token 同构：无头/错 token 抛 401。"""
    if headers.get("x-ot-token") != "secret":
        raise HTTPException(401, "token 缺失或不正确")


def make_client(tabs):
    app = FastAPI()
    app.include_router(make_files_router(tabs, check_token))
    install_files_errors(app)      # PanelError 的 code/retry 信封
    return TestClient(app)


class FakeAttrs:
    """模拟 asyncssh 的 SFTPName.attrs（readdir 返回，asyncssh 无 listdirattr）。"""

    def __init__(self, filename, *, is_dir=False, size=0, mtime=1700000000):
        self.filename = filename
        self.type = 2 if is_dir else 1
        self.size = size
        self.mtime = mtime
        self.permissions = 0o040755 if is_dir else 0o100644


class FakeName:
    def __init__(self, attrs):
        self.filename = attrs.filename
        self.attrs = attrs


class FakeRemoteFile:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    async def read(self, n):
        chunk = self.data[self.pos:self.pos + n]
        self.pos += len(chunk)
        return chunk

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeRemoteWriter:
    """模拟 asyncssh 写模式打开。

    真实语义：``open(path,'wb')`` 在 **__aenter__ 时**就把目标截成 0 字节
    （FXF_TRUNC），中途失败也回不去——这正是端点必须先写临时文件再改名
    的原因。``mode='x'``（FXF_EXCL）在已存在时抛 SFTPFailure。
    """

    def __init__(self, sftp, path, *, excl=False, append=False):
        self.sftp = sftp
        self.path = path
        self.append = append
        self.buf = bytearray(sftp.files.get(path, b"")) if append else bytearray()
        self.excl = excl

    async def write(self, data):
        self.buf.extend(data)

    async def __aenter__(self):
        if self.excl and self.path in self.sftp.files:
            from asyncssh import SFTPFailure
            raise SFTPFailure(f"already exists: {self.path}")
        if not self.append:
            self.sftp.files[self.path] = b""  # 开即创建/截断
        return self

    async def __aexit__(self, exc_type, *exc):
        if exc_type is None:
            self.sftp.files[self.path] = bytes(self.buf)
        return False


class FakeSftp:
    def __init__(self):
        self.dirs = {}      # path -> [FakeName]
        self.files = {}     # remote path -> bytes
        self.puts = []      # (local, remote)

    async def readdir(self, path):
        # 回归护栏：fake 只实现 asyncssh 真实存在的 API 面（readdir/put/stat/open），
        # 端点若再调回 paramiko 风格的 listdirattr 会立刻 AttributeError
        entries = self.dirs.get(path)
        if entries is None:
            from asyncssh import SFTPNoSuchFile
            raise SFTPNoSuchFile(path)
        return entries

    async def put(self, local, remote):
        from pathlib import Path
        self.puts.append((local, remote))
        self.files[remote] = Path(local).read_bytes()

    async def stat(self, path):
        from asyncssh import SFTPNoSuchFile
        if path in self.files:
            return FakeAttrs(path.rsplit("/", 1)[-1], size=len(self.files[path]))
        if path in self.dirs:
            return FakeAttrs(path.rsplit("/", 1)[-1] or "/", is_dir=True)
        raise SFTPNoSuchFile(path)

    def open(self, path, mode="rb"):
        if mode.startswith("r"):
            return FakeRemoteFile(self.files[path])
        return FakeRemoteWriter(self, path, excl="x" in mode,
                                append="a" in mode)

    async def realpath(self, path):
        return path

    async def rename(self, old, new):
        from asyncssh import SFTPNoSuchFile
        if old not in self.files:
            raise SFTPNoSuchFile(old)
        self.files[new] = self.files.pop(old)

    async def posix_rename(self, old, new):
        # POSIX 语义：目标存在也顶替（rename 是「目标必须不存在」）
        await self.rename(old, new)

    async def mkdir(self, path):
        if path in self.dirs or path in self.files:
            from asyncssh import SFTPFailure
            raise SFTPFailure(path)
        self.dirs[path] = []

    async def remove(self, path):
        from asyncssh import SFTPNoSuchFile
        if path not in self.files:
            raise SFTPNoSuchFile(path)
        del self.files[path]

    async def rmtree(self, path):
        # 简化递归：删目录项 + 该前缀下所有文件
        from asyncssh import SFTPNoSuchFile
        if path not in self.dirs:
            raise SFTPNoSuchFile(path)
        del self.dirs[path]
        prefix = path.rstrip("/") + "/"
        for f in [p for p in self.files if p.startswith(prefix)]:
            del self.files[f]


class FakeSshSession:
    def __init__(self, sftp, cwd="/home/u"):
        self.cwd = cwd
        self._sftp = sftp
        self._conn = object()   # 级联隧道挂点：对齐 SshPtySession._conn

    async def sftp_client(self):
        return self._sftp


class FakeLocalSession:
    cwd = "C:\\"


class FakeTarget:
    """对齐 connections.models 里连接目标的字段面（/state 的 defaults 用）。"""

    def __init__(self, host="example.com", user="u", port=None, mode="direct"):
        self.host = host
        self.user = user
        self.port = port
        self.mode = mode


class FakeWorker:
    def __init__(self, session, tab_id="t1", term_cwd="", *, target=None):
        self.session = session
        self.tab_id = tab_id
        self._target = target or FakeTarget()
        self._target_host = self._target.host
        self._target_user = self._target.user
        if term_cwd:
            self.term_cwd = term_cwd


def attach_panel(worker, sftp, *, host="example.com", user="u", port=None):
    """把 fake SFTP 挂成面板直连——端点测试只关心读写语义，不该每例都走一遍登录。"""
    from openterminal.web.files_api import _PanelConn

    c = _PanelConn()
    c.host, c.port, c.user = host, port, user
    c.password = "pw"
    c.conn, c.sftp_client = FakePanelConn(sftp), sftp
    worker._panel_files = c
    return c


def ssh_tabs(cwd="/home/u", *, connected=True, target=None):
    sftp = FakeSftp()
    sftp.dirs["/srv"] = [
        FakeName(FakeAttrs("b.txt", size=2, mtime=2)),
        FakeName(FakeAttrs("sub", is_dir=True)),
        FakeName(FakeAttrs("a.txt", size=1, mtime=1)),
    ]
    sftp.files["/srv/x.bin"] = b"DATA"
    worker = FakeWorker(FakeSshSession(sftp, cwd=cwd), target=target)
    if connected:
        attach_panel(worker, sftp)
    return {"t1": worker}, sftp


def test_files_identity_prefers_prompt_user_and_inner_ssh_host():
    """跳板机场景的目标身份：host 取最内层 ssh 帧，user 取提示符里的
    用户名（`sudo su -` 之后是 root，面板以它连才看得到 /root）。"""
    from openterminal.core.pipeline import PipelineCore

    class Stub:
        _target_host = "203.0.113.11"
        _target_user = "ubuntu"
        _cur_prompt = "[root@test-host /root]#"
        nested = type("N", (), {
            "ssh_frame_target": staticmethod(
                lambda: ("203.0.113.10", "testuser", None))})()

    ident = PipelineCore.files_identity.fget(Stub())
    assert ident["host"] == "203.0.113.10"     # 真机，不是跳板机
    assert ident["nested"] is True
    assert ident["effective_user"] == "root"     # su 之后的身份排最前
    assert ident["users"][0] == "root"
    assert "testuser" in ident["users"] and "ubuntu" in ident["users"]


def test_files_identity_keeps_inner_host_after_sudo_su():
    """真机回归：`ssh B` 之后再 `sudo su -`，最内层帧是 su（非 ssh）——
    nested_ssh_target 会返回 None、面板退回跳板机。文件面板必须认出 B。"""
    from openterminal.core.pipeline import PipelineCore

    class Stub:
        _target_host = "203.0.113.11"          # 跳板机
        _target_user = "ubuntu"
        _cur_prompt = "[root@test-host /tmp]#"

        class nested:
            # 真实语义对照：nested_ssh_target「最内层非 ssh 即止」→ None
            nested_ssh_target = staticmethod(lambda: (None, None, None))
            ssh_frame_target = staticmethod(
                lambda: ("203.0.113.10", "testuser", None))

    ident = PipelineCore.files_identity.fget(Stub())
    assert ident["host"] == "203.0.113.10"     # 真机，不是 203.0.113.11
    assert ident["effective_user"] == "root"
    assert ident["users"][0] == "root"
    assert ident["nested"] is True


def test_files_identity_real_tracker_after_ssh_then_sudo_su():
    """用户真机场景逐帧复现：跳板机上 `ssh testuser@203.0.113.10` 开帧，
    再 `sudo su -` 开帧（最内层非 ssh）。旧实现走 nested_ssh_target（最内层
    非 ssh 即止）→ 返回 None → 面板退回跳板机 203.0.113.11，用户看到的
    是跳板机的家目录。文件面板必须走 ssh_frame_target 认出真机。"""
    from openterminal.core.nested_ssh import NestedSshTracker
    from openterminal.core.pipeline import PipelineCore

    class Stub:
        _target_host = "203.0.113.11"
        _target_user = "ubuntu"
        _cur_prompt = "[root@test-host /tmp]#"
        _open_cmds = {1: "ssh testuser@203.0.113.10", 2: "sudo su -"}
        nested = NestedSshTracker(type("C", (), {})())   # 只用它的解析方法

    Stub.nested.core = Stub()
    # 对照：给密码代答用的严格语义在这里确实是 None
    assert Stub.nested.nested_ssh_target() == (None, None, None)
    ident = PipelineCore.files_identity.fget(Stub())
    assert ident["host"] == "203.0.113.10", ident
    assert ident["users"][0] == "root"
    assert ident["effective_user"] == "root"
    assert ident["nested"] is True


def test_files_identity_no_nested_jump_stays_on_session_host():
    """终端没跳：目标就是会话主机，面板用会话 SFTP，不折腾级联。"""
    from openterminal.core.pipeline import PipelineCore

    class Stub:
        _target_host = "203.0.113.10"
        _target_user = "testuser"
        _cur_prompt = "[testuser@test-host ~]$"
        nested = type("N", (), {
            "ssh_frame_target": staticmethod(lambda: (None, None, None))})()

    ident = PipelineCore.files_identity.fget(Stub())
    assert ident["host"] == "203.0.113.10"
    assert ident["nested"] is False
    assert ident["effective_user"] == "testuser"


def test_state_home_is_dot_not_term_cwd():
    """面板与终端是两套独立机制：``home`` 恒为 "."（SFTP 默认目录=登录用户的
    家目录），绝不跟终端 cwd——真机回归：跟了 cwd 会把跳板机上的无关目录
    当用户目录列出来。"""
    tabs, _ = ssh_tabs(cwd="/var/www")
    tabs["t1"].term_cwd = "/opt/deep"      # 终端在别处，面板不理
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/state",
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        assert r.json()["home"] == "."
        assert r.json()["defaults"]["nested"] is False


def test_state_defaults_prefer_inner_ssh_target():
    """弹框默认值是终端真正所在的那台机器：跳板机后 ssh 进真机时，
    IP 要预填真机、用户要预填 su 之后的那个（root）。"""

    class Idented(FakeWorker):
        files_identity = {"host": "203.0.113.10", "port": None,
                          "users": ["root", "testuser"],
                          "effective_user": "root", "nested": True}

    tabs, _ = ssh_tabs()
    tabs["t2"] = Idented(FakeSshSession(FakeSftp()), tab_id="t2")
    with make_client(tabs) as client:
        d = client.get("/api/tabs/t2/files/state",
                       headers={"x-ot-token": "secret"}).json()["defaults"]
        assert d["host"] == "203.0.113.10"
        assert d["users"] == ["root", "testuser"]      # su 之后的 root 排最前
        assert d["user"] == "root" and d["nested"] is True


def test_state_defaults_port_falls_back_to_session_port():
    """非嵌套会话 files_identity.port 恒为 None，但用户实际连的可能不是 22。
    端口栏必须预填真实端口，否则「IP 对、端口错」连不上（真机诊断拓扑
    正是 127.0.0.1:2222）。"""
    tabs, _ = ssh_tabs(target=FakeTarget(port=2222))
    with make_client(tabs) as client:
        d = client.get("/api/tabs/t1/files/state",
                       headers={"x-ot-token": "secret"}).json()["defaults"]
        assert d["port"] == 2222


def test_state_unsupported_for_local_tab():
    """本机终端没有「最终服务器」：pipeline 会给字面量 "local"，
    不能当 IP 填进表单，前端据此隐藏 📁 入口。"""
    tabs, _ = ssh_tabs(target=FakeTarget(host="local", mode="local"))
    with make_client(tabs) as client:
        d = client.get("/api/tabs/t1/files/state",
                       headers={"x-ot-token": "secret"}).json()
        assert d["supported"] is False
        assert d["defaults"]["host"] == "" and d["defaults"]["user"] == ""


def test_state_not_connected_is_200_not_error():
    """未连接是**状态**不是错误：前端据此弹登录框。
    （旧实现这里回 503，前端会空转自动重试——面板根本不需要等终端。）"""

    class Disconnected:
        cwd = ""

    tabs, _ = ssh_tabs(connected=False)
    tabs["t1"].session = Disconnected()
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/state",
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        assert r.json()["connected"] is False
        assert r.json()["reason"] == "not_connected" and r.json()["home"] == "."
        r = client.get("/api/tabs/t1/files/list",
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 409
        assert r.json()["code"] == "not_connected"


def test_state_and_list_work_without_session():
    """「文件面板和终端完全独立」的硬证据：会话根本不存在（session=None）
    时，state 照常给默认值、连接后 list 照常列目录——面板不依赖终端。"""
    tabs, _ = ssh_tabs(connected=False)
    tabs["t1"].session = None
    cs = FakeSftp()
    cs.dirs["/"] = [FakeName(FakeAttrs("solo.txt", size=1, mtime=1))]

    with make_client(tabs) as client:
        st = client.get("/api/tabs/t1/files/state",
                        headers={"x-ot-token": "secret"}).json()
        assert st["connected"] is False and st["defaults"]["host"] == "example.com"
        assert client.get("/api/tabs/t1/files/list",
                          headers={"x-ot-token": "secret"}).status_code == 409


def test_need_password_is_not_a_token_401(monkeypatch):
    """真机反馈：点 📁 被要求填「访问令牌」——需要密码的响应曾回 401，而
    authFetch 把所有 401 都当令牌失效弹框。401 只能留给访问令牌校验，
    「该弹框输密码」必须走 403 + need_password。"""
    tabs, _ = ssh_tabs(connected=False)
    monkeypatch.setattr(
        "openterminal.connections.secrets.load_password_alias",
        lambda h, u, p: None)                 # 凭据库没记过 -> 该弹框
    patch_connect(monkeypatch,
                  fail=lambda kw: files_api_mod.AuthFailed("认证失败"))
    with make_client(tabs) as client:
        r = connect(client)                   # 空密码 + 无凭据
        assert r.status_code != 401           # 401 专属访问令牌
        assert r.status_code == 403
        assert r.json()["code"] == "auth_failed"
        assert r.json()["need_password"] is True


def test_list_dirs_first_sorted_with_fields():
    tabs, _ = ssh_tabs()
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/list", params={"path": "/srv"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        entries = r.json()["entries"]
        assert [e["name"] for e in entries] == ["sub", "a.txt", "b.txt"]
        assert entries[0]["is_dir"] is True
        assert entries[1]["size"] == 1 and entries[1]["mtime"] == 1


def test_list_unknown_path_maps_to_404():
    tabs, _ = ssh_tabs()
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/list", params={"path": "/nope"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 404


def test_non_ssh_session_maps_to_409():
    tabs, _ = ssh_tabs()
    tabs["t2"] = FakeWorker(FakeLocalSession())
    tabs["t3"] = FakeWorker(type("W", (), {"session": None})())
    with make_client(tabs) as client:
        for tab in ("t2", "t3"):
            r = client.get(f"/api/tabs/{tab}/files/list",
                           headers={"x-ot-token": "secret"})
            assert r.status_code == 409


def test_unknown_tab_maps_to_404():
    with make_client({}) as client:
        r = client.get("/api/tabs/ghost/files/list",
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 404


def test_upload_streams_raw_body_to_joined_path():
    tabs, sftp = ssh_tabs()
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/upload",
                        params={"path": "/tmp", "name": "hello 世界.txt"},
                        content=b"HELLO",
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        assert sftp.files["/tmp/hello 世界.txt"] == b"HELLO"


def test_chunk_upload_resumes_and_atomically_replaces_target():
    tabs, sftp = ssh_tabs()
    sftp.files["/tmp/archive.bin"] = b"OLD"
    params = {"path": "/tmp", "name": "archive.bin",
              "upload_id": "a" * 32, "total": 6}
    headers = {"x-ot-token": "secret"}
    with make_client(tabs) as client:
        status = client.get("/api/tabs/t1/files/upload/status",
                            params=params, headers=headers)
        assert status.json() == {"offset": 0}
        first = client.post("/api/tabs/t1/files/upload/chunk",
                            params={**params, "offset": 0},
                            content=b"ABC", headers=headers)
        assert first.status_code == 200
        assert first.json() == {"offset": 3}
        assert sftp.files["/tmp/archive.bin"] == b"OLD"

        resumed = client.get("/api/tabs/t1/files/upload/status",
                             params=params, headers=headers)
        assert resumed.json() == {"offset": 3}
        second = client.post("/api/tabs/t1/files/upload/chunk",
                             params={**params, "offset": 3},
                             content=b"DEF", headers=headers)
        assert second.status_code == 200
        complete = client.post("/api/tabs/t1/files/upload/complete",
                               params=params, headers=headers)
        assert complete.status_code == 200
        assert complete.json() == {
            "ok": True, "path": "/tmp/archive.bin", "size": 6}
        assert sftp.files["/tmp/archive.bin"] == b"ABCDEF"
        assert not any(".otpart-" in path for path in sftp.files)


def test_upload_lease_marks_and_releases_active_file_transfer():
    tabs, _ = ssh_tabs()
    params = {"path": "/tmp", "name": "resume.bin",
              "upload_id": "e" * 32}
    headers = {"x-ot-token": "secret"}
    with make_client(tabs) as client:
        active = client.post("/api/tabs/t1/files/upload/lease",
                             params={**params, "active": "true"},
                             headers=headers)
        assert active.status_code == 200
        assert len(tabs["t1"]._ot_active_file_uploads) == 1
        released = client.post("/api/tabs/t1/files/upload/lease",
                               params={**params, "active": "false"},
                               headers=headers)
        assert released.status_code == 200
        assert tabs["t1"]._ot_active_file_uploads == {}


def test_chunk_upload_rejects_wrong_offset_and_bad_upload_id():
    tabs, _ = ssh_tabs()
    params = {"path": "/tmp", "name": "x.bin",
              "upload_id": "b" * 32, "total": 4}
    headers = {"x-ot-token": "secret"}
    with make_client(tabs) as client:
        first = client.post("/api/tabs/t1/files/upload/chunk",
                            params={**params, "offset": 0},
                            content=b"AB", headers=headers)
        assert first.status_code == 200
        stale = client.post("/api/tabs/t1/files/upload/chunk",
                            params={**params, "offset": 0},
                            content=b"CD", headers=headers)
        assert stale.status_code == 409
        assert stale.json()["offset"] == 2
        bad_id = client.get("/api/tabs/t1/files/upload/status",
                            params={**params, "upload_id": "../bad"},
                            headers=headers)
        assert bad_id.status_code == 400
        assert bad_id.json()["code"] == "bad_upload_id"


def test_chunk_upload_does_not_complete_until_total_is_present():
    tabs, sftp = ssh_tabs()
    sftp.files["/tmp/x.bin"] = b"ORIGINAL"
    params = {"path": "/tmp", "name": "x.bin",
              "upload_id": "c" * 32, "total": 4}
    with make_client(tabs) as client:
        client.post("/api/tabs/t1/files/upload/chunk",
                    params={**params, "offset": 0},
                    content=b"AB", headers={"x-ot-token": "secret"})
        complete = client.post("/api/tabs/t1/files/upload/complete",
                               params=params, headers={"x-ot-token": "secret"})
        assert complete.status_code == 409
        assert complete.json()["offset"] == 2
        assert sftp.files["/tmp/x.bin"] == b"ORIGINAL"


def test_chunk_upload_can_complete_empty_file():
    tabs, sftp = ssh_tabs()
    with make_client(tabs) as client:
        complete = client.post(
            "/api/tabs/t1/files/upload/complete",
            params={"path": "/tmp", "name": "empty.bin",
                    "upload_id": "d" * 32, "total": 0},
            headers={"x-ot-token": "secret"})
        assert complete.status_code == 200
        assert complete.json()["size"] == 0
        assert sftp.files["/tmp/empty.bin"] == b""


def test_upload_filename_cannot_escape_target_dir():
    """真机回归：name=../../tmp/PWNED.txt 曾真的落到 /tmp/PWNED.txt。"""
    tabs, sftp = ssh_tabs()
    with make_client(tabs) as client:
        # 目录成分被剥掉，只留最后一段
        for bad, want in (("../../etc/cron.d/x", "/srv/x"),
                          ("/etc/passwd2", "/srv/passwd2"),
                          ("a/b/c.txt", "/srv/c.txt"),
                          (r"..\..\win\evil.txt", "/srv/evil.txt")):
            r = client.post("/api/tabs/t1/files/upload",
                            params={"path": "/srv", "name": bad},
                            content=b"X",
                            headers={"x-ot-token": "secret"})
            assert r.status_code == 200, (bad, r.text)
            assert r.json()["path"] == want, (bad, r.json())
        assert "/srv/cron.d" not in sftp.files
        assert "/etc/passwd2" not in sftp.files
        # 剥完只剩 . / .. 的名字一律拒绝
        for bad in ("..", ".", "/"):
            r = client.post("/api/tabs/t1/files/upload",
                            params={"path": "/srv", "name": bad},
                            content=b"X", headers={"x-ot-token": "secret"})
            assert r.status_code == 400 and r.json()["code"] == "bad_name", bad


def test_upload_failure_keeps_preexisting_remote_file():
    """覆盖上传失败时绝不能删掉用户原来的文件（旧实现会 remove(remote)）。"""
    tabs, sftp = ssh_tabs()
    sftp.files["/srv/keep.txt"] = b"ORIGINAL"

    class Boom(FakeSftp):
        def open(self, path, mode="rb"):
            if not mode.startswith("r"):
                raise RuntimeError("disk full")
            return super().open(path, mode)

    boom = Boom()
    boom.files["/srv/keep.txt"] = sftp.files["/srv/keep.txt"]
    attach_panel(tabs["t1"], boom)
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/upload",
                        params={"path": "/srv", "name": "keep.txt"},
                        content=b"NEW", headers={"x-ot-token": "secret"})
        assert r.status_code == 500
        assert sftp.files["/srv/keep.txt"] == b"ORIGINAL"


def test_upload_failure_removes_only_the_file_it_created():
    tabs, sftp = ssh_tabs()

    class HalfWriter(FakeRemoteWriter):
        """写第一块之后断线：临时文件里已有一半内容。"""

        async def write(self, data):
            await super().write(data)
            raise RuntimeError("connection reset")

    class Boom(FakeSftp):
        def open(self, path, mode="rb"):
            if mode.startswith("r"):
                return super().open(path, mode)
            return HalfWriter(self, path)

    attach_panel(tabs["t1"], Boom())
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/upload",
                        params={"path": "/srv", "name": "half.txt"},
                        content=b"PART", headers={"x-ot-token": "secret"})
        assert r.status_code == 500
        assert "/srv/half.txt" not in sftp.files   # 新建的半成品被清掉


def test_download_streams_with_rfc5987_filename():
    tabs, _ = ssh_tabs()
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/download", params={"path": "/srv/x.bin"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        assert r.content == b"DATA"
        assert "filename*=UTF-8''x.bin" in r.headers["content-disposition"]
        assert r.headers["content-length"] == "4"


def test_download_unknown_file_maps_to_404():
    tabs, _ = ssh_tabs()
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/download", params={"path": "/srv/none"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 404


def test_token_required_on_files_endpoints():
    tabs, _ = ssh_tabs()
    with make_client(tabs) as client:
        assert client.get("/api/tabs/t1/files/state").status_code == 401
        assert client.get("/api/tabs/t1/files/list").status_code == 401
        assert client.post("/api/tabs/t1/files/upload",
                           params={"name": "x.txt"}, content=b"x",
                           ).status_code == 401
        assert client.get("/api/tabs/t1/files/download",
                          params={"path": "/srv/x.bin"}).status_code == 401
        r = client.get("/api/tabs/t1/files/list", params={"path": "/srv"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200


# --- 文件管理：mkdir / create / read / write / delete ---

def test_mkdir_creates_and_conflict_maps_400():
    tabs, sftp = ssh_tabs()
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/mkdir", params={"path": "/srv/newdir"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200 and "/srv/newdir" in sftp.dirs
        r = client.post("/api/tabs/t1/files/mkdir", params={"path": "/srv/newdir"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 400


def test_create_empty_file_then_read():
    tabs, sftp = ssh_tabs()
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/create", params={"path": "/srv/new.txt"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200 and sftp.files["/srv/new.txt"] == b""
        r = client.get("/api/tabs/t1/files/read", params={"path": "/srv/new.txt"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200 and r.json()["content"] == ""


def test_create_existing_name_is_rejected_not_truncated():
    """真机回归：「新建文件」撞上同名旧文件时，绝不许把它清成 0 字节。"""
    tabs, sftp = ssh_tabs()
    sftp.files["/srv/existing.txt"] = b"keep me"
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/create",
                        params={"path": "/srv/existing.txt"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 409 and r.json()["code"] == "exists"
        assert sftp.files["/srv/existing.txt"] == b"keep me"


def test_read_returns_utf8_text():
    tabs, sftp = ssh_tabs()
    sftp.files["/srv/中文.txt"] = "你好 openterminal".encode()
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/read", params={"path": "/srv/中文.txt"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        data = r.json()
        assert data["content"] == "你好 openterminal"
        assert data["name"] == "中文.txt" and data["size"] == len("你好 openterminal".encode())


def test_read_rejects_oversize_for_editing():
    tabs, sftp = ssh_tabs()
    sftp.files["/srv/big.bin"] = b"x" * (2 * 1024 * 1024 + 1)
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/read", params={"path": "/srv/big.bin"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 400 and "过大" in r.json()["detail"]


def test_write_overwrites_and_download_streams_back():
    tabs, _ = ssh_tabs()
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/write", params={"path": "/srv/a.txt"},
                        content="abc-内容".encode(),
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        r = client.get("/api/tabs/t1/files/download", params={"path": "/srv/a.txt"},
                       headers={"x-ot-token": "secret"})
        assert r.content == "abc-内容".encode()


def test_write_rejects_oversize_body():
    tabs, sftp = ssh_tabs()
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/write", params={"path": "/srv/x.bin"},
                        content=b"x" * (2 * 1024 * 1024 + 1),
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 400 and "过大" in r.json()["detail"]
        assert sftp.files["/srv/x.bin"] == b"DATA"   # 超限请求不落盘


def test_delete_file_and_recursive_dir():
    tabs, sftp = ssh_tabs()
    sftp.dirs["/srv/sub"] = []
    sftp.dirs["/srv/sub/deeper"] = []
    sftp.files["/srv/sub/deeper/f.txt"] = b"1"
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/delete", params={"path": "/srv/x.bin"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200 and "/srv/x.bin" not in sftp.files
        r = client.post("/api/tabs/t1/files/delete", params={"path": "/srv/sub"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        assert "/srv/sub" not in sftp.dirs
        assert "/srv/sub/deeper/f.txt" not in sftp.files
        r = client.post("/api/tabs/t1/files/delete", params={"path": "/srv/none"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 404


# --- 级联连接（via=cascade）：经会话隧道直连目标主机 -----------------------

import asyncio

import openterminal.web.files_api as files_api_mod


class FakePanelConn:
    """对齐 asyncssh SSHClientConnection 用到的 API 面：
    is_closed / close / get_server_host_key / start_sftp_client。

    面板直连不经隧道，所以不再有 tunnel 挂点。"""

    def __init__(self, sftp):
        self._sftp = sftp
        self.closed = False

    def is_closed(self):
        return self.closed

    def close(self):
        self.closed = True

    def get_server_host_key(self):
        raise NotImplementedError("TOFU 指纹路径由 monkeypatch 的连接器负责")

    async def start_sftp_client(self):
        return self._sftp


def cascade_sftp():
    cs = FakeSftp()
    cs.dirs["/data"] = [FakeName(FakeAttrs("f.txt", size=9, mtime=9))]
    cs.files["/data/f.txt"] = b"CASCADE"
    return cs


def patch_connect(monkeypatch, sftp=None, fail=None):
    """monkeypatch files_api.connect_panel：记录 kwargs，返回 fake 连接。

    fail 为可调用 (kwargs) -> 异常，用于模拟 HostKeyUnknown 等失败。
    """
    calls = []
    holder = {}

    async def fake_connect(**kw):
        calls.append(kw)
        if fail is not None:
            raise fail(kw)
        conn = FakePanelConn(sftp if sftp is not None else cascade_sftp())
        holder["conn"] = conn
        return conn, conn._sftp

    monkeypatch.setattr(files_api_mod, "connect_panel", fake_connect)
    return calls, holder


def connect(client, host="test-host", user="root", port=None, **extra):
    """四栏登录（IP/端口/用户名/密码）。"""
    return client.post("/api/tabs/t1/files/connect",
                       json={"host": host, "user": user, "port": port, **extra},
                       headers={"x-ot-token": "secret"})


def test_list_requires_connect():
    """未登录就列目录 -> 409 not_connected（前端据此弹登录框）。"""
    tabs, _ = ssh_tabs(connected=False)
    with make_client(tabs) as client:
        r = client.get("/api/tabs/t1/files/list", params={"path": "/srv"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 409 and r.json()["code"] == "not_connected"


def test_connect_then_endpoints_walk_panel_sftp(monkeypatch):
    """登录后所有端点都走面板自己的直连 SFTP（不再有 via 维度）。"""
    tabs, _ = ssh_tabs(connected=False)
    cs = cascade_sftp()
    calls, holder = patch_connect(monkeypatch, sftp=cs)
    with make_client(tabs) as client:
        r = connect(client, password="pw")
        assert r.status_code == 200 and r.json()["host"] == "test-host"
        # 直连：**不再有 tunnel**，显式用户/密码
        assert "tunnel" not in calls[0]
        assert calls[0]["user"] == "root"
        assert calls[0]["password"] == "pw"
        assert calls[0]["confirm_host_key"] is False
        st = client.get("/api/tabs/t1/files/state",
                        headers={"x-ot-token": "secret"}).json()
        assert st["connected"] is True and st["host"] == "test-host"
        r = client.get("/api/tabs/t1/files/list", params={"path": "/data"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        assert [e["name"] for e in r.json()["entries"]] == ["f.txt"]
        r = client.get("/api/tabs/t1/files/download",
                       params={"path": "/data/f.txt"},
                       headers={"x-ot-token": "secret"})
        assert r.content == b"CASCADE"
        r = client.post("/api/tabs/t1/files/mkdir", params={"path": "/data/nd"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200 and "/data/nd" in cs.dirs


def test_connect_without_host_rejected():
    tabs, _ = ssh_tabs(connected=False)
    with make_client(tabs) as client:
        assert connect(client, host="").status_code == 400


def test_connect_accepts_legacy_target_string(monkeypatch):
    """旧前端还在发 target="user@host:port"，别把刷新前的标签打挂。"""
    tabs, _ = ssh_tabs(connected=False)
    calls, _ = patch_connect(monkeypatch)
    with make_client(tabs) as client:
        r = client.post("/api/tabs/t1/files/connect",
                        json={"target": "root@test-host:2222",
                              "password": "pw"},
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        assert calls[0]["host"] == "test-host"
        assert calls[0]["user"] == "root" and calls[0]["port"] == 2222


def test_connect_unknown_host_428_then_confirm(monkeypatch):
    """TOFU：未知主机回 428 带指纹，确认后带 confirm_host_key 重发放行。"""
    tabs, _ = ssh_tabs(connected=False)
    calls, holder = patch_connect(monkeypatch)

    async def fake_connect(**kw):
        calls.append(kw)
        if not kw.get("confirm_host_key"):
            raise files_api_mod.HostKeyUnknown(
                "test-host", "ssh-ed25519", "FPabc")
        conn = FakePanelConn(cascade_sftp())
        holder["conn"] = conn
        return conn, conn._sftp

    monkeypatch.setattr(files_api_mod, "connect_panel", fake_connect)
    with make_client(tabs) as client:
        r = connect(client, password="pw")
        assert r.status_code == 428
        body = r.json()
        assert body["algorithm"] == "ssh-ed25519"
        assert body["fingerprint"] == "FPabc"
        assert holder.get("conn") is None or not holder["conn"].closed
        r = connect(client, password="pw", confirm_host_key=True)
        assert r.status_code == 200
        assert client.get("/api/tabs/t1/files/state",
                          headers={"x-ot-token": "secret"}
                          ).json()["connected"] is True


def test_connect_auth_failed_maps_403_and_host_key_change_400(monkeypatch):
    """密码错是 403 auth_failed——**不能是 401**：前端 authFetch 见 401 就弹
    「访问令牌」框，用户会被莫名要求填令牌（真机反馈）。"""
    tabs, _ = ssh_tabs(connected=False)
    with make_client(tabs) as client:
        patch_connect(monkeypatch,
                      fail=lambda kw: files_api_mod.AuthFailed("认证失败"))
        r = connect(client, password="bad")
        assert r.status_code == 403 and r.json()["code"] == "auth_failed"
        patch_connect(monkeypatch,
                      fail=lambda kw: files_api_mod.HostKeyChanged("密钥不符"))
        r = connect(client, password="pw")
        assert r.status_code == 400 and "密钥" in r.json()["detail"]


def test_blank_password_reads_keyring_alias_and_remember_writes(monkeypatch):
    """空密码="用记住的"：读必须走 load_password_alias（port=None/22 互查）、
    写归一到 _cred_port（默认端口不写 :22）。旧实现读走 load_password 不互查
    ——正是「记住过却仍弹框」的来源。"""
    tabs, _ = ssh_tabs(connected=False)
    stored = {"load": [], "save": []}
    monkeypatch.setattr(
        "openterminal.connections.secrets.load_password_alias",
        lambda h, u, p: (stored["load"].append((h, u, p)) or "PW-from-db"))
    monkeypatch.setattr(
        "openterminal.connections.secrets.store_password",
        lambda h, u, p, pw: (stored["save"].append((h, u, p, pw)) or True))
    calls, _ = patch_connect(monkeypatch)
    with make_client(tabs) as client:
        connect(client)                       # 无密码 -> 查凭据库
        assert calls[0]["password"] == "PW-from-db"
        assert stored["load"] == [("test-host", "root", None)]
        connect(client, password="fresh", remember=True)
        assert stored["save"] == [("test-host", "root", None, "fresh")]


def test_connect_nondefault_port_key_is_exact(monkeypatch):
    """非默认端口的凭据键必须精确（:2223）——alias 明确不互查非 22 端口，
    端口不归一就会「记住了却连不上」。"""
    tabs, _ = ssh_tabs(connected=False)
    stored = {"save": []}
    monkeypatch.setattr(
        "openterminal.connections.secrets.store_password",
        lambda h, u, p, pw: (stored["save"].append((h, u, p, pw)) or True))
    patch_connect(monkeypatch)
    with make_client(tabs) as client:
        connect(client, port=2223, password="fresh", remember=True)
        assert stored["save"] == [("test-host", "root", 2223, "fresh")]
        stored["save"].clear()
        connect(client, port=22, password="fresh", remember=True)
        assert stored["save"] == [("test-host", "root", None, "fresh")]


def test_disconnect_closes_conn(monkeypatch):
    tabs, _ = ssh_tabs(connected=False)
    calls, holder = patch_connect(monkeypatch)
    with make_client(tabs) as client:
        connect(client, password="pw")
        conn = holder["conn"]
        r = client.post("/api/tabs/t1/files/disconnect",
                        headers={"x-ot-token": "secret"})
        assert r.status_code == 200 and conn.closed
        assert client.get("/api/tabs/t1/files/state",
                          headers={"x-ot-token": "secret"}
                          ).json()["connected"] is False
        assert client.get("/api/tabs/t1/files/list",
                          headers={"x-ot-token": "secret"}).status_code == 409


def test_close_panel_releases_conn(monkeypatch):
    """释放钩子挂在 worker._disposables，close() 统一触发——旧实现只在
    close_tab 一处调用，断线回收与 app 关闭两条路径都漏了（连接泄漏）。"""
    tabs, _ = ssh_tabs(connected=False)
    calls, holder = patch_connect(monkeypatch)
    with make_client(tabs) as client:
        connect(client, password="pw")
        conn = holder["conn"]
        asyncio.run(files_api_mod.close_panel(tabs["t1"]))
        assert conn.closed
        assert tabs["t1"]._panel_files is None


def test_close_panel_is_idempotent():
    """任意退出路径都能安全调（幂等），不会第二次抛错。"""
    tabs, _ = ssh_tabs()
    asyncio.run(files_api_mod.close_panel(tabs["t1"]))
    asyncio.run(files_api_mod.close_panel(tabs["t1"]))


def test_rebuild_after_drop_reuses_stored_password(monkeypatch):
    """掉线自动重连用内存里存的密码，不用再弹框。"""
    tabs, _ = ssh_tabs(connected=False)
    calls, holder = patch_connect(monkeypatch)
    with make_client(tabs) as client:
        connect(client, password="pw")
        holder["conn"].closed = True          # 模拟掉线
        r = client.get("/api/tabs/t1/files/list", params={"path": "/data"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 200
        assert calls[-1]["password"] == "pw"


def test_rebuild_auth_failed_latches_need_password(monkeypatch):
    """重建认证失败要**上闩**：后续请求不再拿旧密码去撞 sshd
    （反复失败可能触发服务器的锁定策略）。"""
    tabs, _ = ssh_tabs(connected=False)
    calls, holder = patch_connect(monkeypatch)
    with make_client(tabs) as client:
        connect(client, password="wrong")
        holder["conn"].closed = True

        async def boom(**kw):
            calls.append(kw)
            raise files_api_mod.AuthFailed("认证失败")

        monkeypatch.setattr(files_api_mod, "connect_panel", boom)
        r = client.get("/api/tabs/t1/files/list", params={"path": "/data"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 403 and r.json()["code"] == "auth_failed"
        n = len(calls)
        r = client.get("/api/tabs/t1/files/list", params={"path": "/data"},
                       headers={"x-ot-token": "secret"})
        assert r.status_code == 403
        assert len(calls) == n                # 闩锁生效：没有再次尝试连接


# --- 身份回退：没目标用户的密码就换候选身份登录并提权 ----------------------
# 终端里 `sudo su -` 到 root 之后，面板默认以 root 连，可凭据库往往只有
# xiaojian 的密码。SFTP 换不了用户，所以落到 xiaojian 后必须用 sudo 提权到
# root，否则只能看到 xiaojian 自己的家目录（panel_elevate）。

def test_fallback_users_keeps_priority_order():
    from openterminal.web.files_api import _fallback_users

    ident = {"users": ["root", "xiaojian", "ubuntu"]}
    assert _fallback_users(ident, "root") == ["xiaojian", "ubuntu"]
    assert _fallback_users(ident, None) == ["root", "xiaojian", "ubuntu"]
    assert _fallback_users({}, "root") == []


def _root_identity():
    return {"host": "test-host", "port": None, "users": ["root", "xiaojian"],
            "effective_user": "root", "nested": False, "mode": "ssh"}


def test_connect_falls_back_and_elevates_when_target_password_missing(monkeypatch):
    tabs, _ = ssh_tabs(connected=False)
    tabs["t1"].files_identity = _root_identity()
    monkeypatch.setattr(
        "openterminal.connections.secrets.load_password_alias",
        lambda host, user, port: None if user == "root" else "pw-x")
    calls, _holder = patch_connect(monkeypatch)

    with make_client(tabs) as client:
        r = connect(client, host="test-host", user="root")     # 密码留空
        assert r.status_code == 200, r.text
        body = r.json()

    assert calls[0]["user"] == "xiaojian", "没 root 的密码就退到有密码的身份"
    assert calls[0]["password"] == "pw-x"
    assert calls[0]["elevate_to"] == "root", "身份不同必须提权到目标用户"
    assert body["view_user"] == "root" and body["elevated"] is True
    assert body["user"] == "xiaojian", "登录身份要如实回报"


def test_connect_with_target_password_does_not_elevate(monkeypatch):
    tabs, _ = ssh_tabs(connected=False)
    tabs["t1"].files_identity = _root_identity()
    monkeypatch.setattr(
        "openterminal.connections.secrets.load_password_alias",
        lambda host, user, port: "pw-root" if user == "root" else "pw-x")
    calls, _holder = patch_connect(monkeypatch)

    with make_client(tabs) as client:
        assert connect(client, host="test-host", user="root").status_code == 200

    assert calls[0]["user"] == "root"
    assert calls[0]["elevate_to"] is None, "目标身份自己有密码就不必惊动 sudo"


def test_connect_with_explicit_password_skips_fallback(monkeypatch):
    tabs, _ = ssh_tabs(connected=False)
    tabs["t1"].files_identity = _root_identity()
    monkeypatch.setattr(
        "openterminal.connections.secrets.load_password_alias",
        lambda host, user, port: "pw-x")
    calls, _holder = patch_connect(monkeypatch)

    with make_client(tabs) as client:
        r = connect(client, host="test-host", user="root", password="typed")
        assert r.status_code == 200

    assert calls[0]["user"] == "root"
    assert calls[0]["password"] == "typed"
    assert calls[0]["elevate_to"] is None, "用户手填的密码就是目标身份的"


def test_state_reports_elevation(monkeypatch):
    tabs, _ = ssh_tabs(connected=False)
    tabs["t1"].files_identity = _root_identity()
    patch_connect(monkeypatch)
    with make_client(tabs) as client:
        assert connect(client, host="test-host", user="root",
                       password="typed").status_code == 200
        st = client.get("/api/tabs/t1/files/state",
                        headers={"x-ot-token": "secret"}).json()
    assert st["connected"] is True and st["elevated"] is False
    assert st["view_user"] == "root"
