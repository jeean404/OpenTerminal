import pytest


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path / "ot"))
    yield
