"""Authenticated Hermes bridge for a loopback MiniCPM-o voice server.

Hermes mounts ``router`` below ``/api/plugins/minicpm-native-voice/``.
"""

from __future__ import annotations

import asyncio
import array
import base64
import contextlib
import json
import math
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid
import wave
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import websockets
from fastapi import (
    APIRouter,
    File,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status as http_status,
)
from pydantic import BaseModel, ConfigDict, StrictInt, field_validator
from starlette.datastructures import UploadFile as StarletteUploadFile


@asynccontextmanager
async def _plugin_lifespan(_app: Any):
    yield
    active_smart_session = globals().get("smart_session")
    if active_smart_session is not None:
        with contextlib.suppress(Exception):
            await active_smart_session.stop()
    active_bridge = globals().get("bridge")
    if active_bridge is not None:
        with contextlib.suppress(Exception):
            await active_bridge.stop()
    active_server_manager = globals().get("server_manager")
    if active_server_manager is not None:
        with contextlib.suppress(Exception):
            await active_server_manager.stop()


router = APIRouter(lifespan=_plugin_lifespan)

UPSTREAM_HOST = "127.0.0.1"
DEFAULT_UPSTREAM_PORT = 9060
UPSTREAM_WS_PATH = "/backend"
ALLOWED_HTTP_PATHS = frozenset({"/health"})
MAX_AUDIO_BYTES = 5_242_880
INPUT_AUDIO_SAMPLE_RATE = 16_000
MAX_SYSTEM_PROMPT_BYTES = 65_536
MAX_SMART_MODEL_PROVIDERS = 64
MAX_SMART_MODELS_PER_PROVIDER = 500
MAX_SMART_PROVIDER_BYTES = 128
MAX_SMART_MODEL_BYTES = 512
MAX_SMART_PROVIDER_LABEL_BYTES = 256
MAX_SMART_TEXT_BYTES = 65_536
SMART_TEXT_DELTA_PREFIX_CHARS = 16
MAX_SMART_HISTORY_PAIRS = 32
MAX_SMART_HISTORY_BYTES = 512 * 1024
MINICPM_INPUT_REJECTED_FRAGMENTS = (
    "<|SOA|>",
    "<|EOA|>",
    "\0",
    "dataset_audio_identifier",
)
MINICPM_UNKNOWN_TOKEN = "<unk>"
MINICPM_LEADING_METADATA_PREFIXES = (
    "Original sentence:",
    "The transcription of the given speech is:",
)
SMART_INPUT_TIMEOUT_SECONDS = 120.0
SMART_GPT_TIMEOUT_SECONDS = 120.0
SMART_TTS_TIMEOUT_SECONDS = 120.0
SMART_TTS_SAMPLE_RATE = 24_000
SMART_TTS_MAX_SECONDS = 75
SMART_TTS_URL = "http://127.0.0.1:9060/v1/audio/speech/minicpm"
SMART_ROUTE_INFO = {
    "source": "minicpm-native-voice",
    "operation": "smart-minicpm",
}
_smart_llm_facade: Any | None = None
NATIVE_AUDIO_CONTENT_TYPE = "application/octet-stream"
EVENT_QUEUE_MAX = 64
EVENT_QUEUE_MAX_BYTES = 12 * 1024 * 1024
TRANSCRIPT_MAX_BYTES = 65_536
TRANSCRIPT_DELTA_MAX_BYTES = 8 * 1024
MAX_AUDIO_DELTA_BYTES = 1024 * 1024
MAX_AUDIO_DELTA_BASE64_BYTES = 4 * ((MAX_AUDIO_DELTA_BYTES + 2) // 3)
MAX_GENERATED_AUDIO_BYTES = 8 * 1024 * 1024
FALLBACK_AUDIO_SAMPLE_RATE = 24_000
SESSION_START_TIMEOUT_SECONDS = 120
TURN_MAX_NEW_TOKENS = 128
TURN_LENGTH_PENALTY = 1.1
PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SERVER_CONFIG_PATH = PLUGIN_ROOT / "server.local.json"
SERVER_CONFIG_FIELDS = frozenset(
    {"executable", "model", "working_directory", "output_directory", "log_file"}
)


class ServerConfigurationError(RuntimeError):
    """Raised when the installed-only local server configuration is unusable."""


@dataclass(frozen=True)
class LocalOmniServerConfig:
    executable: Path
    model: Path
    working_directory: Path
    output_directory: Path
    log_file: Path


def _absolute_config_path(value: Any, field: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ServerConfigurationError(f"{field} must be a non-empty string")
    candidate = Path(value)
    if not candidate.is_absolute():
        raise ServerConfigurationError(f"{field} must be an absolute path")
    return candidate.resolve(strict=False)


def load_server_config(path: Path = SERVER_CONFIG_PATH) -> LocalOmniServerConfig:
    config_path = Path(path)
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ServerConfigurationError("server.local.json is not configured") from exc
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ServerConfigurationError("server.local.json is not valid JSON") from exc
    if not isinstance(raw, dict) or set(raw) != SERVER_CONFIG_FIELDS:
        raise ServerConfigurationError("server.local.json must contain exactly the required fields")

    values = {field: _absolute_config_path(raw[field], field) for field in SERVER_CONFIG_FIELDS}
    config = LocalOmniServerConfig(**values)
    if not config.executable.is_file():
        raise ServerConfigurationError("executable must identify an existing file")
    if os.name == "nt" and config.executable.name != "llama-omni-server.exe":
        raise ServerConfigurationError("executable basename must be llama-omni-server.exe")
    if not config.model.is_file():
        raise ServerConfigurationError("model must identify an existing file")
    if not config.model.name.endswith(".gguf"):
        raise ServerConfigurationError("model basename must end with .gguf")
    if not config.working_directory.is_dir():
        raise ServerConfigurationError("working_directory must identify an existing directory")

    try:
        config.output_directory.mkdir(parents=True, exist_ok=True)
        config.log_file.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ServerConfigurationError("output and log directories could not be created") from exc
    return config


def build_server_argv(config: LocalOmniServerConfig) -> list[str]:
    return [
        str(config.executable),
        "--host",
        UPSTREAM_HOST,
        "--port",
        str(DEFAULT_UPSTREAM_PORT),
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


SERVER_HEALTH_URL = f"http://{UPSTREAM_HOST}:{DEFAULT_UPSTREAM_PORT}/health"
SERVER_INIT_URL = f"http://{UPSTREAM_HOST}:{DEFAULT_UPSTREAM_PORT}/v1/stream/omni_init"
SERVER_STARTUP_TIMEOUT_SECONDS = 30.0
SERVER_INIT_TIMEOUT_SECONDS = 180.0
SERVER_STOP_TIMEOUT_SECONDS = 5.0
SERVER_PROBE_TIMEOUT_SECONDS = 2.0
SERVER_POLL_INTERVAL_SECONDS = 0.25


class ServerConflictError(RuntimeError):
    """Raised when the fixed port belongs to a process this manager does not own."""


class ServerStartError(RuntimeError):
    """Raised when the owned server cannot be started and initialized safely."""


class ServerStartupTimeout(ServerStartError):
    """Raised when the owned server does not become healthy within the startup bound."""


class ServerStopError(RuntimeError):
    """Raised when an owned server cannot be confirmed stopped within the bound."""


async def _default_server_health_probe(url: str, timeout_seconds: float) -> bool:
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds), trust_env=False
        ) as client:
            response = await client.get(url)
        return 200 <= response.status_code < 300
    except Exception:
        return False


async def _default_server_port_probe(host: str, port: int, timeout_seconds: float) -> bool:
    def connect() -> bool:
        try:
            with socket.create_connection((host, port), timeout=timeout_seconds):
                return True
        except OSError:
            return False

    return await asyncio.to_thread(connect)


async def _default_server_init_probe(
    url: str, payload: dict[str, Any], timeout_seconds: float
) -> bool:
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout_seconds), trust_env=False
    ) as client:
        response = await client.post(url, json=payload)
    response.raise_for_status()
    return True


async def _default_process_waiter(process: Any, timeout_seconds: float) -> None:
    try:
        await asyncio.to_thread(process.wait, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        raise asyncio.TimeoutError from exc


def _open_server_log(path: Path):
    return path.open("ab", buffering=0)


class LocalOmniServerManager:
    """Owns at most one exact loopback MiniCPM-o ``Popen`` instance."""

    def __init__(
        self,
        *,
        config_path: Path = SERVER_CONFIG_PATH,
        spawn: Callable[..., Any] = subprocess.Popen,
        health_probe: Callable[[str, float], Awaitable[bool]] = _default_server_health_probe,
        port_probe: Callable[[str, int, float], Awaitable[bool]] = _default_server_port_probe,
        init_probe: Callable[[str, dict[str, Any], float], Awaitable[bool]] = _default_server_init_probe,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        process_waiter: Callable[[Any, float], Awaitable[None]] = _default_process_waiter,
        open_log: Callable[[Path], Any] = _open_server_log,
    ):
        self.config_path = Path(config_path)
        self._spawn = spawn
        self._health_probe = health_probe
        self._port_probe = port_probe
        self._init_probe = init_probe
        self._monotonic = monotonic
        self._sleep = sleep
        self._process_waiter = process_waiter
        self._open_log = open_log
        self._lock = asyncio.Lock()
        self._process: Any = None
        self._log_handle: Any = None
        self._config: LocalOmniServerConfig | None = None
        self._state = "stopped"
        self._message = "Managed server is stopped."
        self._stopped_owned = False

    def _try_config(self) -> tuple[bool, LocalOmniServerConfig | None]:
        if self._config is not None:
            return True, self._config
        try:
            return True, load_server_config(self.config_path)
        except ServerConfigurationError:
            return False, None

    async def _health(self) -> bool:
        try:
            return bool(
                await self._health_probe(SERVER_HEALTH_URL, SERVER_PROBE_TIMEOUT_SECONDS)
            )
        except Exception:
            return False

    async def _port_occupied(self) -> bool:
        try:
            return bool(
                await self._port_probe(
                    UPSTREAM_HOST, DEFAULT_UPSTREAM_PORT, SERVER_PROBE_TIMEOUT_SECONDS
                )
            )
        except Exception:
            return False

    def _public(
        self,
        *,
        configured: bool,
        state: str,
        running: bool,
        managed: bool,
        message: str,
        process: Any = None,
    ) -> dict[str, Any]:
        public: dict[str, Any] = {
            "configured": bool(configured),
            "state": state,
            "running": bool(running),
            "managed": bool(managed),
            "message": str(message)[:256],
        }
        pid = getattr(process, "pid", None)
        if managed and isinstance(pid, int) and not isinstance(pid, bool):
            public["pid"] = pid
        return public

    def _close_log(self, log_handle: Any) -> None:
        if log_handle is not None:
            with contextlib.suppress(Exception):
                log_handle.close()

    async def _clear_exited_owned_process(self) -> bool:
        process = self._process
        if process is None or process.poll() is None:
            return False
        log_handle = self._log_handle
        self._process = None
        self._log_handle = None
        self._close_log(log_handle)
        self._state = "error"
        self._message = "Managed server exited unexpectedly."
        return True

    async def _status_locked(self, *, probe_unowned: bool = True) -> dict[str, Any]:
        configured, _config = self._try_config()
        await self._clear_exited_owned_process()
        process = self._process
        if process is not None:
            reachable = await self._health()
            if self._state == "starting":
                state = "starting"
                message = "Managed server is starting."
            elif reachable and self._state == "ready":
                state = "ready"
                message = "Managed server is ready."
            else:
                state = "error"
                message = "Managed server is not reachable."
            return self._public(
                configured=configured,
                state=state,
                running=True,
                managed=True,
                message=message,
                process=process,
            )
        if probe_unowned and await self._health():
            self._state = "external"
            self._message = "A compatible external server is reachable."
            return self._public(
                configured=configured,
                state="external",
                running=True,
                managed=False,
                message=self._message,
            )
        if self._state == "error":
            return self._public(
                configured=configured,
                state="error",
                running=False,
                managed=False,
                message=self._message,
            )
        self._state = "stopped"
        self._message = (
            "Managed server is stopped."
            if configured
            else "Local server is not configured."
        )
        return self._public(
            configured=configured,
            state="stopped",
            running=False,
            managed=False,
            message=self._message,
        )

    async def status(self) -> dict[str, Any]:
        if self._lock.locked() and self._state == "starting":
            process = self._process
            if process is not None and process.poll() is None:
                return self._public(
                    configured=self._config is not None,
                    state="starting",
                    running=True,
                    managed=True,
                    message="Managed server is starting.",
                    process=process,
                )
            return self._public(
                configured=self._config is not None,
                state="error",
                running=False,
                managed=False,
                message="Managed server exited during startup.",
            )
        async with self._lock:
            return await self._status_locked()

    async def _cleanup_owned(self) -> None:
        process = self._process
        log_handle = self._log_handle
        if process is None:
            self._close_log(log_handle)
            self._log_handle = None
            return
        cleanup_error: Exception | None = None
        if process.poll() is None:
            try:
                process.terminate()
            except Exception as exc:
                cleanup_error = exc
            if process.poll() is None:
                try:
                    await self._process_waiter(process, SERVER_STOP_TIMEOUT_SECONDS)
                except Exception as exc:
                    cleanup_error = exc
            if process.poll() is None:
                try:
                    process.kill()
                except Exception as exc:
                    cleanup_error = exc
                if process.poll() is None:
                    try:
                        await self._process_waiter(process, SERVER_STOP_TIMEOUT_SECONDS)
                    except Exception as exc:
                        cleanup_error = exc

        if process.poll() is None:
            self._state = "error"
            self._message = "Managed server could not be stopped."
            error = ServerStopError(self._message)
            if cleanup_error is not None:
                raise error from cleanup_error
            raise error

        if self._process is process:
            self._process = None
            self._log_handle = None
        self._close_log(log_handle)

    async def _wait_until_healthy(self) -> None:
        deadline = self._monotonic() + SERVER_STARTUP_TIMEOUT_SECONDS
        while True:
            process = self._process
            if process is None or process.poll() is not None:
                raise ServerStartError("Managed server exited during startup.")
            if await self._health():
                return
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                raise ServerStartupTimeout("Managed server startup timed out.")
            await self._sleep(min(SERVER_POLL_INTERVAL_SECONDS, remaining))

    async def start(self) -> dict[str, Any]:
        async with self._lock:
            try:
                config = load_server_config(self.config_path)
            except ServerConfigurationError:
                self._state = "stopped"
                self._message = "Local server is not configured."
                raise
            self._config = config
            await self._clear_exited_owned_process()
            if self._process is not None:
                if await self._health() and self._state == "ready":
                    return await self._status_locked(probe_unowned=False)
                raise ServerStartError("Managed server is running but not ready.")
            if await self._health():
                self._state = "external"
                self._message = "A compatible external server is reachable."
                self._stopped_owned = False
                raise ServerConflictError("Port 9060 belongs to an unmanaged server.")
            if await self._port_occupied():
                self._state = "error"
                self._message = "Port 9060 is occupied by another process."
                self._stopped_owned = False
                raise ServerConflictError("Port 9060 belongs to an unmanaged process.")

            self._state = "starting"
            self._message = "Managed server is starting."
            self._stopped_owned = False
            log_handle = None
            try:
                log_handle = self._open_log(config.log_file)
                creationflags = 0
                if os.name == "nt":
                    creationflags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                child_env = os.environ.copy()
                child_env["OMNI_T2W_FUSED_QKV"] = "0"
                process = self._spawn(
                    build_server_argv(config),
                    shell=False,
                    env=child_env,
                    stdin=subprocess.DEVNULL,
                    stdout=log_handle,
                    stderr=log_handle,
                    cwd=str(config.working_directory),
                    creationflags=creationflags,
                    close_fds=True,
                )
                self._process = process
                self._log_handle = log_handle
                await self._wait_until_healthy()
                payload = {
                    "media_type": 1,
                    "use_tts": True,
                    "duplex_mode": False,
                    "output_dir": str(config.output_directory),
                    "system_prompt": "",
                    "token2wav_device": "gpu:0",
                }
                try:
                    initialized = await self._init_probe(
                        SERVER_INIT_URL, payload, SERVER_INIT_TIMEOUT_SECONDS
                    )
                except (TimeoutError, httpx.TimeoutException) as exc:
                    raise ServerStartupTimeout(
                        "Managed server initialization timed out."
                    ) from exc
                if not initialized:
                    raise ServerStartError("Managed server initialization failed.")
                if process.poll() is not None:
                    raise ServerStartError("Managed server exited during initialization.")
            except ServerStartupTimeout:
                self._state = "error"
                self._message = "Managed server startup timed out."
                await self._cleanup_owned()
                raise
            except ServerStartError:
                self._state = "error"
                self._message = "Managed server failed to start."
                await self._cleanup_owned()
                raise
            except asyncio.CancelledError:
                self._state = "stopped"
                self._message = "Managed server startup was cancelled."
                self._stopped_owned = True
                await self._cleanup_owned()
                raise
            except Exception as exc:
                if self._process is None:
                    self._close_log(log_handle)
                self._state = "error"
                self._message = "Managed server initialization failed."
                await self._cleanup_owned()
                raise ServerStartError("Managed server initialization failed.") from exc

            self._state = "ready"
            self._message = "Managed server is ready."
            return self._public(
                configured=True,
                state="ready",
                running=True,
                managed=True,
                message=self._message,
                process=process,
            )

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            configured, _config = self._try_config()
            await self._clear_exited_owned_process()
            if self._process is None:
                if self._stopped_owned:
                    return self._public(
                        configured=configured,
                        state="stopped",
                        running=False,
                        managed=False,
                        message="Managed server is stopped.",
                    )
                if self._state == "external" or await self._health():
                    self._state = "external"
                    self._message = "A compatible external server is reachable."
                    return self._public(
                        configured=configured,
                        state="external",
                        running=True,
                        managed=False,
                        message=self._message,
                    )
                self._state = "stopped"
                self._message = "Managed server is stopped."
                return self._public(
                    configured=configured,
                    state="stopped",
                    running=False,
                    managed=False,
                    message=self._message,
                )
            await self._cleanup_owned()
            self._state = "stopped"
            self._message = "Managed server is stopped."
            self._stopped_owned = True
            return self._public(
                configured=configured,
                state="stopped",
                running=False,
                managed=False,
                message=self._message,
            )


class AudioValidationError(ValueError):
    """Raised before encoding when an upload is not bounded Float32 PCM."""


class AudioDeltaValidationError(ValueError):
    """Raised before publication when generated audio is not bounded Float32 PCM."""


class BridgeConflict(RuntimeError):
    """Raised when a second session or turn would violate bridge bounds."""


class BridgeUpstreamError(RuntimeError):
    """Raised when the fixed loopback upstream cannot satisfy an operation."""


class SmartSessionError(RuntimeError):
    """A public-safe Smart session operation failure."""


class SmartSessionConflict(SmartSessionError):
    """A Smart session or turn ownership conflict."""


class SmartStageError(SmartSessionError):
    """A content-free failure from one bounded Smart pipeline stage."""


class SmartModelSelectionUnavailable(ValueError):
    """The requested central provider/model pair cannot be selected."""


def validate_upstream_port(port: int) -> int:
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65_535:
        raise ValueError("upstream port must be an integer in 1..65535")
    return port


def build_upstream_ws_url(port: int = DEFAULT_UPSTREAM_PORT) -> str:
    return f"ws://{UPSTREAM_HOST}:{validate_upstream_port(port)}{UPSTREAM_WS_PATH}"


def build_upstream_http_url(port: int, path: str) -> str:
    if path not in ALLOWED_HTTP_PATHS:
        raise ValueError("upstream HTTP path is not allowed")
    return f"http://{UPSTREAM_HOST}:{validate_upstream_port(port)}{path}"


def build_upstream_close_url(port: int, session_id: str) -> str:
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("session_id must be a non-empty string")
    encoded = quote(session_id, safe="")
    return f"http://{UPSTREAM_HOST}:{validate_upstream_port(port)}/sessions/{encoded}/close"


def validate_system_prompt(system_prompt: str) -> str:
    if not isinstance(system_prompt, str):
        raise TypeError("system_prompt must be a string")
    if len(system_prompt.encode("utf-8")) > MAX_SYSTEM_PROMPT_BYTES:
        raise ValueError("system_prompt exceeds the maximum of 65,536 UTF-8 bytes")
    return system_prompt


def build_session_init(system_prompt: str) -> dict[str, Any]:
    validated_prompt = validate_system_prompt(system_prompt)
    return {
        "type": "session.init",
        "payload": {
            "media_type": 1,
            "mode": "turn_based",
            "use_tts": True,
            "system_prompt": validated_prompt,
        },
    }


def validate_audio_bytes(raw: bytes) -> bytes:
    if len(raw) > MAX_AUDIO_BYTES:
        raise AudioValidationError("audio upload exceeds the 5 MiB limit")
    if not raw or len(raw) % 4:
        raise AudioValidationError("audio must contain a positive whole number of Float32 samples")
    return raw


def build_turn_payload(raw: bytes) -> dict[str, Any]:
    validate_audio_bytes(raw)
    encoded = base64.b64encode(raw).decode("ascii")
    return {
        "type": "input.append",
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "audio", "data": encoded}],
                }
            ],
            "streaming": True,
            "tts": {"enabled": True},
            "use_tts_template": True,
            "generation": {
                "max_new_tokens": TURN_MAX_NEW_TOKENS,
                "length_penalty": TURN_LENGTH_PENALTY,
            },
        },
    }


def validate_minicpm_input_prompt(value: str) -> str:
    validate_system_prompt(value)
    if not value.strip():
        raise ValueError("minicpm_input_prompt must not be blank")
    return value


def load_smart_models_inventory(
    refresh: bool,
    *,
    load_context: Callable[[], Any],
    build_payload: Callable[..., dict[str, Any]],
    build_aux_rows: Callable[..., list[dict[str, Any]]],
) -> dict[str, Any]:
    """Read the host-owned provider inventory without resolving credentials here."""
    context = load_context()
    if refresh:
        return build_payload(
            context,
            for_picker=True,
            refresh=True,
            probe_custom_providers=True,
            probe_current_custom_provider=False,
            max_models=MAX_SMART_MODELS_PER_PROVIDER,
        )
    rows = build_aux_rows(
        current_provider=context.current_provider,
        current_model=context.current_model,
        current_base_url=context.current_base_url,
        max_models=MAX_SMART_MODELS_PER_PROVIDER,
    )
    return {
        "provider": context.current_provider,
        "model": context.current_model,
        "providers": rows,
    }


def _default_smart_models_inventory_loader(refresh: bool) -> dict[str, Any]:
    from hermes_cli.inventory import (
        build_aux_picker_rows,
        build_models_payload,
        load_picker_context,
    )

    return load_smart_models_inventory(
        bool(refresh),
        load_context=load_picker_context,
        build_payload=build_models_payload,
        build_aux_rows=build_aux_picker_rows,
    )


smart_models_inventory_loader: Callable[[bool], dict[str, Any]] = (
    _default_smart_models_inventory_loader
)


def _bounded_smart_model_identity(value: Any, max_bytes: int) -> str:
    if not isinstance(value, str) or not value:
        return ""
    return value if len(value.encode("utf-8")) <= max_bytes else ""


def sanitize_smart_models_catalog(payload: Any) -> dict[str, Any]:
    """Whitelist and bound the only provider data exposed to the Coach."""
    if not isinstance(payload, dict):
        raise ValueError("invalid model inventory")
    current_provider = _bounded_smart_model_identity(
        payload.get("provider"), MAX_SMART_PROVIDER_BYTES
    )
    current_model = _bounded_smart_model_identity(
        payload.get("model"), MAX_SMART_MODEL_BYTES
    )
    raw_rows = payload.get("providers")
    if not isinstance(raw_rows, list):
        raise ValueError("invalid model inventory")

    rows_by_provider: dict[str, dict[str, Any]] = {}
    for raw_row in raw_rows:
        if not isinstance(raw_row, dict):
            continue
        provider = _bounded_smart_model_identity(
            raw_row.get("slug", raw_row.get("provider")),
            MAX_SMART_PROVIDER_BYTES,
        )
        if not provider or provider.casefold() == "moa":
            continue
        explicitly_unavailable = (
            raw_row.get("authenticated") is False
            and raw_row.get("configured") is not True
            and raw_row.get("is_user_defined") is not True
        )
        if explicitly_unavailable and provider != current_provider:
            continue
        label_value = raw_row.get("name", raw_row.get("label", provider))
        label = label_value if isinstance(label_value, str) and label_value else provider
        label = _utf8_prefix(label, MAX_SMART_PROVIDER_LABEL_BYTES)
        models_value = raw_row.get("models")
        models = models_value if isinstance(models_value, (list, tuple)) else []
        sanitized_models = {
            model
            for model in models
            if _bounded_smart_model_identity(model, MAX_SMART_MODEL_BYTES)
        }
        existing = rows_by_provider.get(provider)
        if existing is None:
            rows_by_provider[provider] = {
                "provider": provider,
                "label": label,
                "models": sanitized_models,
            }
        else:
            existing["models"].update(sanitized_models)

    if current_provider and current_provider.casefold() != "moa":
        current_row = rows_by_provider.setdefault(
            current_provider,
            {
                "provider": current_provider,
                "label": current_provider,
                "models": set(),
            },
        )
        if current_model:
            current_row["models"].add(current_model)

    rows = [
        {
            "provider": row["provider"],
            "label": row["label"],
            "models": sorted(row["models"], key=lambda model: (model.casefold(), model))[
                :MAX_SMART_MODELS_PER_PROVIDER
            ],
        }
        for row in rows_by_provider.values()
    ]
    rows.sort(key=lambda row: (row["label"].casefold(), row["provider"]))
    if len(rows) > MAX_SMART_MODEL_PROVIDERS:
        selected = rows[:MAX_SMART_MODEL_PROVIDERS]
        if current_provider and not any(
            row["provider"] == current_provider for row in selected
        ):
            current_row = next(
                row for row in rows if row["provider"] == current_provider
            )
            selected[-1] = current_row
            selected.sort(key=lambda row: (row["label"].casefold(), row["provider"]))
        rows = selected
    return {
        "current": {"provider": current_provider, "model": current_model},
        "providers": rows,
    }


def validate_smart_model_pair_shape(provider: Any, model: Any) -> tuple[str, str]:
    if not isinstance(provider, str) or not isinstance(model, str):
        raise SmartModelSelectionUnavailable("invalid model selection")
    if bool(provider) != bool(model):
        raise SmartModelSelectionUnavailable("incomplete model selection")
    if provider and (
        len(provider.encode("utf-8")) > MAX_SMART_PROVIDER_BYTES
        or len(model.encode("utf-8")) > MAX_SMART_MODEL_BYTES
    ):
        raise SmartModelSelectionUnavailable("invalid model selection")
    return provider, model


async def validate_smart_model_selection(
    provider: str,
    model: str,
    *,
    inventory_loader: Callable[[bool], dict[str, Any]] | None = None,
) -> tuple[str, str]:
    provider, model = validate_smart_model_pair_shape(provider, model)
    if not provider:
        return "", ""
    loader = inventory_loader or smart_models_inventory_loader
    try:
        payload = await asyncio.to_thread(loader, False)
        catalog = sanitize_smart_models_catalog(payload)
    except SmartModelSelectionUnavailable:
        raise
    except Exception as exc:
        raise SmartModelSelectionUnavailable("model inventory unavailable") from exc
    if not any(
        row["provider"] == provider and model in row["models"]
        for row in catalog["providers"]
    ):
        raise SmartModelSelectionUnavailable("model selection unavailable")
    return provider, model


def strip_minicpm_leading_metadata(value: str) -> str:
    text = value.strip()
    while True:
        for prefix in MINICPM_LEADING_METADATA_PREFIXES:
            if text.startswith(prefix):
                text = text[len(prefix) :].lstrip()
                break
        else:
            return text


def sanitize_minicpm_stream_leading_text(value: str) -> tuple[str, bool]:
    text = value.lstrip()
    removed_metadata = False
    while True:
        for prefix in MINICPM_LEADING_METADATA_PREFIXES:
            if text.startswith(prefix):
                text = text[len(prefix) :].lstrip()
                removed_metadata = True
                break
        else:
            holds_partial_prefix = not text or any(
                prefix.startswith(text)
                for prefix in MINICPM_LEADING_METADATA_PREFIXES
            )
            return text if removed_metadata else value, holds_partial_prefix


def validate_minicpm_interpretation(value: Any) -> str:
    if not isinstance(value, str) or any(
        fragment in value for fragment in MINICPM_INPUT_REJECTED_FRAGMENTS
    ):
        raise SmartStageError("input stage failed")
    text = _utf8_prefix(
        strip_minicpm_leading_metadata(
            value.replace(MINICPM_UNKNOWN_TOKEN, "")
        ),
        MAX_SMART_TEXT_BYTES,
    )
    if not text:
        raise SmartStageError("input stage failed")
    return text


def sanitize_minicpm_stream_chunk(tail: str, chunk: str) -> tuple[str, str]:
    sanitized = (tail + chunk).replace(MINICPM_UNKNOWN_TOKEN, "")
    for suffix_length in range(len(MINICPM_UNKNOWN_TOKEN) - 1, 0, -1):
        candidate = MINICPM_UNKNOWN_TOKEN[:suffix_length]
        if sanitized.endswith(candidate):
            return sanitized[:-suffix_length], candidate
    return sanitized, ""


def build_smart_input_payload(raw: bytes, minicpm_input_prompt: str) -> dict[str, Any]:
    validate_audio_bytes(raw)
    prompt = validate_minicpm_input_prompt(minicpm_input_prompt)
    encoded = base64.b64encode(raw).decode("ascii")
    return {
        "type": "input.append",
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "audio", "data": encoded},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "streaming": True,
            "audio_task_mode": "user_prompt_after_audio",
            "tts": {"enabled": False},
            "use_tts_template": False,
            "generation": {
                "max_new_tokens": TURN_MAX_NEW_TOKENS,
                "length_penalty": TURN_LENGTH_PENALTY,
            },
        },
    }


def build_smart_gpt_messages(
    gpt_system_prompt: str,
    history: list[tuple[str, str]],
    current_user_text: str,
) -> list[dict[str, str]]:
    prompt = validate_system_prompt(gpt_system_prompt)
    if not isinstance(current_user_text, str) or not current_user_text:
        raise ValueError("current user text must not be empty")
    messages: list[dict[str, str]] = []
    if prompt:
        messages.append({"role": "system", "content": prompt})
    for user_text, assistant_text in history:
        messages.append({"role": "user", "content": user_text})
        messages.append({"role": "assistant", "content": assistant_text})
    messages.append({"role": "user", "content": current_user_text})
    return messages


def validate_smart_audio_bytes(raw: bytes) -> bytes:
    validate_audio_bytes(raw)
    samples = array.array("f")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    if any(not math.isfinite(sample) or sample < -1.0 or sample > 1.0 for sample in samples):
        raise AudioValidationError("audio samples must be finite and within -1..1")
    return raw


def build_smart_tts_request(assistant_text: str) -> dict[str, Any]:
    if not isinstance(assistant_text, str) or not assistant_text.strip():
        raise SmartStageError("native speech stage failed")
    return {
        "url": SMART_TTS_URL,
        "json": {"input": assistant_text, "response_format": "f32le_json"},
    }


def validate_smart_tts_response(
    payload: Any, assistant_text: str
) -> tuple[str, bytes]:
    try:
        if (
            not isinstance(payload, dict)
            or set(payload) != {"text", "audio", "sample_rate"}
            or payload.get("text") != assistant_text
        ):
            raise ValueError
        if payload.get("sample_rate") != SMART_TTS_SAMPLE_RATE:
            raise ValueError
        encoded = payload.get("audio")
        if not isinstance(encoded, str) or not encoded:
            raise ValueError
        encoded_bytes = encoded.encode("ascii")
        max_bytes = min(
            MAX_GENERATED_AUDIO_BYTES,
            SMART_TTS_SAMPLE_RATE * SMART_TTS_MAX_SECONDS * 4,
        )
        max_encoded = 4 * ((max_bytes + 2) // 3)
        if len(encoded_bytes) > max_encoded:
            raise ValueError
        raw = base64.b64decode(encoded_bytes, validate=True)
        if not raw or len(raw) % 4 or len(raw) > max_bytes:
            raise ValueError
        samples = array.array("f")
        samples.frombytes(raw)
        if sys.byteorder != "little":
            samples.byteswap()
        if any(
            not math.isfinite(sample) or sample < -1.0 or sample > 1.0
            for sample in samples
        ):
            raise ValueError
        return encoded, raw
    except (UnicodeEncodeError, ValueError, base64.binascii.Error) as exc:
        raise SmartStageError("native speech stage failed") from exc


async def _default_smart_llm_caller(
    *, messages: list[dict[str, str]], provider: str = "", model: str = ""
) -> Any:
    global _smart_llm_facade
    if _smart_llm_facade is None:
        from agent.plugin_llm import PluginLlm

        _smart_llm_facade = PluginLlm(plugin_id="minicpm-native-voice")
    kwargs: dict[str, Any] = {
        "timeout": SMART_GPT_TIMEOUT_SECONDS,
        "purpose": "smart-minicpm",
    }
    if provider or model:
        if not provider or not model:
            raise SmartModelSelectionUnavailable("incomplete model selection")
        kwargs.update(provider=provider, model=model)
    return await _smart_llm_facade.acomplete(messages, **kwargs)


async def _default_smart_tts_caller(assistant_text: str) -> Any:
    request = build_smart_tts_request(assistant_text)
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(SMART_TTS_TIMEOUT_SECONDS), trust_env=False
    ) as client:
        response = await client.post(request["url"], json=request["json"])
    response.raise_for_status()
    return response.json()


def _smart_assistant_text(result: Any) -> str:
    def field(value: Any, name: str) -> Any:
        if isinstance(value, dict):
            return value.get(name)
        return getattr(value, name, None)

    text: Any = result if isinstance(result, str) else field(result, "text")
    if not isinstance(text, str):
        text = field(result, "content")
    if not isinstance(text, str):
        choices = field(result, "choices")
        text = None
        if isinstance(choices, list) and choices:
            message = field(choices[0], "message")
            text = field(message, "content")
    if not isinstance(text, str) or not text.strip():
        raise SmartStageError("reasoning stage failed")
    if len(text.encode("utf-8")) > MAX_SMART_TEXT_BYTES:
        raise SmartStageError("reasoning stage failed")
    return text


def serialize_upstream_message(message: dict[str, Any]) -> str:
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"))


def classify_upstream_health(payload: Any) -> str:
    """Map explicit model states; a generic HTTP ``ok`` means shell only."""
    if not isinstance(payload, dict):
        return "shell_ready"
    model_state = payload.get("model_state")
    if model_state in {"loading", "ready", "listening", "thinking", "speaking", "error"}:
        return str(model_state)
    return "shell_ready"


def _utf8_prefix(value: str, max_bytes: int) -> str:
    if max_bytes <= 0:
        return ""
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _transcription_result(result: Any, default_provider: str) -> dict[str, str] | None:
    if not isinstance(result, dict) or not result.get("success"):
        return None
    transcript = result.get("transcript")
    if not isinstance(transcript, str) or not transcript.strip():
        return None
    provider = result.get("provider", default_provider)
    if not isinstance(provider, str) or not provider:
        provider = default_provider
    return {
        "text": _utf8_prefix(transcript.strip(), TRANSCRIPT_MAX_BYTES),
        "provider": _utf8_prefix(provider, 128),
    }


def transcribe_display_audio(
    raw: bytes,
    *,
    configured_transcriber: Callable[[str], Any] | None = None,
    local_transcriber: Callable[[str], Any] | None = None,
    temp_directory: Path | None = None,
) -> dict[str, str] | None:
    """Transcribe bounded native input through Hermes without changing model input."""
    validate_audio_bytes(raw)
    samples = array.array("f")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    pcm16 = array.array("h")
    for sample in samples:
        if not math.isfinite(sample):
            value = 0
        else:
            value = max(-32_768, min(32_767, round(sample * 32_768)))
        pcm16.append(value)
    if sys.byteorder != "little":
        pcm16.byteswap()

    temporary = tempfile.NamedTemporaryFile(
        mode="w+b",
        suffix=".wav",
        prefix="minicpm-display-stt-",
        dir=temp_directory,
        delete=False,
    )
    temporary_path = Path(temporary.name)
    temporary.close()
    try:
        with wave.open(str(temporary_path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(INPUT_AUDIO_SAMPLE_RATE)
            wav_file.writeframes(pcm16.tobytes())

        if configured_transcriber is None:
            try:
                from tools.voice_mode import transcribe_recording

                configured_transcriber = transcribe_recording
            except Exception:
                configured_transcriber = None
        if configured_transcriber is not None:
            try:
                configured_result = configured_transcriber(str(temporary_path))
            except Exception:
                configured_result = None
            if isinstance(configured_result, dict) and configured_result.get("success"):
                return _transcription_result(configured_result, "configured")

        if local_transcriber is None:
            try:
                from tools.transcription_tools import transcribe_audio_local_fallback

                local_transcriber = transcribe_audio_local_fallback
            except Exception:
                local_transcriber = None
        if local_transcriber is not None:
            try:
                return _transcription_result(
                    local_transcriber(str(temporary_path)), "local"
                )
            except Exception:
                return None
        return None
    finally:
        with contextlib.suppress(OSError):
            temporary_path.unlink()


def decode_audio_delta(encoded: Any) -> bytes:
    if not isinstance(encoded, str) or not encoded:
        raise AudioDeltaValidationError("audio delta must be non-empty Base64")
    try:
        encoded_bytes = encoded.encode("ascii")
    except UnicodeEncodeError as exc:
        raise AudioDeltaValidationError("audio delta must be ASCII Base64") from exc
    if len(encoded_bytes) > MAX_AUDIO_DELTA_BASE64_BYTES:
        raise AudioDeltaValidationError("audio delta encoded size exceeds the per-delta budget")
    try:
        raw = base64.b64decode(encoded_bytes, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise AudioDeltaValidationError("audio delta is not valid Base64") from exc
    if not raw or len(raw) % 4:
        raise AudioDeltaValidationError("audio delta must contain aligned Float32 bytes")
    if len(raw) > MAX_AUDIO_DELTA_BYTES:
        raise AudioDeltaValidationError("audio delta exceeds the decoded per-delta budget")
    return raw


def _event_size(event: dict[str, Any]) -> int:
    return len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class ByteBudgetQueue(asyncio.Queue):
    """An asyncio queue that accounts for the serialized bytes it owns."""

    def __init__(self, maxsize: int, max_bytes: int):
        super().__init__(maxsize=maxsize)
        self.max_bytes = max_bytes
        self.queued_bytes = 0
        self.overflowed = False
        self._sizes: deque[int] = deque()
        self._next_size = 0

    def _put(self, item: Any) -> None:
        super()._put(item)
        self._sizes.append(self._next_size)
        self.queued_bytes += self._next_size

    def _get(self) -> Any:
        item = super()._get()
        self.queued_bytes = max(0, self.queued_bytes - self._sizes.popleft())
        return item

    def put_event_nowait(self, event: dict[str, Any], size: int | None = None) -> None:
        self._next_size = _event_size(event) if size is None else size
        try:
            super().put_nowait(event)
        finally:
            self._next_size = 0

    def clear_nowait(self) -> None:
        while not self.empty():
            self.get_nowait()


class EventBroker:
    """Per-subscriber queues bounded by count and serialized payload bytes."""

    def __init__(self, maxsize: int = EVENT_QUEUE_MAX, max_bytes: int = EVENT_QUEUE_MAX_BYTES):
        if maxsize <= 0:
            raise ValueError("event queue maxsize must be positive")
        if max_bytes <= 0:
            raise ValueError("event queue max_bytes must be positive")
        self.maxsize = maxsize
        self.max_bytes = max_bytes
        self._subscribers: set[ByteBudgetQueue] = set()
        self.overflow_count = 0

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def subscribe(self) -> ByteBudgetQueue:
        queue = ByteBudgetQueue(maxsize=self.maxsize, max_bytes=self.max_bytes)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    async def publish(self, event: dict[str, Any]) -> None:
        published = dict(event)
        size = _event_size(published)
        for queue in tuple(self._subscribers):
            if queue.overflowed:
                continue
            if queue.full() or queue.queued_bytes + size > queue.max_bytes:
                queue.clear_nowait()
                overflow = {
                    "type": "error",
                    "code": "subscriber_queue_overflow",
                    "message": "event subscriber queue exceeded its byte or count budget",
                }
                for key in ("session_id", "generation"):
                    if key in published:
                        overflow[key] = published[key]
                overflow_size = _event_size(overflow)
                if overflow_size <= queue.max_bytes:
                    queue.put_event_nowait(overflow, overflow_size)
                queue.overflowed = True
                self.overflow_count += 1
                continue
            queue.put_event_nowait(published, size)


async def _connect_upstream(url: str, **kwargs: Any):
    return await websockets.connect(url, **kwargs)


async def _request_session_close(session_id: str, port: int) -> None:
    timeout = httpx.Timeout(3.0)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        await client.post(build_upstream_close_url(port, session_id))


_DEFAULT_TRANSCRIPTION_RUNNER = object()


class VoiceBridge:
    """Single-session, single-turn bridge with explicit resource ownership."""

    def __init__(
        self,
        *,
        connector: Callable[..., Awaitable[Any]] | None = None,
        close_session_request: Callable[[str, int], Awaitable[None]] | None = None,
        port: int = DEFAULT_UPSTREAM_PORT,
        event_queue_max: int = EVENT_QUEUE_MAX,
        event_queue_max_bytes: int = EVENT_QUEUE_MAX_BYTES,
        transcription_runner: Callable[[bytes], dict[str, str] | None]
        | None
        | object = _DEFAULT_TRANSCRIPTION_RUNNER,
    ):
        self.port = validate_upstream_port(port)
        self.active_port = self.port
        self.connector = connector or _connect_upstream
        self.close_session_request = close_session_request or _request_session_close
        self.events = EventBroker(event_queue_max, event_queue_max_bytes)
        self.transcription_runner = (
            transcribe_display_audio
            if transcription_runner is _DEFAULT_TRANSCRIPTION_RUNNER
            else transcription_runner
        )
        self.state = "shell_ready"
        self.session_id: str | None = None
        self.turn_id: str | None = None
        self.current_text = ""
        self.current_text_bytes = 0
        self.generated_audio_bytes = 0
        self.ws: Any = None
        self.reader_task: asyncio.Task | None = None
        self._start_task: asyncio.Task | None = None
        self._stop_task: asyncio.Task | None = None
        self._connecting_ws: Any = None
        self._lock = asyncio.Lock()
        self._starting = False
        self._stopping = False
        self._generation = 0
        self._seq = 0
        self._transcription_tasks: set[asyncio.Task] = set()

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "session_id": self.session_id,
            "generation": self._generation,
            "turn_id": self.turn_id,
            "metrics": {
                "generated_text_bytes": self.current_text_bytes,
                "generated_audio_bytes": self.generated_audio_bytes,
                "event_queue_overflows": self.events.overflow_count,
                "subscribers": self.events.subscriber_count,
            },
        }

    async def _emit(
        self,
        event_type: str,
        *,
        generation: int,
        session_id: str | None,
        **fields: Any,
    ) -> None:
        self._seq += 1
        await self.events.publish(
            {
                "type": event_type,
                "seq": self._seq,
                "session_id": session_id,
                "generation": generation,
                **fields,
            }
        )

    async def _emit_state(
        self,
        *,
        generation: int,
        session_id: str | None,
        state: str | None = None,
        reason: str | None = None,
    ) -> None:
        fields: dict[str, Any] = {"state": self.state if state is None else state}
        if reason is not None:
            fields["reason"] = reason
        await self._emit("state", generation=generation, session_id=session_id, **fields)

    def _owns_start_locked(self, generation: int, task: asyncio.Task | None) -> bool:
        return (
            self._generation == generation
            and self._starting
            and self._start_task is task
            and not self._stopping
        )

    def _owns_session_locked(self, generation: int, session_id: str, ws: Any) -> bool:
        return (
            self._generation == generation
            and self.session_id == session_id
            and self.ws is ws
            and not self._stopping
        )

    async def start_session(self, system_prompt: str, *, port: int | None = None) -> dict[str, Any]:
        selected_port = self.port if port is None else validate_upstream_port(port)
        init_message = serialize_upstream_message(build_session_init(system_prompt))
        current_task = asyncio.current_task()
        async with self._lock:
            if self._stop_task is not None and not self._stop_task.done():
                raise BridgeConflict("voice session is stopping")
            if self.session_id is not None or self._starting or self.ws is not None:
                raise BridgeConflict("a voice session is already active")
            self._generation += 1
            generation = self._generation
            self._starting = True
            self._start_task = current_task
            self.state = "loading"
            self.current_text = ""
            self.current_text_bytes = 0
            self.generated_audio_bytes = 0
        try:
            await self._emit_state(generation=generation, session_id=None)
        except asyncio.CancelledError:
            async with self._lock:
                if self._generation == generation and self._start_task is current_task:
                    self._starting = False
                    self._start_task = None
            raise
        async with self._lock:
            if not self._owns_start_locked(generation, current_task):
                raise asyncio.CancelledError

        ws = None
        created_session_id: str | None = None
        try:
            ws = await self.connector(
                build_upstream_ws_url(selected_port),
                open_timeout=10,
                close_timeout=2,
                max_size=MAX_GENERATED_AUDIO_BYTES * 2,
                max_queue=8,
                ping_interval=None,
                ping_timeout=None,
            )
            async with self._lock:
                if not self._owns_start_locked(generation, current_task):
                    raise asyncio.CancelledError
                self._connecting_ws = ws
            await ws.send(init_message)
            async with self._lock:
                if not self._owns_start_locked(generation, current_task):
                    raise asyncio.CancelledError
            raw = await asyncio.wait_for(ws.recv(), timeout=SESSION_START_TIMEOUT_SECONDS)
            created = json.loads(raw)
            if created.get("type") != "session.created" or not created.get("session_id"):
                raise BridgeUpstreamError("upstream did not create a session")
            created_session_id = str(created["session_id"])

            async with self._lock:
                if not self._owns_start_locked(generation, current_task):
                    raise asyncio.CancelledError
                self._connecting_ws = None
                self.ws = ws
                self.active_port = selected_port
                self.session_id = created_session_id
                self._starting = False
                self._start_task = None
                self.state = "ready"
                self.reader_task = asyncio.create_task(
                    self._read_upstream(ws, generation, created_session_id),
                    name=f"minicpm-voice-reader-{generation}",
                )
            await self._emit_state(
                generation=generation, session_id=created_session_id, state="ready"
            )
            async with self._lock:
                if not self._owns_session_locked(generation, created_session_id, ws):
                    raise asyncio.CancelledError
                self.state = "listening"
            await self._emit_state(
                generation=generation, session_id=created_session_id, state="listening"
            )
            return self.snapshot()
        except asyncio.CancelledError:
            if created_session_id is not None:
                with contextlib.suppress(Exception):
                    await self.close_session_request(created_session_id, selected_port)
            if ws is not None:
                with contextlib.suppress(Exception):
                    await ws.close()
            async with self._lock:
                if self._generation == generation:
                    if self._connecting_ws is ws:
                        self._connecting_ws = None
                    if self._start_task is current_task:
                        self._starting = False
                        self._start_task = None
            raise
        except Exception as exc:
            if ws is not None:
                with contextlib.suppress(Exception):
                    await ws.close()
            await self._fail(
                exc,
                generation=generation,
                session_id=created_session_id,
                code="session_start_failed",
            )
            if isinstance(exc, BridgeUpstreamError):
                raise
            raise BridgeUpstreamError(str(exc)) from exc

    async def submit_turn(self, raw: bytes) -> dict[str, Any]:
        payload = build_turn_payload(raw)
        duration_seconds = round(len(raw) / 4 / INPUT_AUDIO_SAMPLE_RATE, 3)
        async with self._lock:
            if self.session_id is None or self.ws is None:
                raise BridgeConflict("no active voice session")
            if self.turn_id is not None:
                raise BridgeConflict("a voice turn is already active")
            self.turn_id = uuid.uuid4().hex
            self.current_text = ""
            self.current_text_bytes = 0
            self.generated_audio_bytes = 0
            self.state = "thinking"
            ws = self.ws
            generation = self._generation
            session_id = self.session_id
            turn_id = self.turn_id
        assert session_id is not None
        await self._emit(
            "turn.started",
            generation=generation,
            session_id=session_id,
            turn_id=turn_id,
            duration_seconds=duration_seconds,
        )
        await self._emit_state(generation=generation, session_id=session_id)
        try:
            async with self._lock:
                if (
                    not self._owns_session_locked(generation, session_id, ws)
                    or self.turn_id != turn_id
                ):
                    raise BridgeConflict("voice turn was cancelled")
            await ws.send(serialize_upstream_message(payload))
            async with self._lock:
                if (
                    not self._owns_session_locked(generation, session_id, ws)
                    or self.turn_id != turn_id
                ):
                    raise BridgeConflict("voice turn was cancelled")
            self._schedule_transcription(
                raw,
                generation=generation,
                session_id=session_id,
                turn_id=turn_id,
            )
        except Exception as exc:
            await self._fail(
                exc,
                generation=generation,
                session_id=session_id,
                code="turn_submit_failed",
            )
            if isinstance(exc, BridgeConflict):
                raise
            raise BridgeUpstreamError(str(exc)) from exc
        return self.snapshot()

    def _schedule_transcription(
        self,
        raw: bytes,
        *,
        generation: int,
        session_id: str,
        turn_id: str,
    ) -> None:
        if self.transcription_runner is None:
            return
        task = asyncio.create_task(
            self._run_transcription(
                raw,
                generation=generation,
                session_id=session_id,
                turn_id=turn_id,
            ),
            name=f"minicpm-display-stt-{generation}-{turn_id}",
        )
        self._transcription_tasks.add(task)
        task.add_done_callback(self._transcription_tasks.discard)

    async def _run_transcription(
        self,
        raw: bytes,
        *,
        generation: int,
        session_id: str,
        turn_id: str,
    ) -> None:
        try:
            result = await asyncio.to_thread(self.transcription_runner, raw)
        except asyncio.CancelledError:
            return
        except Exception:
            return
        if not isinstance(result, dict):
            return
        text = result.get("text")
        provider = result.get("provider")
        if not isinstance(text, str):
            return
        text = _utf8_prefix(text.strip(), TRANSCRIPT_MAX_BYTES)
        if not text:
            return
        if not isinstance(provider, str) or not provider:
            provider = "unknown"
        async with self._lock:
            if (
                self._generation != generation
                or self.session_id != session_id
                or self._stopping
            ):
                return
            await self._emit(
                "user.transcript",
                generation=generation,
                session_id=session_id,
                turn_id=turn_id,
                text=text,
                provider=_utf8_prefix(provider, 128),
            )

    async def _read_upstream(self, ws: Any, generation: int, session_id: str) -> None:
        try:
            async for raw in ws:
                event = json.loads(raw)
                await self._handle_upstream_event(
                    event, generation=generation, session_id=session_id, ws=ws
                )
            async with self._lock:
                owns = self._owns_session_locked(generation, session_id, ws)
            if owns:
                await self._fail(
                    BridgeUpstreamError("upstream connection closed"),
                    generation=generation,
                    session_id=session_id,
                    code="upstream_closed",
                )
        except asyncio.CancelledError:
            return
        except Exception as exc:
            await self._fail(
                exc,
                generation=generation,
                session_id=session_id,
                code="upstream_reader_failed",
            )

    @staticmethod
    def _bounded_metrics(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        result: dict[str, Any] = {}
        for key, item in list(value.items())[:32]:
            if isinstance(key, str) and isinstance(item, (int, float, bool)):
                result[key[:64]] = item
        return result

    async def _handle_upstream_event(
        self,
        event: dict[str, Any],
        *,
        generation: int,
        session_id: str,
        ws: Any | None = None,
    ) -> None:
        active_ws = self.ws if ws is None else ws
        async with self._lock:
            if not self._owns_session_locked(generation, session_id, active_ws):
                return
        event_type = event.get("type")
        metrics = self._bounded_metrics(event.get("metrics"))
        if event_type == "response.output.delta" and event.get("kind") == "text":
            text = str(event.get("text", ""))
            async with self._lock:
                if not self._owns_session_locked(generation, session_id, active_ws):
                    return
                turn_id = self.turn_id
                if turn_id is None:
                    return
                remaining = max(0, TRANSCRIPT_MAX_BYTES - self.current_text_bytes)
                forwarded = _utf8_prefix(text, min(remaining, TRANSCRIPT_DELTA_MAX_BYTES))
                self.current_text += forwarded
                self.current_text_bytes += len(forwarded.encode("utf-8"))
            if forwarded:
                await self._emit(
                    "text.delta",
                    generation=generation,
                    session_id=session_id,
                    turn_id=turn_id,
                    text=forwarded,
                    metrics=metrics,
                )
        elif event_type == "response.output.delta" and event.get("kind") == "audio":
            try:
                audio = str(event.get("audio", ""))
                raw_audio = decode_audio_delta(audio)
            except AudioDeltaValidationError as exc:
                await self._fail(
                    exc,
                    generation=generation,
                    session_id=session_id,
                    code="invalid_audio_delta",
                )
                return
            async with self._lock:
                if not self._owns_session_locked(generation, session_id, active_ws):
                    return
                turn_id = self.turn_id
                if turn_id is None:
                    return
                if self.generated_audio_bytes + len(raw_audio) > MAX_GENERATED_AUDIO_BYTES:
                    over_budget = True
                else:
                    over_budget = False
                    self.generated_audio_bytes += len(raw_audio)
                    self.state = "speaking"
            if over_budget:
                await self._fail(
                    AudioDeltaValidationError("generated audio turn exceeded its byte budget"),
                    generation=generation,
                    session_id=session_id,
                    code="audio_turn_budget_exceeded",
                )
                return
            await self._emit_state(
                generation=generation, session_id=session_id, state="speaking"
            )
            async with self._lock:
                if not self._owns_session_locked(generation, session_id, active_ws):
                    return
            sample_rate = event.get("sample_rate")
            if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
                sample_rate = FALLBACK_AUDIO_SAMPLE_RATE
            await self._emit(
                "audio.delta",
                generation=generation,
                session_id=session_id,
                turn_id=turn_id,
                audio=audio,
                sample_rate=sample_rate,
                metrics=metrics,
            )
        elif event_type == "response.done":
            full_text = _utf8_prefix(
                str(event.get("text", self.current_text)), TRANSCRIPT_MAX_BYTES
            )
            async with self._lock:
                if not self._owns_session_locked(generation, session_id, active_ws):
                    return
                turn_id = self.turn_id
                if turn_id is None:
                    return
                self.current_text = full_text
                self.current_text_bytes = len(full_text.encode("utf-8"))
                self.turn_id = None
                self.state = "listening"
            await self._emit(
                "response.done",
                generation=generation,
                session_id=session_id,
                turn_id=turn_id,
                response_id=event.get("response_id"),
                text=full_text,
                metrics=metrics,
            )
            async with self._lock:
                if not self._owns_session_locked(generation, session_id, active_ws):
                    return
            await self._emit_state(
                generation=generation, session_id=session_id, state="listening"
            )
        elif event_type == "session.closed":
            await self._fail(
                BridgeUpstreamError(str(event.get("reason", "upstream session closed"))),
                generation=generation,
                session_id=session_id,
                code="upstream_session_closed",
            )

    async def _fail(
        self,
        exc: BaseException,
        *,
        generation: int,
        session_id: str | None,
        code: str,
    ) -> None:
        current_task = asyncio.current_task()
        async with self._lock:
            if self._generation != generation or self._stopping:
                return
            if session_id is not None and self.session_id not in (session_id, None):
                return
            ws = self.ws or self._connecting_ws
            reader = self.reader_task
            transcription_tasks = list(self._transcription_tasks)
            self._transcription_tasks.clear()
            session_to_close = (
                session_id
                if session_id is not None and self.session_id == session_id
                else None
            )
            active_port = self.active_port
            self.ws = None
            self._connecting_ws = None
            self.reader_task = None
            self.session_id = None
            self.turn_id = None
            self._starting = False
            self._start_task = None
            self.state = "error"
        if reader is not None and reader is not current_task and not reader.done():
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        for task in transcription_tasks:
            if task is not current_task and not task.done():
                task.cancel()
        if transcription_tasks:
            await asyncio.gather(*transcription_tasks, return_exceptions=True)
        if session_to_close is not None:
            with contextlib.suppress(Exception):
                await self.close_session_request(session_to_close, active_port)
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()
        await self._emit(
            "error",
            generation=generation,
            session_id=session_id,
            code=code,
            message=str(exc)[:1024],
        )
        await self._emit_state(
            generation=generation, session_id=session_id, state="error"
        )

    async def stop(self) -> dict[str, Any]:
        current_task = asyncio.current_task()
        async with self._lock:
            if self._stop_task is not None and not self._stop_task.done():
                cleanup_task = self._stop_task
            else:
                had_resources = any(
                    (
                        self.session_id,
                        self.ws,
                        self._connecting_ws,
                        self.reader_task,
                        self._starting,
                        self._transcription_tasks,
                    )
                )
                if not had_resources and self.state == "shell_ready":
                    return self.snapshot()
                self._generation += 1
                stop_generation = self._generation
                self._stopping = True
                session_id = self.session_id
                active_port = self.active_port
                ws = self.ws or self._connecting_ws
                reader = self.reader_task
                starter = self._start_task
                transcription_tasks = list(self._transcription_tasks)
                self._transcription_tasks.clear()
                self.session_id = None
                self.turn_id = None
                self.ws = None
                self._connecting_ws = None
                self.reader_task = None
                self._start_task = None
                self._starting = False
                self.current_text = ""
                self.current_text_bytes = 0
                self.generated_audio_bytes = 0
                self.state = "shell_ready"
                self.active_port = self.port
                cleanup_task = asyncio.create_task(
                    self._finish_stop(
                        session_id=session_id,
                        active_port=active_port,
                        ws=ws,
                        reader=reader,
                        starter=starter,
                        transcription_tasks=transcription_tasks,
                        caller=current_task,
                        generation=stop_generation,
                    ),
                    name=f"minicpm-voice-stop-{stop_generation}",
                )
                self._stop_task = cleanup_task
        await asyncio.shield(cleanup_task)
        return self.snapshot()

    async def _finish_stop(
        self,
        *,
        session_id: str | None,
        active_port: int,
        ws: Any,
        reader: asyncio.Task | None,
        starter: asyncio.Task | None,
        transcription_tasks: list[asyncio.Task],
        caller: asyncio.Task | None,
        generation: int,
    ) -> None:
        tasks = [
            task
            for task in (reader, starter, *transcription_tasks)
            if task is not None and task is not caller and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if session_id is not None:
            with contextlib.suppress(Exception):
                await self.close_session_request(session_id, active_port)
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()
        await self._emit_state(
            generation=generation,
            session_id=None,
            state="shell_ready",
            reason="stopped",
        )
        async with self._lock:
            if self._stop_task is asyncio.current_task():
                self._stopping = False
                self._stop_task = None


class SmartMiniCPMSession:
    """One dependency-injectable, turn-based Smart Coach session."""

    def __init__(
        self,
        *,
        server_manager: Any,
        connector: Callable[..., Awaitable[Any]] | None = None,
        close_session_request: Callable[[str, int], Awaitable[None]] | None = None,
        llm_caller: Callable[..., Awaitable[Any]] | None = None,
        tts_caller: Callable[[str], Awaitable[Any]] | None = None,
        events: EventBroker | None = None,
    ):
        self.server_manager = server_manager
        self.connector = connector or _connect_upstream
        self.close_session_request = close_session_request or _request_session_close
        self.llm_caller = llm_caller
        self.tts_caller = tts_caller
        self.events = events or EventBroker()
        self._lock = asyncio.Lock()
        self._generation = 0
        self._session_id: str | None = None
        self._gpt_system_prompt = ""
        self._minicpm_input_prompt = ""
        self._model_provider = ""
        self._model_name = ""
        self._history: list[tuple[str, str]] = []
        self._active_turn_task: asyncio.Task | None = None
        self._turn_generation = 0
        self._owns_server = False
        self._starting = False
        self._start_task: asyncio.Task | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": "listening" if self._session_id is not None else "stopped",
            "session_id": self._session_id,
            "generation": self._generation,
            "turn_active": bool(
                self._active_turn_task is not None
                and not self._active_turn_task.done()
            ),
        }

    async def start(
        self,
        gpt_system_prompt: str,
        minicpm_input_prompt: str,
        model_provider: str = "",
        model_name: str = "",
    ) -> dict[str, Any]:
        gpt_prompt = validate_system_prompt(gpt_system_prompt)
        input_prompt = validate_minicpm_input_prompt(minicpm_input_prompt)
        frozen_provider, frozen_model = validate_smart_model_pair_shape(
            model_provider, model_name
        )
        current_task = asyncio.current_task()
        async with self._lock:
            if self._session_id is not None or self._starting:
                raise SmartSessionConflict("a Smart session is already active")
            self._generation += 1
            generation = self._generation
            self._starting = True
            self._start_task = current_task
        started_here = False
        try:
            prior = await self.server_manager.status()
            usable = bool(prior.get("running")) and prior.get("state") in {
                "ready",
                "external",
            }
            current = prior
            if not usable:
                current = await self.server_manager.start()
                started_here = bool(current.get("managed"))
            if not bool(current.get("running")) or current.get("state") not in {
                "ready",
                "external",
            }:
                raise SmartSessionError("Smart voice server is unavailable")
            async with self._lock:
                if (
                    self._generation != generation
                    or not self._starting
                    or self._start_task is not current_task
                ):
                    raise asyncio.CancelledError
                self._session_id = uuid.uuid4().hex
                self._gpt_system_prompt = gpt_prompt
                self._minicpm_input_prompt = input_prompt
                self._model_provider = frozen_provider
                self._model_name = frozen_model
                self._history.clear()
                self._turn_generation += 1
                self._owns_server = started_here
                self._starting = False
                self._start_task = None
                return self.snapshot()
        except BaseException:
            async with self._lock:
                if self._start_task is current_task:
                    self._starting = False
                    self._start_task = None
            if started_here:
                with contextlib.suppress(Exception):
                    await self.server_manager.stop()
            raise

    def _owns_turn_locked(
        self,
        generation: int,
        session_id: str,
        turn_generation: int,
        task: asyncio.Task | None,
    ) -> bool:
        return (
            self._generation == generation
            and self._session_id == session_id
            and self._turn_generation == turn_generation
            and self._active_turn_task is task
        )

    async def _require_turn_owner(
        self,
        generation: int,
        session_id: str,
        turn_generation: int,
        task: asyncio.Task | None,
    ) -> None:
        async with self._lock:
            if not self._owns_turn_locked(
                generation, session_id, turn_generation, task
            ):
                raise SmartSessionConflict("Smart turn was interrupted")

    async def _publish_user_text_if_owned(
        self,
        *,
        generation: int,
        session_id: str,
        turn_generation: int,
        turn_id: str,
        text: str,
        task: asyncio.Task | None,
    ) -> None:
        async with self._lock:
            if not self._owns_turn_locked(
                generation, session_id, turn_generation, task
            ):
                raise SmartSessionConflict("Smart turn was interrupted")
            try:
                await self.events.publish(
                    {
                        "type": "smart.user_text",
                        "session_id": session_id,
                        "generation": generation,
                        "turn_id": turn_id,
                        "text": text,
                    }
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                pass

    async def _publish_user_text_delta_if_owned(
        self,
        *,
        generation: int,
        session_id: str,
        turn_generation: int,
        turn_id: str,
        text: str,
        task: asyncio.Task | None,
    ) -> None:
        async with self._lock:
            if not self._owns_turn_locked(
                generation, session_id, turn_generation, task
            ):
                return
            try:
                await self.events.publish(
                    {
                        "type": "smart.user_text.delta",
                        "session_id": session_id,
                        "generation": generation,
                        "turn_id": turn_id,
                        "text": text,
                    }
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                pass

    async def _run_minicpm_input(
        self,
        raw: bytes,
        prompt: str,
        *,
        delta_callback: Callable[[str], Awaitable[None]] | None = None,
    ) -> str:
        ws = None
        upstream_session_id: str | None = None
        accumulated_text = ""
        accumulated_bytes = 0
        prefix_published = False
        rejected_delta = False
        rejected_scan_tail = ""
        unknown_token_tail = ""
        max_rejected_fragment_chars = max(map(len, MINICPM_INPUT_REJECTED_FRAGMENTS))
        try:
            ws = await self.connector(
                build_upstream_ws_url(DEFAULT_UPSTREAM_PORT),
                open_timeout=10,
                close_timeout=2,
                max_size=MAX_GENERATED_AUDIO_BYTES * 2,
                max_queue=8,
                ping_interval=None,
                ping_timeout=None,
            )
            await ws.send(serialize_upstream_message(build_session_init("")))
            raw_created = await asyncio.wait_for(
                ws.recv(), timeout=SESSION_START_TIMEOUT_SECONDS
            )
            created = json.loads(raw_created)
            if created.get("type") != "session.created" or not created.get("session_id"):
                raise SmartStageError("input stage failed")
            upstream_session_id = str(created["session_id"])
            await ws.send(serialize_upstream_message(build_smart_input_payload(raw, prompt)))
            while True:
                raw_event = await asyncio.wait_for(
                    ws.recv(), timeout=SMART_INPUT_TIMEOUT_SECONDS
                )
                event = json.loads(raw_event)
                if (
                    event.get("type") == "response.output.delta"
                    and event.get("kind") == "text"
                ):
                    value = event.get("text")
                    chunk = value if isinstance(value, str) else ""
                    rejected_scan = rejected_scan_tail + chunk
                    if any(
                        fragment in rejected_scan
                        for fragment in MINICPM_INPUT_REJECTED_FRAGMENTS
                    ):
                        rejected_delta = True
                    rejected_scan_tail = rejected_scan[-(max_rejected_fragment_chars - 1) :]

                    sanitized_chunk, unknown_token_tail = sanitize_minicpm_stream_chunk(
                        unknown_token_tail, chunk
                    )

                    remaining = max(0, MAX_SMART_TEXT_BYTES - accumulated_bytes)
                    bounded = _utf8_prefix(
                        sanitized_chunk, min(remaining, TRANSCRIPT_DELTA_MAX_BYTES)
                    )
                    if bounded:
                        accumulated_text += bounded
                        accumulated_bytes += len(bounded.encode("utf-8"))
                    if rejected_delta or delta_callback is None or not bounded:
                        continue
                    if prefix_published:
                        await delta_callback(bounded)
                        continue

                    cleaned_leading, holds_metadata_prefix = (
                        sanitize_minicpm_stream_leading_text(accumulated_text)
                    )
                    rejected_candidate = cleaned_leading.lstrip()
                    could_be_rejected_wrapper = not rejected_candidate or any(
                        fragment.startswith(rejected_candidate)
                        for fragment in MINICPM_INPUT_REJECTED_FRAGMENTS
                    )
                    if (
                        len(accumulated_text) >= SMART_TEXT_DELTA_PREFIX_CHARS
                        and not could_be_rejected_wrapper
                        and not holds_metadata_prefix
                        and cleaned_leading
                    ):
                        await delta_callback(cleaned_leading)
                        prefix_published = True
                    continue
                if (
                    event.get("type") == "response.output.delta"
                    and event.get("kind") == "audio"
                ):
                    raise SmartStageError("input stage failed")
                if event.get("type") == "response.done":
                    if rejected_delta:
                        raise SmartStageError("input stage failed")
                    result = validate_minicpm_interpretation(event.get("text"))
                    if delta_callback is not None and accumulated_text and not prefix_published:
                        cleaned_leading, holds_metadata_prefix = (
                            sanitize_minicpm_stream_leading_text(accumulated_text)
                        )
                        rejected_candidate = cleaned_leading.lstrip()
                        could_be_rejected_wrapper = not rejected_candidate or any(
                            fragment.startswith(rejected_candidate)
                            for fragment in MINICPM_INPUT_REJECTED_FRAGMENTS
                        )
                        if (
                            not could_be_rejected_wrapper
                            and not holds_metadata_prefix
                            and cleaned_leading
                        ):
                            await delta_callback(cleaned_leading)
                    return result
                if event.get("type") == "session.closed":
                    raise SmartStageError("input stage failed")
        except asyncio.CancelledError:
            raise
        except SmartStageError:
            raise
        except Exception as exc:
            raise SmartStageError("input stage failed") from exc
        finally:
            try:
                if ws is not None:
                    with contextlib.suppress(Exception):
                        await ws.close()
            finally:
                if upstream_session_id is not None:
                    with contextlib.suppress(Exception):
                        await self.close_session_request(
                            upstream_session_id, DEFAULT_UPSTREAM_PORT
                        )

    def _trim_history_locked(self) -> None:
        def byte_size() -> int:
            return sum(
                len(user.encode("utf-8")) + len(assistant.encode("utf-8"))
                for user, assistant in self._history
            )

        while (
            len(self._history) > MAX_SMART_HISTORY_PAIRS
            or byte_size() > MAX_SMART_HISTORY_BYTES
        ):
            self._history.pop(0)

    async def turn(self, raw: bytes) -> dict[str, Any]:
        validate_smart_audio_bytes(raw)
        current_task = asyncio.current_task()
        async with self._lock:
            if self._session_id is None:
                raise SmartSessionConflict("no active Smart session")
            if self._active_turn_task is not None and not self._active_turn_task.done():
                raise SmartSessionConflict("a Smart turn is already active")
            self._active_turn_task = current_task
            self._turn_generation += 1
            turn_generation = self._turn_generation
            generation = self._generation
            session_id = self._session_id
            input_prompt = self._minicpm_input_prompt
            gpt_prompt = self._gpt_system_prompt
            model_provider = self._model_provider
            model_name = self._model_name
            history = list(self._history)
            turn_id = uuid.uuid4().hex
        assert session_id is not None
        try:
            try:
                async def publish_delta(text: str) -> None:
                    await self._publish_user_text_delta_if_owned(
                        generation=generation,
                        session_id=session_id,
                        turn_generation=turn_generation,
                        turn_id=turn_id,
                        text=text,
                        task=current_task,
                    )

                user_text = await self._run_minicpm_input(
                    raw, input_prompt, delta_callback=publish_delta
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if isinstance(exc, SmartStageError):
                    raise
                raise SmartStageError("input stage failed") from exc
            await self._require_turn_owner(
                generation, session_id, turn_generation, current_task
            )
            await self._publish_user_text_if_owned(
                generation=generation,
                session_id=session_id,
                turn_generation=turn_generation,
                turn_id=turn_id,
                text=user_text,
                task=current_task,
            )

            messages = build_smart_gpt_messages(gpt_prompt, history, user_text)
            try:
                if self.llm_caller is None:
                    completion = _default_smart_llm_caller(
                        messages=messages,
                        provider=model_provider,
                        model=model_name,
                    )
                else:
                    completion = self.llm_caller(
                        messages=messages, route_info=dict(SMART_ROUTE_INFO)
                    )
                llm_result = await asyncio.wait_for(
                    completion,
                    timeout=SMART_GPT_TIMEOUT_SECONDS,
                )
                assistant_text = _smart_assistant_text(llm_result)
            except asyncio.CancelledError:
                raise
            except SmartStageError:
                raise
            except Exception as exc:
                raise SmartStageError("reasoning stage failed") from exc
            await self._require_turn_owner(
                generation, session_id, turn_generation, current_task
            )

            audio_base64: str | None = None
            sample_rate: int | None = None
            warning: str | None = None
            tts_caller = self.tts_caller or _default_smart_tts_caller
            try:
                tts_payload = await asyncio.wait_for(
                    tts_caller(assistant_text), timeout=SMART_TTS_TIMEOUT_SECONDS
                )
                audio_base64, _raw_audio = validate_smart_tts_response(
                    tts_payload, assistant_text
                )
                sample_rate = SMART_TTS_SAMPLE_RATE
            except asyncio.CancelledError:
                raise
            except Exception:
                warning = "MiniCPM native speech failed."
            await self._require_turn_owner(
                generation, session_id, turn_generation, current_task
            )

            async with self._lock:
                if not self._owns_turn_locked(
                    generation, session_id, turn_generation, current_task
                ):
                    raise SmartSessionConflict("Smart turn was interrupted")
                self._history.append((user_text, assistant_text))
                self._trim_history_locked()
            return {
                "state": "listening",
                "session_id": session_id,
                "generation": generation,
                "turn_id": turn_id,
                "user_text": user_text,
                "assistant_text": assistant_text,
                "audio_base64": audio_base64,
                "sample_rate": sample_rate,
                "warning": warning,
            }
        except asyncio.CancelledError as exc:
            raise SmartSessionConflict("Smart turn was interrupted") from exc
        finally:
            async with self._lock:
                if self._active_turn_task is current_task:
                    self._active_turn_task = None

    async def interrupt(self) -> dict[str, Any]:
        async with self._lock:
            task = self._active_turn_task
            self._active_turn_task = None
            self._turn_generation += 1
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return self.snapshot()

    async def clear_history(self) -> dict[str, Any]:
        async with self._lock:
            if (
                self._active_turn_task is not None
                and not self._active_turn_task.done()
            ):
                raise SmartSessionConflict("a Smart turn is active")
            self._history.clear()
            return self.snapshot()

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            task = self._active_turn_task
            self._active_turn_task = None
            start_task = self._start_task
            self._start_task = None
            self._starting = False
            self._turn_generation += 1
            owned_server = self._owns_server
            self._owns_server = False
            self._generation += 1
            self._session_id = None
            self._gpt_system_prompt = ""
            self._minicpm_input_prompt = ""
            self._model_provider = ""
            self._model_name = ""
            self._history.clear()
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if (
            start_task is not None
            and start_task is not asyncio.current_task()
            and not start_task.done()
        ):
            start_task.cancel()
            await asyncio.gather(start_task, return_exceptions=True)
        if owned_server:
            await self.server_manager.stop()
        return self.snapshot()


def _ws_upgrade_authorized(ws: WebSocket) -> bool:
    try:
        from hermes_cli import web_server as dashboard_server

        return bool(dashboard_server._ws_auth_ok(ws))
    except Exception:
        return False


bridge = VoiceBridge()
server_manager = LocalOmniServerManager()
smart_session = SmartMiniCPMSession(
    server_manager=server_manager,
    events=bridge.events,
)


class SessionStartBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    system_prompt: str = ""
    port: StrictInt | None = None

    @field_validator("system_prompt")
    @classmethod
    def enforce_system_prompt_byte_limit(cls, value: str) -> str:
        return validate_system_prompt(value)


class SmartSessionStartBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gpt_system_prompt: str
    minicpm_input_prompt: str
    model_provider: str = ""
    model_name: str = ""

    @field_validator("gpt_system_prompt")
    @classmethod
    def enforce_gpt_prompt_byte_limit(cls, value: str) -> str:
        return validate_system_prompt(value)

    @field_validator("minicpm_input_prompt")
    @classmethod
    def enforce_minicpm_prompt_requirements(cls, value: str) -> str:
        return validate_minicpm_input_prompt(value)


class EmptyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


async def probe_upstream_health(port: int = DEFAULT_UPSTREAM_PORT) -> dict[str, Any]:
    url = build_upstream_http_url(port, "/health")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(2.0), trust_env=False) as client:
            response = await client.get(url)
        response.raise_for_status()
        try:
            payload = response.json()
        except ValueError:
            payload = {"status": response.text[:128]}
        return {
            "reachable": True,
            "state": classify_upstream_health(payload),
            "http_status": response.status_code,
            "payload": payload,
        }
    except Exception:
        return {"reachable": False, "state": "unreachable"}


@router.get("/health")
async def health() -> dict[str, Any]:
    upstream = await probe_upstream_health(bridge.active_port if isinstance(bridge, VoiceBridge) else DEFAULT_UPSTREAM_PORT)
    local_state = bridge.snapshot()["state"]
    active = getattr(bridge, "session_id", None) is not None or getattr(bridge, "_starting", False)
    if active or local_state == "error":
        state = local_state
    else:
        state = str(upstream["state"])
    public_upstream = {
        "reachable": bool(upstream.get("reachable")),
        "state": str(upstream.get("state", "unreachable")),
    }
    if "http_status" in upstream:
        public_upstream["http_status"] = int(upstream["http_status"])
    return {"state": state, "upstream": public_upstream}


@router.get("/status")
async def status_snapshot() -> dict[str, Any]:
    return bridge.snapshot()


@router.get("/server/status")
async def server_status() -> dict[str, Any]:
    return await server_manager.status()


@router.get("/smart/models")
async def smart_models(request: Request, refresh: bool = False) -> dict[str, Any]:
    query_items = request.query_params.multi_items()
    if any(key != "refresh" for key, _value in query_items) or sum(
        key == "refresh" for key, _value in query_items
    ) > 1:
        raise HTTPException(status_code=422, detail="Invalid model catalog request.")
    try:
        payload = await asyncio.to_thread(smart_models_inventory_loader, refresh)
        return sanitize_smart_models_catalog(payload)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail="Model catalog is unavailable."
        ) from exc


@router.post("/server/start")
async def start_server() -> dict[str, Any]:
    try:
        return await server_manager.start()
    except ServerConfigurationError as exc:
        raise HTTPException(status_code=400, detail="Local server configuration is invalid.") from exc
    except ServerConflictError as exc:
        raise HTTPException(status_code=409, detail="Port 9060 is owned by an external server.") from exc
    except ServerStartupTimeout as exc:
        raise HTTPException(status_code=504, detail="Managed server startup timed out.") from exc
    except ServerStartError as exc:
        raise HTTPException(status_code=502, detail="Managed server failed to start.") from exc


@router.post("/server/stop")
async def stop_server() -> dict[str, Any]:
    try:
        await bridge.stop()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Voice resources could not be released.") from exc
    try:
        return await server_manager.stop()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Managed server could not be stopped.") from exc


@router.post("/session/start")
async def start_session(body: SessionStartBody) -> dict[str, Any]:
    try:
        return await bridge.start_session(body.system_prompt, port=body.port)
    except BridgeConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except BridgeUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/smart/session/start")
async def start_smart_session(body: SmartSessionStartBody) -> dict[str, Any]:
    try:
        model_provider, model_name = await validate_smart_model_selection(
            body.model_provider, body.model_name
        )
        return await smart_session.start(
            body.gpt_system_prompt,
            body.minicpm_input_prompt,
            model_provider,
            model_name,
        )
    except SmartModelSelectionUnavailable as exc:
        raise HTTPException(
            status_code=400, detail="Model selection is unavailable."
        ) from exc
    except SmartSessionConflict as exc:
        raise HTTPException(
            status_code=409, detail="A Smart session is already active."
        ) from exc
    except ServerConfigurationError as exc:
        raise HTTPException(
            status_code=400, detail="Local server configuration is invalid."
        ) from exc
    except ServerConflictError as exc:
        raise HTTPException(
            status_code=409, detail="The local voice server is unavailable."
        ) from exc
    except ServerStartupTimeout as exc:
        raise HTTPException(
            status_code=504, detail="Managed server startup timed out."
        ) from exc
    except (ServerStartError, SmartSessionError) as exc:
        raise HTTPException(
            status_code=502, detail="Smart session could not be started."
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail="Smart session could not be started."
        ) from exc


@router.post("/smart/turn")
async def submit_smart_turn(request: Request) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("multipart/form-data;"):
        raise HTTPException(
            status_code=http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="multipart form upload is required",
        )
    try:
        form = await request.form()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid multipart upload") from exc
    entries = list(form.multi_items())
    if len(entries) != 1 or entries[0][0] != "file":
        for _name, value in entries:
            if isinstance(value, StarletteUploadFile):
                await value.close()
        raise HTTPException(status_code=422, detail="form must contain exactly file")
    audio = entries[0][1]
    if not isinstance(audio, StarletteUploadFile):
        raise HTTPException(status_code=422, detail="file must be an upload")
    if not isinstance(audio.content_type, str) or audio.content_type.lower() != NATIVE_AUDIO_CONTENT_TYPE:
        await audio.close()
        raise HTTPException(
            status_code=http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="file must use application/octet-stream",
        )
    try:
        raw = await audio.read(MAX_AUDIO_BYTES + 1)
    finally:
        await audio.close()
    if len(raw) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio upload exceeds the 5 MiB limit")
    try:
        validate_smart_audio_bytes(raw)
        return await smart_session.turn(raw)
    except AudioValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SmartSessionConflict as exc:
        raise HTTPException(status_code=409, detail="Smart turn is not active.") from exc
    except SmartStageError as exc:
        detail = {
            "input stage failed": "Smart input failed.",
            "reasoning stage failed": "Smart reasoning failed.",
        }.get(str(exc), "Smart turn failed.")
        raise HTTPException(status_code=502, detail=detail) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Smart turn failed.") from exc


@router.post("/smart/session/interrupt")
async def interrupt_smart_session(_body: EmptyBody) -> dict[str, Any]:
    try:
        return await smart_session.interrupt()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Smart turn could not be interrupted.") from exc


@router.post("/smart/session/clear-history")
async def clear_smart_history(_body: EmptyBody) -> dict[str, Any]:
    try:
        return await smart_session.clear_history()
    except SmartSessionConflict as exc:
        raise HTTPException(
            status_code=409, detail="A Smart turn is active."
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail="Smart history could not be cleared."
        ) from exc


@router.post("/smart/session/stop")
async def stop_smart_session(_body: EmptyBody) -> dict[str, Any]:
    try:
        return await smart_session.stop()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Smart session could not be stopped.") from exc


@router.post("/turn")
async def submit_turn(audio: UploadFile = File(..., alias="file")) -> dict[str, Any]:
    if not isinstance(audio.content_type, str) or audio.content_type.lower() != NATIVE_AUDIO_CONTENT_TYPE:
        await audio.close()
        raise HTTPException(
            status_code=http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="file must use application/octet-stream",
        )
    try:
        raw = await audio.read(MAX_AUDIO_BYTES + 1)
    finally:
        await audio.close()
    if len(raw) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio upload exceeds the 5 MiB limit")
    try:
        validate_audio_bytes(raw)
        return await bridge.submit_turn(raw)
    except AudioValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except BridgeConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except BridgeUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/session/stop")
async def stop_session() -> dict[str, Any]:
    return await bridge.stop()


@router.websocket("/events")
async def stream_events(ws: WebSocket) -> None:
    if not _ws_upgrade_authorized(ws):
        await ws.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()
    queue = bridge.events.subscribe()
    try:
        await ws.send_json({"type": "status", **bridge.snapshot()})
        while True:
            receive_task = asyncio.create_task(ws.receive())
            event_task = asyncio.create_task(queue.get())
            done, pending = await asyncio.wait(
                {receive_task, event_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            if receive_task in done:
                message = receive_task.result()
                if message.get("type") == "websocket.disconnect":
                    return
            if event_task in done:
                await ws.send_json(event_task.result())
    except (WebSocketDisconnect, asyncio.CancelledError):
        return
    finally:
        bridge.events.unsubscribe(queue)
