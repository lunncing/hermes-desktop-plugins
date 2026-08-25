from __future__ import annotations

import asyncio
import builtins
import json

import pytest
import websockets


class FakeUpstream:
    def __init__(self, first_event=None):
        self.first_event = first_event or {
            "type": "session.created",
            "session_id": "session-1",
            "mode": "turn_based",
        }
        self.incoming = asyncio.Queue()
        self.sent = []
        self.closed = False

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def recv(self):
        return json.dumps(self.first_event)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.incoming.get()
        if item is StopAsyncIteration:
            raise StopAsyncIteration
        if isinstance(item, BaseException):
            raise item
        return json.dumps(item)

    async def close(self):
        self.closed = True

    async def push(self, event):
        await self.incoming.put(event)


class FakeEventSocket:
    def __init__(self):
        self.accepted = False
        self.closed = None
        self.sent = []
        self.query_params = {}

    async def accept(self):
        self.accepted = True

    async def close(self, code=None):
        self.closed = code

    async def send_json(self, event):
        self.sent.append(event)

    async def receive(self):
        return {"type": "websocket.disconnect"}


@pytest.mark.asyncio
async def test_event_subscriber_count_overflow_is_explicit(plugin_api):
    broker = plugin_api.EventBroker(maxsize=2)
    queue = broker.subscribe()

    await broker.publish({"type": "one"})
    await broker.publish({"type": "two"})
    await broker.publish({"type": "three"})

    assert queue.maxsize == 2
    assert queue.get_nowait()["type"] == "error"
    assert queue.empty()
    assert broker.overflow_count == 1
    broker.unsubscribe(queue)
    assert broker.subscriber_count == 0


@pytest.mark.asyncio
async def test_event_subscriber_byte_overflow_is_explicit_and_does_not_reorder(plugin_api):
    broker = plugin_api.EventBroker(maxsize=8, max_bytes=180)
    queue = broker.subscribe()

    await broker.publish({"type": "text.delta", "text": "a" * 80})
    await broker.publish({"type": "text.delta", "text": "b" * 80})
    await broker.publish({"type": "response.done", "text": "must not pass overflow"})

    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    assert [event["type"] for event in events] == ["error"]
    assert events[0]["code"] == "subscriber_queue_overflow"
    assert broker.overflow_count == 1
    assert queue.queued_bytes <= 180


@pytest.mark.asyncio
async def test_session_connector_disables_keepalive_without_weakening_bounds(plugin_api):
    upstream = FakeUpstream()
    captured = {}

    async def connect(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return upstream

    async def no_http_close(_session_id, _port):
        return None

    bridge = plugin_api.VoiceBridge(
        connector=connect,
        close_session_request=no_http_close,
    )
    await bridge.start_session("")
    try:
        assert captured == {
            "url": "ws://127.0.0.1:9060/backend",
            "kwargs": {
                "open_timeout": 10,
                "close_timeout": 2,
                "max_size": plugin_api.MAX_GENERATED_AUDIO_BYTES * 2,
                "max_queue": 8,
                "ping_interval": None,
                "ping_timeout": None,
            },
        }
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_exact_prompt_is_sent_but_never_retained_in_bridge_state(plugin_api):
    upstream = FakeUpstream()
    marker = "  PRIVATE PROMPT MARKER\nexact  "

    async def connect(_url, **_kwargs):
        return upstream

    bridge = plugin_api.VoiceBridge(connector=connect)
    await bridge.start_session(marker)

    assert upstream.sent[0]["payload"]["system_prompt"] == marker
    assert "system_prompt" not in bridge.__dict__

    await bridge.stop()
    assert "system_prompt" not in bridge.__dict__


@pytest.mark.asyncio
async def test_failed_start_does_not_retain_prompt(plugin_api):
    marker = "FAILED START PRIVATE PROMPT"

    async def connect(_url, **_kwargs):
        raise RuntimeError("connection failed")

    bridge = plugin_api.VoiceBridge(connector=connect)

    with pytest.raises(plugin_api.BridgeUpstreamError, match="connection failed"):
        await bridge.start_session(marker)

    assert "system_prompt" not in bridge.__dict__


@pytest.mark.asyncio
async def test_cancelled_partial_start_does_not_retain_prompt(plugin_api):
    marker = "CANCELLED START PRIVATE PROMPT"
    connect_entered = asyncio.Event()

    async def connect(_url, **_kwargs):
        connect_entered.set()
        await asyncio.Future()

    bridge = plugin_api.VoiceBridge(connector=connect)
    start_task = asyncio.create_task(bridge.start_session(marker))
    await connect_entered.wait()

    await bridge.stop()
    result = await asyncio.gather(start_task, return_exceptions=True)

    assert isinstance(result[0], asyncio.CancelledError)
    assert bridge.snapshot()["state"] == "shell_ready"
    assert "system_prompt" not in bridge.__dict__


@pytest.mark.asyncio
async def test_second_active_session_and_turn_are_rejected(plugin_api):
    upstream = FakeUpstream()

    async def connect(_url, **_kwargs):
        return upstream

    bridge = plugin_api.VoiceBridge(connector=connect)
    await bridge.start_session(" marker ")
    with pytest.raises(plugin_api.BridgeConflict, match="session"):
        await bridge.start_session("another")

    await bridge.submit_turn(b"\0\0\0\0")
    with pytest.raises(plugin_api.BridgeConflict, match="turn"):
        await bridge.submit_turn(b"\0\0\0\0")
    await bridge.stop()


@pytest.mark.asyncio
async def test_upstream_events_are_forwarded_in_order_with_audio_rate_fallback(plugin_api):
    upstream = FakeUpstream()

    async def connect(_url, **_kwargs):
        return upstream

    bridge = plugin_api.VoiceBridge(connector=connect)
    await bridge.start_session("")
    queue = bridge.events.subscribe()
    await bridge.submit_turn(b"\0\0\0\0")
    await upstream.push({"type": "response.output.delta", "kind": "text", "text": "Hi"})
    await upstream.push({"type": "response.output.delta", "kind": "audio", "audio": "AAAAAA=="})
    await upstream.push({"type": "response.done", "response_id": "r1", "text": "Hi"})

    seen = []
    while not any(event["type"] == "response.done" for event in seen):
        seen.append(await asyncio.wait_for(queue.get(), timeout=1))

    forwarded = [event for event in seen if event["type"] in {"text.delta", "audio.delta", "response.done"}]
    assert [event["type"] for event in forwarded] == ["text.delta", "audio.delta", "response.done"]
    assert forwarded[1]["sample_rate"] == 24_000
    assert all(event["session_id"] == "session-1" for event in forwarded)
    assert all(event["generation"] == bridge.snapshot()["generation"] for event in forwarded)
    assert [event["seq"] for event in forwarded] == sorted(event["seq"] for event in forwarded)
    assert bridge.snapshot()["turn_id"] is None
    assert bridge.snapshot()["state"] == "listening"
    bridge.events.unsubscribe(queue)
    await bridge.stop()


@pytest.mark.asyncio
async def test_text_delta_is_truncated_to_remaining_utf8_allowance(plugin_api):
    upstream = FakeUpstream()

    async def connect(_url, **_kwargs):
        return upstream

    bridge = plugin_api.VoiceBridge(connector=connect)
    await bridge.start_session("")
    queue = bridge.events.subscribe()
    await bridge.submit_turn(b"\0\0\0\0")
    bridge.current_text = "a" * (plugin_api.TRANSCRIPT_MAX_BYTES - 2)
    bridge.current_text_bytes = plugin_api.TRANSCRIPT_MAX_BYTES - 2

    await upstream.push({"type": "response.output.delta", "kind": "text", "text": "éZ"})
    event = None
    while event is None:
        candidate = await asyncio.wait_for(queue.get(), timeout=1)
        if candidate["type"] == "text.delta":
            event = candidate

    assert event["text"] == "é"
    assert len(bridge.current_text.encode("utf-8")) == plugin_api.TRANSCRIPT_MAX_BYTES
    bridge.events.unsubscribe(queue)
    await bridge.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("audio", ["not base64!", "AAAA", "AAAAAAA="])
async def test_invalid_or_unaligned_audio_delta_fails_controlled(plugin_api, audio):
    upstream = FakeUpstream()
    close_calls = []

    async def connect(_url, **_kwargs):
        return upstream

    async def close_session(session_id, port):
        close_calls.append((session_id, port))

    bridge = plugin_api.VoiceBridge(
        connector=connect, close_session_request=close_session
    )
    await bridge.start_session("")
    queue = bridge.events.subscribe()
    await bridge.submit_turn(b"\0\0\0\0")
    await upstream.push({"type": "response.output.delta", "kind": "audio", "audio": audio})

    error = None
    while error is None:
        candidate = await asyncio.wait_for(queue.get(), timeout=1)
        if candidate["type"] == "error":
            error = candidate
    assert error["code"] == "invalid_audio_delta"
    assert bridge.snapshot()["state"] == "error"
    assert close_calls == [("session-1", 9060)]
    assert upstream.closed is True
    bridge.events.unsubscribe(queue)


@pytest.mark.asyncio
async def test_audio_turn_over_budget_stops_instead_of_forwarding(plugin_api, monkeypatch):
    monkeypatch.setattr(plugin_api, "MAX_GENERATED_AUDIO_BYTES", 8)
    upstream = FakeUpstream()
    close_calls = []

    async def connect(_url, **_kwargs):
        return upstream

    async def close_session(session_id, port):
        close_calls.append((session_id, port))

    bridge = plugin_api.VoiceBridge(
        connector=connect, close_session_request=close_session
    )
    await bridge.start_session("")
    queue = bridge.events.subscribe()
    await bridge.submit_turn(b"\0\0\0\0")
    await upstream.push({"type": "response.output.delta", "kind": "audio", "audio": "AAAAAAAAAAA="})
    await upstream.push({"type": "response.output.delta", "kind": "audio", "audio": "AAAAAAAAAAA="})

    seen = []
    while not any(event["type"] == "error" for event in seen):
        seen.append(await asyncio.wait_for(queue.get(), timeout=1))
    assert [event["type"] for event in seen].count("audio.delta") == 1
    assert next(event for event in seen if event["type"] == "error")["code"] == "audio_turn_budget_exceeded"
    assert close_calls == [("session-1", 9060)]
    assert upstream.closed is True
    bridge.events.unsubscribe(queue)


@pytest.mark.asyncio
async def test_upstream_error_broadcasts_error_and_cleans_active_state(plugin_api):
    upstream = FakeUpstream()
    cleanup_order = []
    original_close = upstream.close

    async def connect(_url, **_kwargs):
        return upstream

    async def close_session(session_id, port):
        cleanup_order.append(("session", session_id, port))

    async def close_upstream():
        cleanup_order.append(("socket",))
        await original_close()

    upstream.close = close_upstream
    bridge = plugin_api.VoiceBridge(
        connector=connect, close_session_request=close_session
    )
    await bridge.start_session("", port=9876)
    queue = bridge.events.subscribe()
    await bridge.submit_turn(b"\0\0\0\0")
    await upstream.push(RuntimeError("upstream broke"))

    error = None
    while error is None:
        event = await asyncio.wait_for(queue.get(), timeout=1)
        if event["type"] == "error":
            error = event

    assert "upstream broke" in error["message"]
    assert bridge.snapshot()["state"] == "error"
    assert bridge.snapshot()["session_id"] is None
    assert bridge.snapshot()["turn_id"] is None
    assert cleanup_order == [("session", "session-1", 9876), ("socket",)]
    assert upstream.closed is True
    bridge.events.unsubscribe(queue)


@pytest.mark.asyncio
async def test_unexpected_upstream_close_invokes_session_close_operation(plugin_api):
    upstream = FakeUpstream()
    close_calls = []

    async def connect(_url, **_kwargs):
        return upstream

    async def close_session(session_id, port):
        close_calls.append((session_id, port))

    bridge = plugin_api.VoiceBridge(
        connector=connect, close_session_request=close_session
    )
    await bridge.start_session("")
    queue = bridge.events.subscribe()

    await upstream.push(StopAsyncIteration)
    while True:
        event = await asyncio.wait_for(queue.get(), timeout=1)
        if event["type"] == "error":
            break

    assert event["code"] == "upstream_closed"
    assert close_calls == [("session-1", 9060)]
    assert upstream.closed is True
    bridge.events.unsubscribe(queue)


@pytest.mark.asyncio
async def test_turn_submission_failure_invokes_session_close_operation(plugin_api):
    upstream = FakeUpstream()
    close_calls = []

    async def connect(_url, **_kwargs):
        return upstream

    async def close_session(session_id, port):
        close_calls.append((session_id, port))

    bridge = plugin_api.VoiceBridge(
        connector=connect, close_session_request=close_session
    )
    await bridge.start_session("")

    async def fail_send(_raw):
        raise RuntimeError("turn send failed")

    upstream.send = fail_send
    with pytest.raises(plugin_api.BridgeUpstreamError, match="turn send failed"):
        await bridge.submit_turn(b"\0\0\0\0")

    assert close_calls == [("session-1", 9060)]
    assert upstream.closed is True
    assert bridge.snapshot()["state"] == "error"


@pytest.mark.asyncio
async def test_stop_is_idempotent_closes_resources_and_broadcasts(plugin_api):
    upstream = FakeUpstream()
    close_calls = []

    async def connect(_url, **_kwargs):
        return upstream

    async def close_session(session_id, port):
        close_calls.append((session_id, port))

    bridge = plugin_api.VoiceBridge(connector=connect, close_session_request=close_session)
    await bridge.start_session("")
    queue = bridge.events.subscribe()
    reader = bridge.reader_task

    await bridge.stop()
    await bridge.stop()

    assert close_calls == [("session-1", 9060)]
    assert upstream.closed is True
    assert reader.done()
    assert bridge.snapshot()["state"] == "shell_ready"
    assert bridge.snapshot()["session_id"] is None
    stopped = [event for event in list(queue._queue) if event.get("reason") == "stopped"]
    assert len(stopped) == 1
    bridge.events.unsubscribe(queue)


@pytest.mark.asyncio
async def test_concurrent_stop_callers_share_cleanup_and_start_conflicts_while_stopping(plugin_api):
    upstream = FakeUpstream()
    close_entered = asyncio.Event()
    release_close = asyncio.Event()
    close_calls = 0

    async def connect(_url, **_kwargs):
        return upstream

    async def close_session(_session_id, _port):
        nonlocal close_calls
        close_calls += 1
        close_entered.set()
        await release_close.wait()

    bridge = plugin_api.VoiceBridge(connector=connect, close_session_request=close_session)
    await bridge.start_session("")
    first = asyncio.create_task(bridge.stop())
    await close_entered.wait()
    second = asyncio.create_task(bridge.stop())
    await asyncio.sleep(0)

    assert second.done() is False
    with pytest.raises(plugin_api.BridgeConflict, match="stopping"):
        await bridge.start_session("new")

    release_close.set()
    await asyncio.gather(first, second)
    assert close_calls == 1


@pytest.mark.asyncio
async def test_stale_reader_event_after_restart_cannot_mutate_new_session(plugin_api):
    upstreams = [
        FakeUpstream({"type": "session.created", "session_id": "old", "mode": "turn_based"}),
        FakeUpstream({"type": "session.created", "session_id": "new", "mode": "turn_based"}),
    ]

    async def connect(_url, **_kwargs):
        return upstreams.pop(0)

    async def no_http_close(_session_id, _port):
        return None

    bridge = plugin_api.VoiceBridge(connector=connect, close_session_request=no_http_close)
    await bridge.start_session("")
    old_generation = bridge.snapshot()["generation"]
    await bridge.stop()
    await bridge.start_session("")
    queue = bridge.events.subscribe()

    await bridge._handle_upstream_event(
        {"type": "response.output.delta", "kind": "text", "text": "STALE"},
        generation=old_generation,
        session_id="old",
    )
    await asyncio.sleep(0)

    assert bridge.snapshot()["session_id"] == "new"
    assert bridge.current_text == ""
    assert not any(event.get("text") == "STALE" for event in list(queue._queue))
    bridge.events.unsubscribe(queue)
    await bridge.stop()


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"status": "ok"}, "shell_ready"),
        ({"state": "ok"}, "shell_ready"),
        ({"model_state": "loading"}, "loading"),
        ({"model_state": "ready"}, "ready"),
    ],
)
def test_health_never_calls_plain_ok_model_ready(plugin_api, payload, expected):
    assert plugin_api.classify_upstream_health(payload) == expected


@pytest.mark.asyncio
async def test_event_websocket_disconnect_always_removes_subscriber(plugin_api, monkeypatch):
    bridge = plugin_api.VoiceBridge()
    socket = FakeEventSocket()
    monkeypatch.setattr(plugin_api, "bridge", bridge)
    monkeypatch.setattr(plugin_api, "_ws_upgrade_authorized", lambda _ws: True)

    await plugin_api.stream_events(socket)

    assert socket.accepted is True
    assert bridge.events.subscriber_count == 0


@pytest.mark.asyncio
async def test_event_websocket_denial_closes_without_accepting_or_subscribing(
    plugin_api, monkeypatch
):
    bridge = plugin_api.VoiceBridge()
    socket = FakeEventSocket()
    monkeypatch.setattr(plugin_api, "bridge", bridge)
    monkeypatch.setattr(plugin_api, "_ws_upgrade_authorized", lambda _ws: False)

    await plugin_api.stream_events(socket)

    assert socket.closed == 1008
    assert socket.accepted is False
    assert bridge.events.subscriber_count == 0


@pytest.mark.asyncio
async def test_event_websocket_unavailable_auth_closes_without_accepting_or_subscribing(
    plugin_api, monkeypatch
):
    bridge = plugin_api.VoiceBridge()
    socket = FakeEventSocket()
    real_import = builtins.__import__

    def import_without_hermes(name, *args, **kwargs):
        if name == "hermes_cli":
            raise ImportError("Hermes auth unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(plugin_api, "bridge", bridge)
    monkeypatch.setattr(builtins, "__import__", import_without_hermes)

    await plugin_api.stream_events(socket)

    assert socket.closed == 1008
    assert socket.accepted is False
    assert bridge.events.subscriber_count == 0


@pytest.mark.asyncio
async def test_real_loopback_fake_upstream_receives_native_audio_and_streams_in_order(plugin_api):
    received = []

    async def handler(socket):
        received.append(json.loads(await socket.recv()))
        await socket.send(json.dumps({"type": "session.created", "session_id": "loopback-1", "mode": "turn_based"}))
        received.append(json.loads(await socket.recv()))
        await socket.send(json.dumps({"type": "response.output.delta", "kind": "text", "text": "A"}))
        await socket.send(json.dumps({"type": "response.output.delta", "kind": "audio", "audio": "AAAAAA==", "sample_rate": 16000}))
        await socket.send(json.dumps({"type": "response.done", "response_id": "r1", "text": "A"}))
        await socket.wait_closed()

    async def no_http_close(_session_id, _port):
        return None

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        bridge = plugin_api.VoiceBridge(close_session_request=no_http_close)
        await bridge.start_session("  LOOPBACK MARKER  ", port=port)
        queue = bridge.events.subscribe()
        await bridge.submit_turn(b"\0\0\0\0")
        forwarded = []
        while not any(event["type"] == "response.done" for event in forwarded):
            forwarded.append(await asyncio.wait_for(queue.get(), timeout=1))

        assert received[0]["payload"]["system_prompt"] == "  LOOPBACK MARKER  "
        content = received[1]["input"]["messages"][-1]["content"]
        assert content == [{"type": "audio", "data": "AAAAAA=="}]
        assert "text" not in json.dumps(received[1])
        assert [event["type"] for event in forwarded if event["type"] in {"text.delta", "audio.delta", "response.done"}] == [
            "text.delta", "audio.delta", "response.done"
        ]
        bridge.events.unsubscribe(queue)
        await bridge.stop()
