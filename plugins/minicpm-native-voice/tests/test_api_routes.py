from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


class RouteBridge:
    def __init__(self, plugin_api):
        self.plugin_api = plugin_api
        self.starts = []
        self.turns = []
        self.stops = 0
        self.state = "shell_ready"
        self.session_id = None
        self._starting = False

    def snapshot(self):
        return {
            "state": self.state,
            "session_id": self.session_id,
            "turn_id": None,
            "metrics": {"generated_text_chars": 0, "event_queue_overflows": 0, "subscribers": 0},
        }

    async def start_session(self, prompt, *, port=None):
        self.starts.append((prompt, port))
        return self.snapshot()

    async def submit_turn(self, raw):
        self.turns.append(raw)
        return self.snapshot()

    async def stop(self):
        self.stops += 1
        return self.snapshot()


class RouteServerManager:
    def __init__(self, order):
        self.order = order
        self.start_error = None
        self.stop_error = None
        self.public = {
            "configured": True,
            "state": "stopped",
            "running": False,
            "managed": False,
            "message": "Managed server is stopped.",
        }

    async def status(self):
        self.order.append("server.status")
        return dict(self.public)

    async def start(self):
        self.order.append("server.start")
        if self.start_error is not None:
            raise self.start_error
        return {
            **self.public,
            "state": "ready",
            "running": True,
            "managed": True,
            "pid": 1234,
            "message": "Managed server is ready.",
        }

    async def stop(self):
        self.order.append("server.stop")
        if self.stop_error is not None:
            raise self.stop_error
        return dict(self.public)


@pytest.fixture
def api_client(plugin_api, monkeypatch):
    fake = RouteBridge(plugin_api)
    order = []
    server = RouteServerManager(order)
    original_stop = fake.stop

    async def ordered_bridge_stop():
        order.append("bridge.stop")
        return await original_stop()

    fake.stop = ordered_bridge_stop
    fake.server = server
    fake.order = order
    monkeypatch.setattr(plugin_api, "bridge", fake)
    monkeypatch.setattr(plugin_api, "server_manager", server, raising=False)
    app = FastAPI()
    app.include_router(plugin_api.router)
    return fake, AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_session_start_forwards_exact_prompt_and_strict_port(api_client):
    fake, client = api_client
    marker = "  MARKER\n exact  "
    async with client:
        response = await client.post("/session/start", json={"system_prompt": marker, "port": 19060})
        coerced = await client.post("/session/start", json={"system_prompt": marker, "port": "9060"})

    assert response.status_code == 200
    assert fake.starts == [(marker, 19060)]
    assert coerced.status_code == 422


@pytest.mark.asyncio
async def test_session_start_enforces_exact_utf8_prompt_ceiling_before_bridge(api_client):
    fake, client = api_client
    exact = " \n" + "é" * 32_766 + "  "
    oversized = exact + "x"
    assert len(exact.encode("utf-8")) == fake.plugin_api.MAX_SYSTEM_PROMPT_BYTES
    assert len(oversized.encode("utf-8")) == fake.plugin_api.MAX_SYSTEM_PROMPT_BYTES + 1

    async with client:
        accepted = await client.post("/session/start", json={"system_prompt": exact})
        rejected = await client.post("/session/start", json={"system_prompt": oversized})

    assert accepted.status_code == 200
    assert rejected.status_code == 422
    assert fake.starts == [(exact, None)]


@pytest.mark.asyncio
async def test_turn_route_rejects_oversize_before_bridge_encoding(api_client):
    fake, client = api_client
    async with client:
        response = await client.post(
            "/turn",
            files={"file": ("turn.pcm", b"\0" * (5_242_880 + 1), "application/octet-stream")},
        )

    assert response.status_code == 413
    assert fake.turns == []


@pytest.mark.asyncio
async def test_turn_route_rejects_invalid_float32_and_accepts_valid_bytes(api_client):
    fake, client = api_client
    async with client:
        invalid = await client.post(
            "/turn", files={"file": ("turn.pcm", b"\0\0\0", "application/octet-stream")}
        )
        valid = await client.post(
            "/turn", files={"file": ("turn.pcm", b"\0\0\0\0", "application/octet-stream")}
        )

    assert invalid.status_code == 400
    assert valid.status_code == 200
    assert fake.turns == [b"\0\0\0\0"]


@pytest.mark.asyncio
async def test_turn_route_rejects_wrong_or_missing_upload_content_type(api_client):
    fake, client = api_client
    boundary = "minicpm-native-voice-test-boundary"
    missing_type_body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="turn.pcm"\r\n'
        "\r\n"
    ).encode() + b"\0\0\0\0" + f"\r\n--{boundary}--\r\n".encode()

    async with client:
        wrong = await client.post(
            "/turn", files={"file": ("turn.pcm", b"\0\0\0\0", "audio/wav")}
        )
        missing = await client.post(
            "/turn",
            content=missing_type_body,
            headers={"content-type": f"multipart/form-data; boundary={boundary}"},
        )

    assert wrong.status_code == 415
    assert missing.status_code == 415
    assert wrong.json()["detail"] == "file must use application/octet-stream"
    assert missing.json()["detail"] == "file must use application/octet-stream"
    assert fake.turns == []


@pytest.mark.asyncio
async def test_conflicts_are_http_409(plugin_api, api_client, monkeypatch):
    fake, client = api_client

    async def conflict(_prompt, *, port=None):
        raise plugin_api.BridgeConflict("a voice session is already active")

    monkeypatch.setattr(fake, "start_session", conflict)
    async with client:
        response = await client.post("/session/start", json={"system_prompt": ""})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_status_has_stable_public_snapshot_and_stop_is_exposed(api_client):
    fake, client = api_client
    async with client:
        status = await client.get("/status")
        stopped = await client.post("/session/stop")

    assert status.status_code == 200
    assert status.json()["session_id"] is None
    assert "system_prompt" not in status.text
    assert stopped.status_code == 200
    assert fake.stops == 1


@pytest.mark.asyncio
async def test_health_distinguishes_unreachable_shell_and_explicit_model_ready(
    plugin_api, api_client, monkeypatch
):
    _fake, client = api_client

    async def unreachable(_port):
        return {"reachable": False, "state": "unreachable"}

    monkeypatch.setattr(plugin_api, "probe_upstream_health", unreachable)
    async with client:
        down = await client.get("/health")

    async def shell(_port):
        return {"reachable": True, "state": "shell_ready", "payload": {"status": "ok"}}

    monkeypatch.setattr(plugin_api, "probe_upstream_health", shell)
    async with AsyncClient(transport=client._transport, base_url="http://test") as second:
        up = await second.get("/health")

    async def ready(_port):
        return {"reachable": True, "state": "ready", "payload": {"model_state": "ready"}}

    monkeypatch.setattr(plugin_api, "probe_upstream_health", ready)
    async with AsyncClient(transport=client._transport, base_url="http://test") as third:
        model = await third.get("/health")

    assert down.json()["state"] == "unreachable"
    assert up.json()["state"] == "shell_ready"
    assert model.json()["state"] == "ready"


@pytest.mark.asyncio
async def test_server_status_start_and_stop_routes_return_only_public_status(api_client):
    fake, client = api_client
    async with client:
        current = await client.get("/server/status")
        started = await client.post("/server/start")
        stopped = await client.post("/server/stop")

    assert current.status_code == started.status_code == stopped.status_code == 200
    assert set(current.json()) == {"configured", "state", "running", "managed", "message"}
    assert set(started.json()) == {
        "configured", "state", "running", "managed", "pid", "message"
    }
    assert fake.order[-2:] == ["bridge.stop", "server.stop"]
    combined = current.text + started.text + stopped.text
    for forbidden in ("--host", "system_prompt", "server.local", "working_directory"):
        assert forbidden not in combined


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error_factory", "expected_status"),
    [
        (lambda api: api.ServerConfigurationError("private path"), 400),
        (lambda api: api.ServerConflictError("private process"), 409),
        (lambda api: api.ServerStartError("private argv"), 502),
        (lambda api: api.ServerStartupTimeout("private timeout"), 504),
    ],
)
async def test_server_start_route_maps_controlled_errors_without_private_details(
    plugin_api, api_client, error_factory, expected_status
):
    fake, client = api_client
    fake.server.start_error = error_factory(plugin_api)

    async with client:
        response = await client.post("/server/start")

    assert response.status_code == expected_status
    assert "private" not in response.text


@pytest.mark.asyncio
async def test_server_stop_releases_bridge_before_manager_even_when_bridge_stop_fails(
    plugin_api, api_client, monkeypatch
):
    fake, client = api_client

    async def failing_bridge_stop():
        fake.order.append("bridge.stop")
        raise RuntimeError("voice cleanup failed")

    monkeypatch.setattr(fake, "stop", failing_bridge_stop)
    async with client:
        response = await client.post("/server/stop")

    assert response.status_code == 502
    assert fake.order[-1:] == ["bridge.stop"]
    assert "server.stop" not in fake.order


@pytest.mark.asyncio
async def test_plugin_lifespan_stops_bridge_then_server_best_effort(plugin_api, monkeypatch):
    order = []

    class FailingBridge:
        async def stop(self):
            order.append("bridge.stop")
            raise RuntimeError("ignored bridge failure")

    class Server:
        async def stop(self):
            order.append("server.stop")
            raise RuntimeError("ignored server failure")

    monkeypatch.setattr(plugin_api, "bridge", FailingBridge())
    monkeypatch.setattr(plugin_api, "server_manager", Server(), raising=False)

    async with plugin_api._plugin_lifespan(None):
        pass

    assert order == ["bridge.stop", "server.stop"]
