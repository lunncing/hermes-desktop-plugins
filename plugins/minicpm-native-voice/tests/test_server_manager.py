from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess

import pytest


CONFIG_FIELDS = {
    "executable",
    "model",
    "working_directory",
    "output_directory",
    "log_file",
}


def write_config(tmp_path: Path, **overrides: object) -> tuple[Path, dict[str, object]]:
    executable = tmp_path / "bin" / "llama-omni-server.exe"
    model = tmp_path / "models" / "MiniCPM-o-4_5-Q4_K_M.gguf"
    working_directory = tmp_path / "server-worktree"
    executable.parent.mkdir(exist_ok=True)
    model.parent.mkdir(exist_ok=True)
    working_directory.mkdir(exist_ok=True)
    executable.write_bytes(b"test executable")
    model.write_bytes(b"test model")
    data: dict[str, object] = {
        "executable": str(executable),
        "model": str(model),
        "working_directory": str(working_directory),
        "output_directory": str(tmp_path / "generated" / "audio"),
        "log_file": str(tmp_path / "logs" / "server.log"),
    }
    data.update(overrides)
    path = tmp_path / "server.local.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path, data


def test_server_config_is_strict_resolved_and_creates_outputs_only_after_validation(
    plugin_api, tmp_path
):
    path, data = write_config(tmp_path)

    config = plugin_api.load_server_config(path)

    assert set(config.__dataclass_fields__) == CONFIG_FIELDS
    assert all(getattr(config, field).is_absolute() for field in CONFIG_FIELDS)
    assert config.executable == Path(str(data["executable"])).resolve(strict=False)
    assert config.model == Path(str(data["model"])).resolve(strict=False)
    assert config.output_directory.is_dir()
    assert config.log_file.parent.is_dir()


@pytest.mark.parametrize(
    "mutator",
    [
        lambda data: data.pop("model"),
        lambda data: data.update({"unexpected": "forbidden"}),
        lambda data: data.update({"model": 123}),
        lambda data: data.update({"executable": "relative/server.exe"}),
        lambda data: data.update({"model": "relative/model.gguf"}),
    ],
)
def test_server_config_rejects_missing_extra_wrong_type_and_relative_paths(
    plugin_api, tmp_path, mutator
):
    path, data = write_config(tmp_path)
    mutator(data)
    path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(plugin_api.ServerConfigurationError):
        plugin_api.load_server_config(path)

    assert not (tmp_path / "generated").exists()
    assert not (tmp_path / "logs").exists()


def test_server_config_validates_file_directory_and_basename_contract(plugin_api, tmp_path):
    path, data = write_config(tmp_path)
    Path(str(data["model"])).unlink()
    with pytest.raises(plugin_api.ServerConfigurationError, match="model"):
        plugin_api.load_server_config(path)

    path, data = write_config(tmp_path, model=str(tmp_path / "models" / "model.bin"))
    Path(str(data["model"])).write_bytes(b"wrong suffix")
    with pytest.raises(plugin_api.ServerConfigurationError, match="gguf"):
        plugin_api.load_server_config(path)

    if os.name == "nt":
        wrong_executable = tmp_path / "bin" / "other-server.exe"
        wrong_executable.write_bytes(b"wrong name")
        path, _ = write_config(tmp_path, executable=str(wrong_executable))
        with pytest.raises(plugin_api.ServerConfigurationError, match="llama-omni-server.exe"):
            plugin_api.load_server_config(path)


def test_server_config_wraps_output_creation_failures_as_controlled_errors(plugin_api, tmp_path):
    blocked_parent = tmp_path / "blocked"
    blocked_parent.write_bytes(b"not a directory")
    path, _ = write_config(tmp_path, output_directory=str(blocked_parent / "audio"))

    with pytest.raises(plugin_api.ServerConfigurationError, match="output"):
        plugin_api.load_server_config(path)


def test_server_argv_is_exact_list_with_fixed_loopback_and_no_shell_fields(plugin_api, tmp_path):
    path, _ = write_config(tmp_path)
    config = plugin_api.load_server_config(path)

    argv = plugin_api.build_server_argv(config)

    assert argv == [
        str(config.executable),
        "--host",
        "127.0.0.1",
        "--port",
        "9060",
        "-m",
        str(config.model),
        "-ngl",
        "99",
        "-c",
        "4096",
        "--seed",
        "42",
        "-ctk",
        "q4_0",
        "-ctv",
        "q4_0",
        "-fa",
        "on",
    ]
    assert all("0.0.0.0" not in item for item in argv)


class FakeLog:
    def __init__(self):
        self.close_calls = 0
        self.closed = False

    def close(self):
        self.close_calls += 1
        self.closed = True


class FakeProcess:
    def __init__(self, pid=1234):
        self.pid = pid
        self.returncode = None
        self.terminate_calls = 0
        self.kill_calls = 0

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminate_calls += 1

    def kill(self):
        self.kill_calls += 1


class FakeClock:
    def __init__(self):
        self.value = 0.0

    def monotonic(self):
        return self.value

    async def sleep(self, seconds):
        self.value += seconds
        await asyncio.sleep(0)


def manager_fixture(
    plugin_api,
    tmp_path,
    *,
    health_values=None,
    port_values=None,
    init_error=None,
    waiter=None,
):
    config_path, _ = write_config(tmp_path)
    process = FakeProcess()
    log = FakeLog()
    spawn_calls = []
    init_calls = []
    clock = FakeClock()
    health_values = list(health_values if health_values is not None else [False, True, True])
    port_values = list(port_values if port_values is not None else [False])

    def spawn(argv, **kwargs):
        spawn_calls.append((argv, kwargs))
        return process

    async def health_probe(url, timeout_seconds):
        value = health_values.pop(0) if health_values else True
        if isinstance(value, BaseException):
            raise value
        return value

    async def init_probe(url, payload, timeout_seconds):
        init_calls.append((url, payload, timeout_seconds))
        if init_error is not None:
            raise init_error
        return True

    async def port_probe(host, port, timeout_seconds):
        assert (host, port) == ("127.0.0.1", 9060)
        return port_values.pop(0) if port_values else False

    async def default_waiter(owned_process, timeout_seconds):
        assert owned_process is process
        process.returncode = 0

    manager = plugin_api.LocalOmniServerManager(
        config_path=config_path,
        spawn=spawn,
        health_probe=health_probe,
        port_probe=port_probe,
        init_probe=init_probe,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
        process_waiter=waiter or default_waiter,
        open_log=lambda _path: log,
    )
    return manager, process, log, spawn_calls, init_calls, clock


@pytest.mark.asyncio
async def test_successful_start_spawns_once_waits_for_health_and_initializes_fixed_empty_prompt(
    plugin_api, tmp_path, monkeypatch
):
    monkeypatch.setenv("MINICPM_VOICE_TEST_SENTINEL", "preserved")
    monkeypatch.setenv("OMNI_T2W_FUSED_QKV", "1")
    parent_environment = os.environ.copy()
    manager, process, log, spawn_calls, init_calls, _clock = manager_fixture(plugin_api, tmp_path)

    result = await manager.start()

    assert result == {
        "configured": True,
        "state": "ready",
        "running": True,
        "managed": True,
        "pid": 1234,
        "message": "Managed server is ready.",
    }
    assert len(spawn_calls) == 1
    argv, kwargs = spawn_calls[0]
    config = plugin_api.load_server_config(manager.config_path)
    assert argv == plugin_api.build_server_argv(config)
    assert kwargs["shell"] is False
    assert kwargs["stdin"] == subprocess.DEVNULL
    assert kwargs["stdout"] is log
    assert kwargs["stderr"] is log
    assert kwargs["cwd"] == str(config.working_directory)
    assert "env" in kwargs
    assert kwargs["env"]["MINICPM_VOICE_TEST_SENTINEL"] == "preserved"
    assert kwargs["env"]["OMNI_T2W_FUSED_QKV"] == "0"
    assert os.environ == parent_environment
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        assert kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        assert kwargs["creationflags"] & subprocess.CREATE_NEW_PROCESS_GROUP
    assert init_calls == [
        (
            "http://127.0.0.1:9060/v1/stream/omni_init",
            {
                "media_type": 1,
                "use_tts": True,
                "duplex_mode": False,
                "output_dir": str(config.output_directory),
                "system_prompt": "",
                "token2wav_device": "gpu:0",
            },
            180.0,
        )
    ]
    assert process.poll() is None
    assert log.closed is False


@pytest.mark.asyncio
async def test_concurrent_and_duplicate_starts_serialize_to_one_spawn(plugin_api, tmp_path):
    manager, _process, _log, spawn_calls, init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, health_values=[False, True, True, True]
    )

    first, second = await asyncio.gather(manager.start(), manager.start())
    third = await manager.start()

    assert first["state"] == second["state"] == third["state"] == "ready"
    assert len(spawn_calls) == 1
    assert len(init_calls) == 1


@pytest.mark.asyncio
async def test_status_remains_bounded_and_reports_starting_during_long_initialization(
    plugin_api, tmp_path
):
    manager, _process, _log, _spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path
    )
    health_calls = 0
    health_waiting = asyncio.Event()
    release_health = asyncio.Event()

    async def delayed_health(_url, _timeout_seconds):
        nonlocal health_calls
        health_calls += 1
        if health_calls == 1:
            return False
        health_waiting.set()
        await release_health.wait()
        return True

    manager._health_probe = delayed_health
    starting = asyncio.create_task(manager.start())
    await health_waiting.wait()

    status = await asyncio.wait_for(manager.status(), timeout=0.1)

    assert status["state"] == "starting"
    assert status["running"] is True
    assert status["managed"] is True
    release_health.set()
    assert (await starting)["state"] == "ready"


@pytest.mark.asyncio
async def test_external_server_conflict_is_never_spawned_adopted_or_stopped(plugin_api, tmp_path):
    manager, process, log, spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, health_values=[True, True]
    )

    with pytest.raises(plugin_api.ServerConflictError):
        await manager.start()
    stopped = await manager.stop()

    assert stopped["state"] == "external"
    assert stopped["running"] is True
    assert stopped["managed"] is False
    assert spawn_calls == []
    assert process.terminate_calls == process.kill_calls == 0
    assert log.close_calls == 0


@pytest.mark.asyncio
async def test_occupied_port_without_compatible_health_never_spawns(plugin_api, tmp_path):
    manager, process, log, spawn_calls, init_calls, _clock = manager_fixture(
        plugin_api,
        tmp_path,
        health_values=[False],
        port_values=[True],
    )

    with pytest.raises(plugin_api.ServerConflictError):
        await manager.start()

    assert spawn_calls == []
    assert init_calls == []
    assert process.terminate_calls == process.kill_calls == 0
    assert log.close_calls == 0


@pytest.mark.asyncio
async def test_startup_timeout_cleans_only_owned_process_and_log_once(plugin_api, tmp_path):
    manager, process, log, spawn_calls, init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, health_values=[False] * 200
    )

    with pytest.raises(plugin_api.ServerStartupTimeout):
        await manager.start()

    assert len(spawn_calls) == 1
    assert init_calls == []
    assert process.terminate_calls == 1
    assert process.kill_calls == 0
    assert log.close_calls == 1
    status = await manager.status()
    assert status["state"] == "error"
    assert status["managed"] is False


@pytest.mark.asyncio
async def test_early_exit_cleans_ownership_and_log_without_touching_other_processes(
    plugin_api, tmp_path
):
    manager, process, log, _spawn_calls, init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, health_values=[False, False, False, False]
    )
    original_poll = process.poll
    poll_calls = 0

    def poll():
        nonlocal poll_calls
        poll_calls += 1
        if poll_calls >= 3:
            process.returncode = 7
        return original_poll()

    process.poll = poll

    with pytest.raises(plugin_api.ServerStartError, match="exited"):
        await manager.start()

    assert init_calls == []
    assert process.terminate_calls == process.kill_calls == 0
    assert log.close_calls == 1
    assert (await manager.status())["managed"] is False


@pytest.mark.asyncio
async def test_init_failure_terminates_owned_process_and_closes_log_once(plugin_api, tmp_path):
    manager, process, log, _spawn_calls, init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, init_error=RuntimeError("private upstream detail")
    )

    with pytest.raises(plugin_api.ServerStartError, match="initialization"):
        await manager.start()

    assert len(init_calls) == 1
    assert process.terminate_calls == 1
    assert process.kill_calls == 0
    assert log.close_calls == 1
    public = json.dumps(await manager.status())
    assert "private upstream detail" not in public


@pytest.mark.asyncio
async def test_init_timeout_is_a_gateway_timeout_and_cleans_owned_process(plugin_api, tmp_path):
    manager, process, log, _spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, init_error=asyncio.TimeoutError()
    )

    with pytest.raises(plugin_api.ServerStartupTimeout, match="initialization"):
        await manager.start()

    assert process.terminate_calls == 1
    assert log.close_calls == 1


@pytest.mark.asyncio
async def test_start_cancellation_during_health_wait_cleans_owned_state_and_reraises(
    plugin_api, tmp_path
):
    manager, process, log, _spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path
    )
    health_calls = 0
    health_waiting = asyncio.Event()

    async def blocking_health(_url, _timeout_seconds):
        nonlocal health_calls
        health_calls += 1
        if health_calls == 1:
            return False
        health_waiting.set()
        await asyncio.Future()

    manager._health_probe = blocking_health
    starting = asyncio.create_task(manager.start())
    await health_waiting.wait()

    starting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await starting

    assert process.terminate_calls == 1
    assert process.kill_calls == 0
    assert log.close_calls == 1
    assert manager._process is None
    assert manager._log_handle is None
    assert manager._state == "stopped"


@pytest.mark.asyncio
async def test_start_cancellation_during_initialization_cleans_owned_state_and_reraises(
    plugin_api, tmp_path
):
    manager, process, log, _spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path
    )
    init_waiting = asyncio.Event()

    async def blocking_init(_url, _payload, _timeout_seconds):
        init_waiting.set()
        await asyncio.Future()

    manager._init_probe = blocking_init
    starting = asyncio.create_task(manager.start())
    await init_waiting.wait()

    starting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await starting

    assert process.terminate_calls == 1
    assert process.kill_calls == 0
    assert log.close_calls == 1
    assert manager._process is None
    assert manager._log_handle is None
    assert manager._state == "stopped"


@pytest.mark.asyncio
async def test_status_clears_an_owned_process_that_exits_after_becoming_ready(plugin_api, tmp_path):
    manager, process, log, _spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, health_values=[False, True, False]
    )
    await manager.start()
    process.returncode = 9

    status = await manager.status()

    assert status["state"] == "error"
    assert status["running"] is False
    assert status["managed"] is False
    assert "pid" not in status
    assert log.close_calls == 1


@pytest.mark.asyncio
async def test_stop_is_graceful_and_idempotent(plugin_api, tmp_path):
    manager, process, log, _spawn_calls, _init_calls, _clock = manager_fixture(plugin_api, tmp_path)
    await manager.start()

    first = await manager.stop()
    second = await manager.stop()

    assert first["state"] == second["state"] == "stopped"
    assert first["running"] is second["running"] is False
    assert process.terminate_calls == 1
    assert process.kill_calls == 0
    assert log.close_calls == 1


@pytest.mark.asyncio
async def test_stop_escalates_to_kill_only_after_bounded_wait_timeout(plugin_api, tmp_path):
    wait_calls = 0

    async def waiter(process, timeout_seconds):
        nonlocal wait_calls
        wait_calls += 1
        assert timeout_seconds > 0
        if wait_calls == 1:
            raise asyncio.TimeoutError
        process.returncode = -9

    manager, process, log, _spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, waiter=waiter
    )
    await manager.start()

    result = await manager.stop()

    assert result["state"] == "stopped"
    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert wait_calls == 2
    assert log.close_calls == 1


@pytest.mark.asyncio
async def test_stop_preserves_owned_process_log_and_state_when_second_wait_fails(
    plugin_api, tmp_path
):
    wait_calls = 0

    async def waiter(_process, _timeout_seconds):
        nonlocal wait_calls
        wait_calls += 1
        if wait_calls == 1:
            raise asyncio.TimeoutError
        raise RuntimeError("private waiter detail")

    manager, process, log, _spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, waiter=waiter
    )
    await manager.start()

    with pytest.raises(
        plugin_api.ServerStopError, match=r"Managed server could not be stopped\."
    ):
        await manager.stop()

    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert wait_calls == 2
    assert manager._process is process
    assert manager._log_handle is log
    assert log.close_calls == 0
    assert manager._state == "error"
    assert "private waiter detail" not in manager._message


@pytest.mark.asyncio
async def test_stop_preserves_ownership_when_process_remains_alive_after_kill_and_reap(
    plugin_api, tmp_path
):
    wait_calls = 0

    async def waiter(_process, _timeout_seconds):
        nonlocal wait_calls
        wait_calls += 1
        if wait_calls == 1:
            raise asyncio.TimeoutError

    manager, process, log, _spawn_calls, _init_calls, _clock = manager_fixture(
        plugin_api, tmp_path, waiter=waiter
    )
    await manager.start()

    with pytest.raises(
        plugin_api.ServerStopError, match=r"Managed server could not be stopped\."
    ):
        await manager.stop()

    assert process.poll() is None
    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert wait_calls == 2
    assert manager._process is process
    assert manager._log_handle is log
    assert log.close_calls == 0
    status = await manager.status()
    assert status["running"] is True
    assert status["managed"] is True
    assert status["pid"] == process.pid


@pytest.mark.asyncio
async def test_public_status_is_bounded_and_leaks_no_paths_argv_prompt_environment_or_log(
    plugin_api, tmp_path
):
    manager, _process, _log, _spawn_calls, _init_calls, _clock = manager_fixture(plugin_api, tmp_path)
    public = await manager.start()

    assert set(public) == {"configured", "state", "running", "managed", "pid", "message"}
    assert len(public["message"]) <= 256
    serialized = json.dumps(public).lower()
    for forbidden in (str(tmp_path).lower(), "--host", "system_prompt", "path", "environment", "log"):
        assert forbidden not in serialized
