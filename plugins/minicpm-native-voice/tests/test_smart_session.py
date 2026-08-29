from __future__ import annotations

import asyncio
import base64
import builtins
import json
import struct
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError


class FakeServerManager:
    def __init__(self, initial, started=None):
        self.initial = dict(initial)
        self.started = dict(started or initial)
        self.status_calls = 0
        self.start_calls = 0
        self.stop_calls = 0

    async def status(self):
        self.status_calls += 1
        return dict(self.initial)

    async def start(self):
        self.start_calls += 1
        return dict(self.started)

    async def stop(self):
        self.stop_calls += 1
        return {
            "state": "stopped", "running": False, "managed": False,
            "configured": True, "message": "stopped",
        }


class FakeSmartUpstream:
    def __init__(self, response_events, *, order=None, close_error=None):
        self.events = [
            {"type": "session.created", "session_id": "input-ws-1"},
            *response_events,
        ]
        self.sent = []
        self.closed = False
        self.close_calls = 0
        self.order = order
        self.close_error = close_error

    async def send(self, value):
        self.sent.append(json.loads(value))

    async def recv(self):
        return json.dumps(self.events.pop(0))

    async def close(self):
        self.close_calls += 1
        if self.order is not None:
            self.order.append("input.ws.close")
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


class GatedSmartUpstream(FakeSmartUpstream):
    def __init__(self, response_events, *, gate_before):
        super().__init__(response_events)
        self.gate_before = gate_before
        self.release = asyncio.Event()

    async def recv(self):
        if self.events and self.events[0].get("type") == self.gate_before:
            await self.release.wait()
        return await super().recv()


def test_smart_start_body_separates_optional_gpt_and_required_minicpm_prompts(plugin_api):
    gpt_marker = "  GPT MARKER\nexact  "
    input_marker = "  MINICPM MARKER\nexact  "

    body = plugin_api.SmartSessionStartBody(
        gpt_system_prompt=gpt_marker,
        minicpm_input_prompt=input_marker,
    )

    assert body.model_dump() == {
        "gpt_system_prompt": gpt_marker,
        "minicpm_input_prompt": input_marker,
        "model_provider": "",
        "model_name": "",
    }
    assert plugin_api.SmartSessionStartBody(
        gpt_system_prompt="", minicpm_input_prompt="listen"
    ).gpt_system_prompt == ""
    with pytest.raises(ValidationError):
        plugin_api.SmartSessionStartBody(
            gpt_system_prompt="", minicpm_input_prompt=" \r\n\t "
        )
    with pytest.raises(ValidationError):
        plugin_api.SmartSessionStartBody(
            gpt_system_prompt="", minicpm_input_prompt="listen", extra=True
        )


def test_smart_prompt_utf8_limits_are_checked_independently(plugin_api):
    exact = "a" * 65_536
    oversized = exact + "x"
    assert len(exact.encode("utf-8")) == plugin_api.MAX_SYSTEM_PROMPT_BYTES

    accepted = plugin_api.SmartSessionStartBody(
        gpt_system_prompt=exact, minicpm_input_prompt=exact
    )
    assert accepted.gpt_system_prompt == accepted.minicpm_input_prompt == exact
    with pytest.raises(ValidationError):
        plugin_api.SmartSessionStartBody(
            gpt_system_prompt=oversized, minicpm_input_prompt="listen"
        )
    with pytest.raises(ValidationError):
        plugin_api.SmartSessionStartBody(
            gpt_system_prompt="", minicpm_input_prompt=oversized
        )


def test_smart_audio_task_payload_has_exact_prompt_after_audio_shape(plugin_api):
    raw = b"\0\0\0\0"
    marker = "  INPUT ONLY MARKER  "

    payload = plugin_api.build_smart_input_payload(raw, marker)

    assert payload == {
        "type": "input.append",
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "audio",
                            "data": base64.b64encode(raw).decode("ascii"),
                        },
                        {"type": "text", "text": marker},
                    ],
                }
            ],
            "streaming": True,
            "audio_task_mode": "user_prompt_after_audio",
            "tts": {"enabled": False},
            "use_tts_template": False,
            "generation": {
                "max_new_tokens": plugin_api.TURN_MAX_NEW_TOKENS,
                "length_penalty": plugin_api.TURN_LENGTH_PENALTY,
            },
        },
    }
    serialized = json.dumps(payload, ensure_ascii=False)
    assert serialized.count("INPUT ONLY MARKER") == 1
    assert "gpt_system_prompt" not in serialized


def test_smart_gpt_messages_use_no_system_message_when_blank(plugin_api):
    history = [("prior user", "prior assistant")]

    blank = plugin_api.build_smart_gpt_messages("", history, "current user")
    marked = plugin_api.build_smart_gpt_messages(
        "  GPT ONLY MARKER  ", history, "current user"
    )

    assert blank == [
        {"role": "user", "content": "prior user"},
        {"role": "assistant", "content": "prior assistant"},
        {"role": "user", "content": "current user"},
    ]
    assert marked == [
        {"role": "system", "content": "  GPT ONLY MARKER  "},
        *blank,
    ]


@pytest.mark.asyncio
async def test_default_smart_llm_caller_uses_only_host_plugin_facade(
    plugin_api, monkeypatch
):
    created = []
    calls = []
    auxiliary_imports = []
    auxiliary_calls = []
    accepted = SimpleNamespace(
        text="accepted answer", provider="openai-codex", model="active-model"
    )

    class FakePluginLlm:
        def __init__(self, *, plugin_id):
            created.append(plugin_id)

        async def acomplete(self, *args, **kwargs):
            calls.append((args, kwargs))
            return accepted

    agent_module = ModuleType("agent")
    agent_module.__path__ = []
    plugin_llm_module = ModuleType("agent.plugin_llm")
    plugin_llm_module.PluginLlm = FakePluginLlm
    agent_module.plugin_llm = plugin_llm_module
    agent_module.auxiliary_client = SimpleNamespace(
        call_llm=lambda **kwargs: auxiliary_calls.append(kwargs)
    )
    monkeypatch.setitem(sys.modules, "agent", agent_module)
    monkeypatch.setitem(sys.modules, "agent.plugin_llm", plugin_llm_module)
    monkeypatch.delitem(sys.modules, "agent.auxiliary_client", raising=False)
    real_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "agent.auxiliary_client" or (
            name == "agent" and "auxiliary_client" in fromlist
        ):
            auxiliary_imports.append((name, fromlist))
            raise AssertionError("Smart must never import auxiliary_client")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    monkeypatch.setattr(plugin_api, "_smart_llm_facade", None, raising=False)
    messages = [{"role": "user", "content": "exact prompt"}]

    result = await plugin_api._default_smart_llm_caller(messages=messages)
    repeated = await plugin_api._default_smart_llm_caller(messages=messages)

    assert result is accepted
    assert repeated is accepted
    assert created == ["minicpm-native-voice"]
    assert auxiliary_imports == []
    assert auxiliary_calls == []
    assert calls == [
        ((messages,), {
            "timeout": plugin_api.SMART_GPT_TIMEOUT_SECONDS,
            "purpose": "smart-minicpm",
        }),
        ((messages,), {
            "timeout": plugin_api.SMART_GPT_TIMEOUT_SECONDS,
            "purpose": "smart-minicpm",
        }),
    ]


@pytest.mark.asyncio
async def test_default_smart_llm_caller_adds_only_frozen_provider_and_model(
    plugin_api, monkeypatch
):
    calls = []

    class FakePluginLlm:
        def __init__(self, *, plugin_id):
            assert plugin_id == "minicpm-native-voice"

        async def acomplete(self, *args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(text="answer")

    agent_module = ModuleType("agent")
    agent_module.__path__ = []
    plugin_llm_module = ModuleType("agent.plugin_llm")
    plugin_llm_module.PluginLlm = FakePluginLlm
    agent_module.plugin_llm = plugin_llm_module
    monkeypatch.setitem(sys.modules, "agent", agent_module)
    monkeypatch.setitem(sys.modules, "agent.plugin_llm", plugin_llm_module)
    monkeypatch.setattr(plugin_api, "_smart_llm_facade", None, raising=False)
    messages = [{"role": "user", "content": "exact"}]

    await plugin_api._default_smart_llm_caller(
        messages=messages, provider="openrouter", model="lab/model"
    )

    assert calls == [
        (
            (messages,),
            {
                "timeout": plugin_api.SMART_GPT_TIMEOUT_SECONDS,
                "purpose": "smart-minicpm",
                "provider": "openrouter",
                "model": "lab/model",
            },
        )
    ]


@pytest.mark.asyncio
async def test_smart_session_freezes_model_pair_across_history_turns(plugin_api, monkeypatch):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    upstreams = [
        FakeSmartUpstream([{"type": "response.done", "text": "first user"}]),
        FakeSmartUpstream([{"type": "response.done", "text": "second user"}]),
    ]
    calls = []

    async def connect(*_args, **_kwargs):
        return upstreams.pop(0)

    async def default_caller(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(text=f"answer {len(calls)}")

    async def no_speech(_text):
        raise RuntimeError("speech unavailable")

    monkeypatch.setattr(plugin_api, "_default_smart_llm_caller", default_caller)
    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        tts_caller=no_speech,
    )
    started = await session.start(
        "coach", "input", model_provider="openrouter", model_name="lab/model"
    )

    await session.turn(struct.pack("<f", 0.0))
    await session.turn(struct.pack("<f", 0.0))

    assert "provider" not in started and "model" not in started
    assert calls == [
        {
            "messages": [
                {"role": "system", "content": "coach"},
                {"role": "user", "content": "first user"},
            ],
            "provider": "openrouter",
            "model": "lab/model",
        },
        {
            "messages": [
                {"role": "system", "content": "coach"},
                {"role": "user", "content": "first user"},
                {"role": "assistant", "content": "answer 1"},
                {"role": "user", "content": "second user"},
            ],
            "provider": "openrouter",
            "model": "lab/model",
        },
    ]


@pytest.mark.asyncio
async def test_smart_interrupt_cancels_reasoning_and_leaves_next_turn_clean(plugin_api):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    upstreams = [
        FakeSmartUpstream([{"type": "response.done", "text": "first user"}]),
        FakeSmartUpstream([{"type": "response.done", "text": "second user"}]),
    ]
    llm_started = asyncio.Event()
    llm_cancelled = asyncio.Event()
    llm_calls = []
    tts_calls = []

    async def connect(*_args, **_kwargs):
        return upstreams.pop(0)

    async def call_llm(**kwargs):
        llm_calls.append(kwargs)
        if len(llm_calls) == 1:
            llm_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                llm_cancelled.set()
                raise
        return SimpleNamespace(content="current answer")

    async def call_tts(text):
        tts_calls.append(text)
        raise RuntimeError("speech unavailable")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        llm_caller=call_llm,
        tts_caller=call_tts,
    )
    await session.start("", "input")
    turn = asyncio.create_task(session.turn(struct.pack("<f", 0.0)))
    try:
        await asyncio.wait_for(llm_started.wait(), timeout=2)

        interrupted = await session.interrupt()
        turn_result = await asyncio.gather(turn, return_exceptions=True)

        assert interrupted["state"] == "listening"
        assert isinstance(turn_result[0], plugin_api.SmartSessionConflict)
        assert llm_cancelled.is_set()
        assert tts_calls == []
    finally:
        if not turn.done():
            turn.cancel()
            await asyncio.gather(turn, return_exceptions=True)

    second = await session.turn(struct.pack("<f", 0.0))

    assert second["assistant_text"] == "current answer"
    assert llm_calls[1]["messages"] == [
        {"role": "user", "content": "second user"},
    ]
    assert tts_calls == ["current answer"]


@pytest.mark.asyncio
async def test_smart_start_starts_and_owns_server_only_when_needed(plugin_api):
    stopped = {
        "state": "stopped", "running": False, "managed": False,
        "configured": True, "message": "stopped",
    }
    ready = {
        "state": "ready", "running": True, "managed": True,
        "configured": True, "message": "ready", "pid": 123,
    }
    server = FakeServerManager(stopped, ready)
    connector_calls = 0

    async def forbidden_connector(*_args, **_kwargs):
        nonlocal connector_calls
        connector_calls += 1
        raise AssertionError("Smart Start must not create a WebSocket")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=server, connector=forbidden_connector
    )
    started = await session.start("gpt", "input")

    assert server.status_calls == server.start_calls == 1
    assert connector_calls == 0
    assert started["state"] == "listening"
    assert started["session_id"]
    assert started["generation"] == 1
    assert "gpt" not in json.dumps(started)
    assert "input" not in json.dumps(started)

    await session.stop()
    assert server.stop_calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["ready", "external"])
async def test_smart_start_reuses_running_server_without_taking_ownership(plugin_api, state):
    existing = {
        "state": state, "running": True, "managed": state == "ready",
        "configured": True, "message": state,
    }
    server = FakeServerManager(existing)
    session = plugin_api.SmartMiniCPMSession(server_manager=server)

    await session.start("", "input")
    await session.stop()

    assert server.start_calls == 0
    assert server.stop_calls == 0


@pytest.mark.asyncio
async def test_stop_during_smart_cold_start_prevents_late_session(plugin_api):
    started = asyncio.Event()

    class BlockingServer(FakeServerManager):
        async def start(self):
            self.start_calls += 1
            started.set()
            await asyncio.Future()

    stopped = {
        "state": "stopped", "running": False, "managed": False,
        "configured": True, "message": "stopped",
    }
    server = BlockingServer(stopped)
    session = plugin_api.SmartMiniCPMSession(server_manager=server)
    starting = asyncio.create_task(session.start("", "input"))
    await started.wait()

    stopped_snapshot = await session.stop()
    start_result = await asyncio.gather(starting, return_exceptions=True)

    assert isinstance(start_result[0], asyncio.CancelledError)
    assert stopped_snapshot["state"] == "stopped"
    assert session.snapshot()["session_id"] is None


@pytest.mark.asyncio
async def test_smart_turn_closes_input_ws_before_exact_gpt_and_native_tts(plugin_api):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    server = FakeServerManager(existing)
    order = []
    upstream = FakeSmartUpstream([
        {"type": "response.output.delta", "kind": "text", "text": "ignored delta"},
        {"type": "response.done", "text": "  understood words  "},
    ], order=order)
    llm_calls = []
    tts_calls = []

    async def connect(url, **kwargs):
        assert url == "ws://127.0.0.1:9060/backend"
        assert kwargs["ping_interval"] is None
        assert kwargs["close_timeout"] == 2
        return upstream

    async def close_input(session_id, port):
        assert (session_id, port) == ("input-ws-1", 9060)
        order.append("input.session.close")

    async def call_llm(**kwargs):
        assert upstream.closed is True
        order.append("gpt")
        llm_calls.append(kwargs)
        return "  exact GPT answer  "

    tts_audio = struct.pack("<2f", 0.25, -0.25)

    async def call_tts(text):
        order.append("tts")
        tts_calls.append(text)
        return {
            "text": text,
            "audio": base64.b64encode(tts_audio).decode("ascii"),
            "sample_rate": 24_000,
        }

    session = plugin_api.SmartMiniCPMSession(
        server_manager=server,
        connector=connect,
        close_session_request=close_input,
        llm_caller=call_llm,
        tts_caller=call_tts,
    )
    started = await session.start("  GPT PROMPT  ", "  INPUT PROMPT  ")
    result = await session.turn(struct.pack("<2f", 0.1, -0.1))

    assert upstream.sent[0] == plugin_api.build_session_init("")
    assert upstream.sent[1] == plugin_api.build_smart_input_payload(
        struct.pack("<2f", 0.1, -0.1), "  INPUT PROMPT  "
    )
    assert order == ["input.ws.close", "input.session.close", "gpt", "tts"]
    assert llm_calls == [{
        "messages": [
            {"role": "system", "content": "  GPT PROMPT  "},
            {"role": "user", "content": "understood words"},
        ],
        "route_info": plugin_api.SMART_ROUTE_INFO,
    }]
    assert tts_calls == ["  exact GPT answer  "]
    assert result == {
        "state": "listening",
        "session_id": started["session_id"],
        "generation": started["generation"],
        "turn_id": result["turn_id"],
        "user_text": "understood words",
        "assistant_text": "  exact GPT answer  ",
        "audio_base64": base64.b64encode(tts_audio).decode("ascii"),
        "sample_rate": 24_000,
        "warning": None,
    }


@pytest.mark.asyncio
async def test_smart_input_cleanup_is_ws_then_final_reset_on_failure(plugin_api, caplog):
    private_error = "PRIVATE PROMPT AND TRANSCRIPT MUST NOT LEAK"
    order = []

    class FailingUpstream(FakeSmartUpstream):
        async def recv(self):
            if self.events:
                return await super().recv()
            raise RuntimeError(private_error)

    upstream = FailingUpstream([], order=order)
    close_calls = []

    async def connect(*_args, **_kwargs):
        return upstream

    async def close_input(session_id, port):
        close_calls.append((session_id, port))
        order.append("input.session.close")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=close_input,
    )

    with pytest.raises(plugin_api.SmartStageError, match="^input stage failed$") as failed:
        await session._run_minicpm_input(struct.pack("<f", 0.0), "PRIVATE PROMPT")

    assert str(failed.value) == "input stage failed"
    assert private_error not in str(failed.value)
    assert private_error not in caplog.text
    assert "PRIVATE PROMPT" not in caplog.text
    assert order == ["input.ws.close", "input.session.close"]
    assert upstream.close_calls == 1
    assert close_calls == [("input-ws-1", plugin_api.DEFAULT_UPSTREAM_PORT)]


@pytest.mark.asyncio
async def test_smart_input_cleanup_is_ws_then_final_reset_on_cancel(plugin_api):
    order = []
    blocked = asyncio.Event()

    class BlockingUpstream(FakeSmartUpstream):
        async def recv(self):
            if self.events:
                return await super().recv()
            blocked.set()
            await asyncio.Future()

    upstream = BlockingUpstream([], order=order)
    close_calls = []

    async def connect(*_args, **_kwargs):
        return upstream

    async def close_input(session_id, port):
        close_calls.append((session_id, port))
        order.append("input.session.close")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=close_input,
    )
    running = asyncio.create_task(
        session._run_minicpm_input(struct.pack("<f", 0.0), "input")
    )
    await asyncio.wait_for(blocked.wait(), timeout=2)
    running.cancel()
    result = await asyncio.gather(running, return_exceptions=True)

    assert isinstance(result[0], asyncio.CancelledError)
    assert order == ["input.ws.close", "input.session.close"]
    assert upstream.close_calls == 1
    assert close_calls == [("input-ws-1", plugin_api.DEFAULT_UPSTREAM_PORT)]


@pytest.mark.asyncio
async def test_smart_input_waits_for_final_reset_after_ws_close(plugin_api):
    order = []
    reset_started = asyncio.Event()
    release_reset = asyncio.Event()
    upstream = FakeSmartUpstream(
        [{"type": "response.done", "text": "interpreted words"}], order=order
    )

    async def connect(*_args, **_kwargs):
        return upstream

    async def close_input(_session_id, _port):
        order.append("input.session.close.start")
        reset_started.set()
        await release_reset.wait()
        order.append("input.session.close.done")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=close_input,
    )
    running = asyncio.create_task(
        session._run_minicpm_input(struct.pack("<f", 0.0), "input")
    )
    try:
        await asyncio.wait_for(reset_started.wait(), timeout=2)
        assert order == ["input.ws.close", "input.session.close.start"]
        assert not running.done()
        release_reset.set()
        assert await running == "interpreted words"
        assert order == [
            "input.ws.close",
            "input.session.close.start",
            "input.session.close.done",
        ]
        assert upstream.close_calls == 1
    finally:
        release_reset.set()
        if not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


@pytest.mark.asyncio
async def test_smart_input_final_reset_runs_when_ws_close_fails(plugin_api):
    order = []
    close_calls = []
    upstream = FakeSmartUpstream(
        [{"type": "response.done", "text": "interpreted words"}],
        order=order,
        close_error=RuntimeError("private close failure"),
    )

    async def connect(*_args, **_kwargs):
        return upstream

    async def close_input(session_id, port):
        close_calls.append((session_id, port))
        order.append("input.session.close")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=close_input,
    )

    assert await session._run_minicpm_input(
        struct.pack("<f", 0.0), "input"
    ) == "interpreted words"
    assert order == ["input.ws.close", "input.session.close"]
    assert upstream.close_calls == 1
    assert close_calls == [("input-ws-1", plugin_api.DEFAULT_UPSTREAM_PORT)]


@pytest.mark.asyncio
async def test_smart_input_final_reset_runs_when_ws_close_is_cancelled(plugin_api):
    order = []
    close_calls = []
    upstream = FakeSmartUpstream(
        [{"type": "response.done", "text": "interpreted words"}],
        order=order,
        close_error=asyncio.CancelledError(),
    )

    async def connect(*_args, **_kwargs):
        return upstream

    async def close_input(session_id, port):
        close_calls.append((session_id, port))
        order.append("input.session.close")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=close_input,
    )

    with pytest.raises(asyncio.CancelledError):
        await session._run_minicpm_input(struct.pack("<f", 0.0), "input")

    assert order == ["input.ws.close", "input.session.close"]
    assert upstream.close_calls == 1
    assert close_calls == [("input-ws-1", plugin_api.DEFAULT_UPSTREAM_PORT)]


@pytest.mark.asyncio
async def test_smart_user_text_event_precedes_blocked_gpt_and_is_published_once(
    plugin_api,
):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    upstream = FakeSmartUpstream([
        {"type": "response.done", "text": "  exact interpreted words  "},
    ])
    broker = plugin_api.EventBroker()
    subscriber = broker.subscribe()
    gpt_started = asyncio.Event()
    release_gpt = asyncio.Event()

    async def connect(*_args, **_kwargs):
        return upstream

    async def call_llm(**_kwargs):
        gpt_started.set()
        await release_gpt.wait()
        return "exact coach answer"

    async def no_audio(_text):
        raise RuntimeError("speech unavailable")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        llm_caller=call_llm,
        tts_caller=no_audio,
        events=broker,
    )
    started = await session.start("", "input")
    turning = asyncio.create_task(session.turn(struct.pack("<f", 0.25)))
    try:
        await asyncio.wait_for(gpt_started.wait(), timeout=2)
        event = subscriber.get_nowait()

        assert event == {
            "type": "smart.user_text",
            "session_id": started["session_id"],
            "generation": started["generation"],
            "turn_id": event["turn_id"],
            "text": "exact interpreted words",
        }
        assert event["turn_id"]
        assert subscriber.empty()

        release_gpt.set()
        result = await turning
        assert result["turn_id"] == event["turn_id"]
        assert result["user_text"] == event["text"]
        assert subscriber.empty()
        assert session._history == [(event["text"], "exact coach answer")]
    finally:
        release_gpt.set()
        if not turning.done():
            turning.cancel()
            await asyncio.gather(turning, return_exceptions=True)


@pytest.mark.asyncio
async def test_smart_user_text_event_overflow_fails_closed_without_breaking_turn(
    plugin_api,
):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    broker = plugin_api.EventBroker(maxsize=1, max_bytes=220)
    subscriber = broker.subscribe()
    upstream = FakeSmartUpstream([
        {"type": "response.done", "text": "x" * 128},
    ])

    async def connect(*_args, **_kwargs):
        return upstream

    async def no_audio(_text):
        raise RuntimeError("speech unavailable")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        llm_caller=lambda **_kwargs: asyncio.sleep(0, result="answer"),
        tts_caller=no_audio,
        events=broker,
    )
    await session.start("", "input")

    result = await session.turn(struct.pack("<f", 0.0))

    assert result["assistant_text"] == "answer"
    assert session._history == [("x" * 128, "answer")]
    assert broker.overflow_count == 1
    overflow = subscriber.get_nowait()
    assert overflow["type"] == "error"
    assert overflow["code"] == "subscriber_queue_overflow"
    assert subscriber.empty()


@pytest.mark.asyncio
async def test_smart_text_deltas_publish_before_upstream_final_then_final_is_authoritative(
    plugin_api,
):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    upstream = GatedSmartUpstream(
        [
            {"type": "response.output.delta", "kind": "text", "text": "  Exact"},
            {"type": "response.output.delta", "kind": "text", "text": " incremental"},
            {"type": "response.output.delta", "kind": "text", "text": " words"},
            {"type": "response.done", "text": "Exact authoritative words"},
        ],
        gate_before="response.done",
    )
    broker = plugin_api.EventBroker()
    subscriber = broker.subscribe()

    async def connect(*_args, **_kwargs):
        return upstream

    async def no_audio(_text):
        raise RuntimeError("speech unavailable")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        llm_caller=lambda **_kwargs: asyncio.sleep(0, result="answer"),
        tts_caller=no_audio,
        events=broker,
    )
    started = await session.start("", "input")
    turning = asyncio.create_task(session.turn(struct.pack("<f", 0.25)))
    try:
        delta = await asyncio.wait_for(subscriber.get(), timeout=2)
        assert delta == {
            "type": "smart.user_text.delta",
            "session_id": started["session_id"],
            "generation": started["generation"],
            "turn_id": delta["turn_id"],
            "text": "  Exact incremental",
        }
        assert delta["turn_id"]
        assert not turning.done()

        following_delta = subscriber.get_nowait()
        assert following_delta == {**delta, "text": " words"}
        assert subscriber.empty()

        upstream.release.set()
        final = await asyncio.wait_for(subscriber.get(), timeout=2)
        assert final == {
            "type": "smart.user_text",
            "session_id": started["session_id"],
            "generation": started["generation"],
            "turn_id": delta["turn_id"],
            "text": "Exact authoritative words",
        }
        result = await turning
        assert result["user_text"] == "Exact authoritative words"
    finally:
        upstream.release.set()
        if not turning.done():
            turning.cancel()
            await asyncio.gather(turning, return_exceptions=True)


@pytest.mark.asyncio
async def test_smart_split_leading_control_wrapper_never_reaches_delta_callback(
    plugin_api,
):
    upstream = FakeSmartUpstream([
        {"type": "response.output.delta", "kind": "text", "text": " \n  dataset_audio_"},
        {"type": "response.output.delta", "kind": "text", "text": "identifier"},
        {"type": "response.done", "text": "apparently clean final text"},
    ])
    published = []

    async def connect(*_args, **_kwargs):
        return upstream

    async def publish_delta(text):
        published.append(text)

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
    )

    with pytest.raises(plugin_api.SmartStageError, match="^input stage failed$"):
        await session._run_minicpm_input(
            struct.pack("<f", 0.0), "input", delta_callback=publish_delta
        )

    assert published == []
    assert upstream.closed is True


@pytest.mark.asyncio
async def test_smart_input_audio_event_fails_before_gpt_or_tts(plugin_api):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    upstream = FakeSmartUpstream([
        {"type": "response.output.delta", "kind": "audio", "audio": "AAAAAA=="},
        {"type": "response.done", "text": "private interpretation"},
    ])
    calls = []

    async def connect(*_args, **_kwargs):
        return upstream

    async def forbidden(**_kwargs):
        calls.append("gpt")

    async def forbidden_tts(_text):
        calls.append("tts")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing), connector=connect,
        llm_caller=forbidden, tts_caller=forbidden_tts,
    )
    await session.start("", "input")

    with pytest.raises(plugin_api.SmartStageError, match="input stage failed"):
        await session.turn(struct.pack("<f", 0.0))

    assert upstream.closed is True
    assert calls == []


@pytest.mark.asyncio
async def test_smart_input_control_token_wrapper_fails_closed_before_gpt_or_tts(
    plugin_api, caplog
):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    rejected = "<|SOA|>dataset_audio_identifier<|EOA|>"
    upstream = FakeSmartUpstream([
        {"type": "response.done", "text": rejected},
    ])
    calls = []

    async def connect(*_args, **_kwargs):
        return upstream

    async def forbidden_llm(**_kwargs):
        calls.append("gpt")
        return "must not be returned"

    async def forbidden_tts(_text):
        calls.append("tts")
        return {}

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        llm_caller=forbidden_llm,
        tts_caller=forbidden_tts,
    )
    await session.start("", "input")

    with pytest.raises(
        plugin_api.SmartStageError, match="^input stage failed$"
    ) as failed:
        await session.turn(struct.pack("<f", 0.0))

    assert str(failed.value) == "input stage failed"
    assert rejected not in str(failed.value)
    assert rejected not in caplog.text
    assert upstream.closed is True
    assert calls == []
    assert session._history == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rejected",
    [
        "words before <|SOA|> words after",
        "words before <|EOA|> words after",
        "words before\0words after",
        "words before dataset_audio_identifier words after",
    ],
    ids=["soa", "eoa", "nul", "audio-identifier"],
)
async def test_smart_input_rejects_each_model_audio_artifact_anywhere(
    plugin_api, caplog, rejected
):
    upstream = FakeSmartUpstream([
        {"type": "response.done", "text": rejected},
    ])

    async def connect(*_args, **_kwargs):
        return upstream

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
    )

    with pytest.raises(
        plugin_api.SmartStageError, match="^input stage failed$"
    ) as failed:
        await session._run_minicpm_input(struct.pack("<f", 0.0), "input")

    assert str(failed.value) == "input stage failed"
    assert rejected not in str(failed.value)
    assert rejected not in caplog.text
    assert upstream.closed is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "accepted",
    [
        "Use <angle brackets> literally.",
        "Lowercase controls <|soa|> and <|eoa|> are ordinary text.",
        "A different token <|TEXT|> remains literal.",
    ],
    ids=["angle-brackets", "case-exact", "different-control"],
)
async def test_smart_input_accepts_ordinary_literal_angle_bracket_text(
    plugin_api, accepted
):
    upstream = FakeSmartUpstream([
        {"type": "response.done", "text": accepted},
    ])

    async def connect(*_args, **_kwargs):
        return upstream

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
    )

    result = await session._run_minicpm_input(
        struct.pack("<f", 0.0), "input"
    )

    assert result == accepted
    assert upstream.closed is True


def test_smart_interpretation_removes_only_exact_unk_markers(plugin_api):
    assert plugin_api.validate_minicpm_interpretation(
        "  <unk> um  a little faster <unk>  "
    ) == "um  a little faster"
    assert plugin_api.validate_minicpm_interpretation(
        "before<unk>middle<unk>after"
    ) == "beforemiddleafter"
    assert plugin_api.validate_minicpm_interpretation(
        "  <angle> <UNK> lowercase unknown words  "
    ) == "<angle> <UNK> lowercase unknown words"
    with pytest.raises(plugin_api.SmartStageError, match="^input stage failed$"):
        plugin_api.validate_minicpm_interpretation(" \n <unk><unk> \t")


@pytest.mark.parametrize(
    ("raw_text", "expected"),
    [
        (
            "Original sentence: 鍡紝鎴戞兂鐭ラ亾鐨勬槸...",
            "鍡紝鎴戞兂鐭ラ亾鐨勬槸...",
        ),
        (
            "The transcription of the given speech is: 鍝囧摝...",
            "鍝囧摝...",
        ),
        (
            " \n Original sentence:\tThe transcription of the given speech is:  exact?!  \r\n",
            "exact?!",
        ),
        (
            "Keep Original sentence: when it occurs later, exactly.",
            "Keep Original sentence: when it occurs later, exactly.",
        ),
        (
            "original sentence: case-sensitive ordinary text",
            "original sentence: case-sensitive ordinary text",
        ),
    ],
    ids=[
        "original-sentence-screenshot",
        "transcription-screenshot",
        "repeated-known-prefixes",
        "known-words-later",
        "case-sensitive",
    ],
)
def test_smart_interpretation_strips_only_known_repeated_leading_metadata(
    plugin_api, raw_text, expected
):
    assert plugin_api.validate_minicpm_interpretation(raw_text) == expected


@pytest.mark.parametrize(
    "raw_text",
    [
        "Original sentence:",
        " \n Original sentence: The transcription of the given speech is: <unk> \t",
    ],
)
def test_smart_interpretation_prefix_only_is_generic_input_failure(
    plugin_api, raw_text, caplog
):
    with pytest.raises(plugin_api.SmartStageError, match="^input stage failed$"):
        plugin_api.validate_minicpm_interpretation(raw_text)
    assert raw_text not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("chunks", "final_text", "expected_partial", "expected_final"),
    [
        (["<u", "nk> um a little", " faster"], "<unk> um a little faster", " um a little faster", "um a little faster"),
        (["This is a long <u", "nk> phrase"], "This is a long <unk> phrase", "This is a long  phrase", "This is a long  phrase"),
    ],
    ids=["split-leading-screenshot", "mid-sentence"],
)
async def test_smart_stream_never_publishes_split_or_whole_unk_marker(
    plugin_api, chunks, final_text, expected_partial, expected_final
):
    upstream = FakeSmartUpstream([
        *[
            {"type": "response.output.delta", "kind": "text", "text": chunk}
            for chunk in chunks
        ],
        {"type": "response.done", "text": final_text},
    ])
    published = []

    async def connect(*_args, **_kwargs):
        return upstream

    async def publish_delta(text):
        published.append(text)

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
    )
    result = await session._run_minicpm_input(
        struct.pack("<f", 0.0), "input", delta_callback=publish_delta
    )

    streamed = "".join(published)
    assert streamed == expected_partial
    assert result == expected_final
    assert "<unk>" not in streamed
    assert "<u" not in streamed
    assert upstream.closed is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("chunks", "final_text", "expected"),
    [
        (
            [" \n Original sen", "tence:", "  鍡紝", "鎴戞兂鐭ラ亾鐨勬槸..."],
            "Original sentence: 鍡紝鎴戞兂鐭ラ亾鐨勬槸...",
            "鍡紝鎴戞兂鐭ラ亾鐨勬槸...",
        ),
        (
            ["The trans", "cription of the given ", "speech is:\t", "鍝囧摝..."],
            "The transcription of the given speech is: 鍝囧摝...",
            "鍝囧摝...",
        ),
        (
            ["Original sentence: The trans", "cription of the given speech is: ", "exact speech"],
            "Original sentence: The transcription of the given speech is: exact speech",
            "exact speech",
        ),
        (
            ["An ordinary sentence that says ", "Original sentence: later."],
            "An ordinary sentence that says Original sentence: later.",
            "An ordinary sentence that says Original sentence: later.",
        ),
    ],
    ids=["split-original", "split-transcription", "split-repeated", "natural-later"],
)
async def test_smart_stream_holds_and_strips_only_known_leading_metadata(
    plugin_api, chunks, final_text, expected
):
    upstream = FakeSmartUpstream([
        *[
            {"type": "response.output.delta", "kind": "text", "text": chunk}
            for chunk in chunks
        ],
        {"type": "response.done", "text": final_text},
    ])
    published = []

    async def connect(*_args, **_kwargs):
        return upstream

    async def publish_delta(text):
        published.append(text)

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
    )
    result = await session._run_minicpm_input(
        struct.pack("<f", 0.0), "input", delta_callback=publish_delta
    )

    streamed = "".join(published)
    assert streamed == expected
    assert result == expected
    assert not streamed.lstrip().startswith((
        "Original sentence:",
        "The transcription of the given speech is:",
    ))


@pytest.mark.asyncio
async def test_smart_stream_prefix_only_fails_without_publishing_or_logging(
    plugin_api, caplog
):
    raw_text = " \n Original sentence: The transcription of the given speech is: <unk> \t"
    upstream = FakeSmartUpstream([
        {"type": "response.output.delta", "kind": "text", "text": " \n Original sen"},
        {"type": "response.output.delta", "kind": "text", "text": "tence: The trans"},
        {"type": "response.output.delta", "kind": "text", "text": "cription of the given speech is: <unk>"},
        {"type": "response.done", "text": raw_text},
    ])
    published = []

    async def connect(*_args, **_kwargs):
        return upstream

    async def publish_delta(text):
        published.append(text)

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager({}),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
    )
    with pytest.raises(plugin_api.SmartStageError, match="^input stage failed$"):
        await session._run_minicpm_input(
            struct.pack("<f", 0.0), "input", delta_callback=publish_delta
        )

    assert published == []
    assert raw_text not in caplog.text


@pytest.mark.asyncio
async def test_smart_unk_cleanup_is_the_only_text_sent_to_gpt_history_and_final_event(
    plugin_api, caplog
):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    raw_interpretation = "<unk> um a little faster <unk>"
    upstream = FakeSmartUpstream([
        {"type": "response.done", "text": raw_interpretation},
    ])
    llm_calls = []
    broker = plugin_api.EventBroker()
    subscriber = broker.subscribe()

    async def connect(*_args, **_kwargs):
        return upstream

    async def call_llm(**kwargs):
        llm_calls.append(kwargs)
        return "coach answer"

    async def no_audio(_text):
        raise RuntimeError("speech unavailable")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing),
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        llm_caller=call_llm,
        tts_caller=no_audio,
        events=broker,
    )
    started = await session.start("", "input")
    result = await session.turn(struct.pack("<f", 0.0))
    event = subscriber.get_nowait()

    assert result["user_text"] == "um a little faster"
    assert session._history == [("um a little faster", "coach answer")]
    assert llm_calls[0]["messages"] == [
        {"role": "user", "content": "um a little faster"},
    ]
    assert event == {
        "type": "smart.user_text",
        "session_id": started["session_id"],
        "generation": started["generation"],
        "turn_id": result["turn_id"],
        "text": "um a little faster",
    }
    assert subscriber.empty()
    assert raw_interpretation not in caplog.text
    assert "<unk>" not in caplog.text


@pytest.mark.asyncio
async def test_smart_gpt_failure_skips_tts_and_tts_failure_commits_text_only(plugin_api):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    upstreams = [
        FakeSmartUpstream([{"type": "response.done", "text": "first user"}]),
        FakeSmartUpstream([{"type": "response.done", "text": "second user"}]),
        FakeSmartUpstream([{"type": "response.done", "text": "third user"}]),
    ]
    llm_calls = []
    tts_calls = []

    async def connect(*_args, **_kwargs):
        return upstreams.pop(0)

    async def call_llm(**kwargs):
        llm_calls.append(kwargs)
        if len(llm_calls) == 1:
            raise RuntimeError("private model failure")
        return f"answer {len(llm_calls)}"

    async def call_tts(text):
        tts_calls.append(text)
        if len(tts_calls) == 1:
            raise RuntimeError("private voice failure")
        raw = struct.pack("<f", 0.0)
        return {
            "text": text, "audio": base64.b64encode(raw).decode("ascii"),
            "sample_rate": 24_000,
        }

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing), connector=connect,
        llm_caller=call_llm, tts_caller=call_tts,
    )
    await session.start("", "input")

    with pytest.raises(plugin_api.SmartStageError, match="reasoning stage failed") as failed:
        await session.turn(struct.pack("<f", 0.0))
    assert "private" not in str(failed.value)
    assert tts_calls == []

    text_only = await session.turn(struct.pack("<f", 0.0))
    assert text_only["assistant_text"] == "answer 2"
    assert text_only["audio_base64"] is None
    assert text_only["sample_rate"] is None
    assert text_only["warning"] == "MiniCPM native speech failed."

    await session.turn(struct.pack("<f", 0.0))
    assert llm_calls[2]["messages"] == [
        {"role": "user", "content": "second user"},
        {"role": "assistant", "content": "answer 2"},
        {"role": "user", "content": "third user"},
    ]


def test_smart_assistant_text_accepts_nested_object_response(plugin_api):
    result = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content="  exact auxiliary answer  ")
            )
        ]
    )

    assert plugin_api._smart_assistant_text(result) == "  exact auxiliary answer  "


@pytest.mark.parametrize("top_object", [False, True])
@pytest.mark.parametrize("choice_object", [False, True])
@pytest.mark.parametrize("message_object", [False, True])
def test_smart_assistant_text_accepts_nested_dict_object_combinations(
    plugin_api, top_object, choice_object, message_object
):
    message = {"content": "answer"}
    if message_object:
        message = SimpleNamespace(**message)
    choice = {"message": message}
    if choice_object:
        choice = SimpleNamespace(**choice)
    result = {"choices": [choice]}
    if top_object:
        result = SimpleNamespace(**result)

    assert plugin_api._smart_assistant_text(result) == "answer"


def test_smart_assistant_text_preserves_direct_shapes_and_utf8_byte_limit(plugin_api):
    exact_limit = "é" * (plugin_api.MAX_SMART_TEXT_BYTES // 2)

    assert plugin_api._smart_assistant_text(" direct string ") == " direct string "
    assert plugin_api._smart_assistant_text({"text": " facade dict "}) == " facade dict "
    assert (
        plugin_api._smart_assistant_text(SimpleNamespace(text=" facade object "))
        == " facade object "
    )
    assert plugin_api._smart_assistant_text({"content": " dict content "}) == " dict content "
    assert (
        plugin_api._smart_assistant_text(SimpleNamespace(content=" object content "))
        == " object content "
    )
    assert plugin_api._smart_assistant_text(exact_limit) == exact_limit

    with pytest.raises(plugin_api.SmartStageError, match="^reasoning stage failed$"):
        plugin_api._smart_assistant_text(exact_limit + "x")


def test_smart_assistant_text_rejects_empty_arbitrary_and_tool_call_only(plugin_api):
    private_content = "PRIVATE RESPONSE CONTENT"

    class ArbitraryResponse:
        def __str__(self):
            return private_content

    invalid = [
        "",
        " \r\n\t ",
        ArbitraryResponse(),
        {"choices": [{"message": {"tool_calls": [{"name": "private"}]}}]},
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(tool_calls=[{"name": "private"}])
                )
            ]
        ),
    ]
    for result in invalid:
        with pytest.raises(
            plugin_api.SmartStageError, match="^reasoning stage failed$"
        ) as failed:
            plugin_api._smart_assistant_text(result)
        assert private_content not in str(failed.value)


def test_smart_tts_response_is_exact_bounded_finite_f32le(plugin_api):
    answer = " exact "
    raw = struct.pack("<2f", 1.0, -1.0)
    encoded = base64.b64encode(raw).decode("ascii")

    assert plugin_api.build_smart_tts_request(answer) == {
        "url": "http://127.0.0.1:9060/v1/audio/speech/minicpm",
        "json": {"input": answer, "response_format": "f32le_json"},
    }
    assert plugin_api.validate_smart_tts_response({
        "text": answer, "audio": encoded, "sample_rate": 24_000,
    }, answer) == (encoded, raw)

    invalid = [
        {"text": "changed", "audio": encoded, "sample_rate": 24_000},
        {"text": answer, "audio": "not base64", "sample_rate": 24_000},
        {"text": answer, "audio": encoded, "sample_rate": 16_000},
        {"text": answer, "audio_base64": encoded, "sample_rate": 24_000},
        {
            "text": answer,
            "audio": encoded,
            "sample_rate": 24_000,
            "audio_base64": encoded,
        },
        {"text": answer, "audio": base64.b64encode(struct.pack("<f", float("nan"))).decode("ascii"), "sample_rate": 24_000},
    ]
    for payload in invalid:
        with pytest.raises(plugin_api.SmartStageError):
            plugin_api.validate_smart_tts_response(payload, answer)


@pytest.mark.asyncio
async def test_smart_interrupt_cancels_only_turn_preserves_session_and_history(plugin_api):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    first = FakeSmartUpstream([{"type": "response.done", "text": "first user"}])

    class BlockingUpstream(FakeSmartUpstream):
        async def recv(self):
            if self.events:
                return json.dumps(self.events.pop(0))
            await asyncio.Future()

    blocked = BlockingUpstream([])
    third = FakeSmartUpstream([{"type": "response.done", "text": "third user"}])
    upstreams = [first, blocked, third]
    llm_messages = []

    async def connect(*_args, **_kwargs):
        return upstreams.pop(0)

    async def llm(**kwargs):
        llm_messages.append(kwargs["messages"])
        return f"answer {len(llm_messages)}"

    async def no_audio(_text):
        raise RuntimeError("speech unavailable")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=FakeServerManager(existing), connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        llm_caller=llm, tts_caller=no_audio,
    )
    started = await session.start("", "input")
    await session.turn(struct.pack("<f", 0.0))
    blocked_turn = asyncio.create_task(session.turn(struct.pack("<f", 0.0)))
    for _ in range(100):
        if len(blocked.sent) == 2:
            break
        await asyncio.sleep(0)

    interrupted = await session.interrupt()
    blocked_result = await asyncio.gather(blocked_turn, return_exceptions=True)

    assert interrupted["state"] == "listening"
    assert interrupted["session_id"] == started["session_id"]
    assert isinstance(blocked_result[0], plugin_api.SmartSessionConflict)
    assert blocked.closed is True

    await session.turn(struct.pack("<f", 0.0))
    assert llm_messages[-1] == [
        {"role": "user", "content": "first user"},
        {"role": "assistant", "content": "answer 1"},
        {"role": "user", "content": "third user"},
    ]


@pytest.mark.asyncio
async def test_smart_clear_history_preserves_identity_prompts_server_and_next_turn_is_fresh(
    plugin_api, caplog
):
    existing = {
        "state": "external", "running": True, "managed": False,
        "configured": True, "message": "external",
    }
    manager = FakeServerManager(existing)
    upstreams = [
        FakeSmartUpstream([{
            "type": "response.done",
            "text": "Original sentence: first cleaned user",
        }]),
        FakeSmartUpstream([{
            "type": "response.done",
            "text": "The transcription of the given speech is: second cleaned user",
        }]),
    ]
    llm_messages = []
    broker = plugin_api.EventBroker()
    subscriber = broker.subscribe()

    async def connect(*_args, **_kwargs):
        return upstreams.pop(0)

    async def llm(**kwargs):
        llm_messages.append(kwargs["messages"])
        return f"answer {len(llm_messages)}"

    async def no_audio(_text):
        raise RuntimeError("speech unavailable")

    session = plugin_api.SmartMiniCPMSession(
        server_manager=manager,
        connector=connect,
        close_session_request=lambda *_args: asyncio.sleep(0),
        llm_caller=llm,
        tts_caller=no_audio,
        events=broker,
    )
    started = await session.start("  coach prompt stays exact  ", "  input prompt stays exact  ")
    first_result = await session.turn(struct.pack("<f", 0.0))
    first_event = subscriber.get_nowait()
    before_clear = session.snapshot()

    cleared = await session.clear_history()
    cleared_again = await session.clear_history()

    assert first_result["user_text"] == "first cleaned user"
    assert first_event["type"] == "smart.user_text"
    assert first_event["text"] == "first cleaned user"
    assert cleared == cleared_again == before_clear == started
    assert session._history == []
    assert session._gpt_system_prompt == "  coach prompt stays exact  "
    assert session._minicpm_input_prompt == "  input prompt stays exact  "
    assert session._owns_server is False
    assert manager.stop_calls == 0

    second_result = await session.turn(struct.pack("<f", 0.0))
    second_event = subscriber.get_nowait()
    assert second_result["user_text"] == "second cleaned user"
    assert second_event["type"] == "smart.user_text"
    assert second_event["text"] == "second cleaned user"
    assert llm_messages == [
        [
            {"role": "system", "content": "  coach prompt stays exact  "},
            {"role": "user", "content": "first cleaned user"},
        ],
        [
            {"role": "system", "content": "  coach prompt stays exact  "},
            {"role": "user", "content": "second cleaned user"},
        ],
    ]
    assert session._history == [("second cleaned user", "answer 2")]
    assert manager.stop_calls == 0
    assert "Original sentence:" not in caplog.text
    assert "The transcription of the given speech is:" not in caplog.text


@pytest.mark.asyncio
async def test_smart_clear_history_conflicts_during_turn_and_works_stopped(plugin_api):
    session = plugin_api.SmartMiniCPMSession(server_manager=FakeServerManager({}))
    session._history = [("stopped user", "stopped assistant")]

    stopped_before = session.snapshot()
    assert await session.clear_history() == stopped_before
    assert session._history == []

    active_turn = asyncio.create_task(asyncio.sleep(60))
    session._active_turn_task = active_turn
    session._history = [("must survive conflict", "answer")]
    try:
        with pytest.raises(plugin_api.SmartSessionConflict):
            await session.clear_history()
        assert session._history == [("must survive conflict", "answer")]
        assert session.snapshot()["turn_active"] is True
    finally:
        active_turn.cancel()
        await asyncio.gather(active_turn, return_exceptions=True)


class RouteSmartSession:
    def __init__(self, plugin_api):
        self.plugin_api = plugin_api
        self.starts = []
        self.turns = []
        self.interrupts = 0
        self.clears = 0
        self.stops = 0
        self.turn_error = None
        self.clear_error = None

    async def start(self, gpt_prompt, input_prompt, model_provider="", model_name=""):
        self.starts.append((gpt_prompt, input_prompt, model_provider, model_name))
        return {"state": "listening", "session_id": "smart-1", "generation": 1}

    async def turn(self, raw):
        self.turns.append(raw)
        if self.turn_error:
            raise self.turn_error
        return {
            "state": "listening", "session_id": "smart-1", "generation": 1,
            "turn_id": "turn-1", "user_text": "user", "assistant_text": "answer",
            "audio_base64": None, "sample_rate": None, "warning": "voice failed",
        }

    async def interrupt(self):
        self.interrupts += 1
        return {"state": "listening", "session_id": "smart-1", "generation": 1}

    async def clear_history(self):
        self.clears += 1
        if self.clear_error:
            raise self.clear_error
        return {"state": "listening", "session_id": "smart-1", "generation": 1}

    async def stop(self):
        self.stops += 1
        return {"state": "stopped", "session_id": None, "generation": 2}


@pytest.mark.asyncio
async def test_smart_rest_is_strict_and_maps_private_failures_to_generic_errors(
    plugin_api, monkeypatch
):
    fake = RouteSmartSession(plugin_api)
    monkeypatch.setattr(plugin_api, "smart_session", fake)
    app = FastAPI()
    app.include_router(plugin_api.router)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        started = await client.post("/smart/session/start", json={
            "gpt_system_prompt": "  GPT  ", "minicpm_input_prompt": "  INPUT  ",
        })
        extra_start = await client.post("/smart/session/start", json={
            "gpt_system_prompt": "", "minicpm_input_prompt": "input", "extra": True,
        })
        blank_input = await client.post("/smart/session/start", json={
            "gpt_system_prompt": "", "minicpm_input_prompt": " \n ",
        })
        wrong_media = await client.post(
            "/smart/turn", files={"file": ("turn.pcm", b"\0" * 4, "audio/wav")}
        )
        extra_form = await client.post("/smart/turn", files={
            "file": ("turn.pcm", b"\0" * 4, "application/octet-stream"),
            "extra": (None, "value"),
        })
        valid_turn = await client.post(
            "/smart/turn",
            files={"file": ("turn.pcm", b"\0" * 4, "application/octet-stream")},
        )
        extra_interrupt = await client.post(
            "/smart/session/interrupt", json={"extra": True}
        )
        interrupted = await client.post("/smart/session/interrupt", json={})
        extra_clear = await client.post(
            "/smart/session/clear-history", json={"extra": True}
        )
        cleared = await client.post("/smart/session/clear-history", json={})
        fake.clear_error = plugin_api.SmartSessionConflict("private active turn")
        clear_conflict = await client.post("/smart/session/clear-history", json={})
        stopped = await client.post("/smart/session/stop", json={})

        fake.turn_error = plugin_api.SmartStageError("input stage failed")
        input_failed = await client.post(
            "/smart/turn",
            files={"file": ("turn.pcm", b"\0" * 4, "application/octet-stream")},
        )
        fake.turn_error = plugin_api.SmartStageError("reasoning stage failed")
        reasoning_failed = await client.post(
            "/smart/turn",
            files={"file": ("turn.pcm", b"\0" * 4, "application/octet-stream")},
        )
        fake.turn_error = plugin_api.SmartStageError("private prompt and model text")
        failed = await client.post(
            "/smart/turn",
            files={"file": ("turn.pcm", b"\0" * 4, "application/octet-stream")},
        )
        fake.turn_error = RuntimeError("unexpected private dependency detail")
        unexpected = await client.post(
            "/smart/turn",
            files={"file": ("turn.pcm", b"\0" * 4, "application/octet-stream")},
        )

    assert started.status_code == 200
    assert fake.starts == [("  GPT  ", "  INPUT  ", "", "")]
    assert extra_start.status_code == blank_input.status_code == 422
    assert wrong_media.status_code == 415
    assert extra_form.status_code == 422
    assert valid_turn.status_code == 200
    assert extra_interrupt.status_code == 422
    assert extra_clear.status_code == 422
    assert interrupted.status_code == stopped.status_code == 200
    assert cleared.status_code == 200
    assert cleared.json() == {
        "state": "listening", "session_id": "smart-1", "generation": 1
    }
    assert clear_conflict.status_code == 409
    assert "private" not in clear_conflict.text
    assert fake.interrupts == fake.stops == 1
    assert fake.clears == 2
    assert input_failed.status_code == reasoning_failed.status_code == 502
    assert input_failed.json() == {"detail": "Smart input failed."}
    assert reasoning_failed.json() == {"detail": "Smart reasoning failed."}
    assert failed.status_code == 502
    assert failed.json() == {"detail": "Smart turn failed."}
    assert "private" not in failed.text
    assert unexpected.status_code == 502
    assert "private" not in unexpected.text


def test_smart_production_and_docs_reject_prohibited_paths_and_hidden_prompt():
    root = Path(__file__).parents[1]
    production_files = [
        root / "dashboard" / "plugin_api.py",
        root / "desktop" / "plugin.js",
        root / "README.md",
        root / "ARCHITECTURE.md",
        root / "MAINTENANCE.md",
    ]
    combined = "\n".join(path.read_text(encoding="utf-8") for path in production_files).lower()
    for forbidden in ("whisper", "edge tts", "edgetts"):
        assert forbidden not in combined

    desktop = (root / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert "storage.get(MINICPM_INPUT_PROMPT_KEY, '')" in desktop
    assert "if (!validatedInputPrompt.trim())" in desktop
    backend = (root / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
    assert "minicpm_input_prompt: str\n" in backend
    assert "minicpm_input_prompt: str =" not in backend
