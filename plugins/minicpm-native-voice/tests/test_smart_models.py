from __future__ import annotations

from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@dataclass
class PickerContext:
    current_provider: str = "current-provider"
    current_model: str = "current-model"
    current_base_url: str = "https://central.invalid"


def test_inventory_adapter_uses_central_picker_policy(plugin_api):
    context = PickerContext()
    calls = []

    def load_context():
        calls.append(("context",))
        return context

    def build_aux_rows(**kwargs):
        calls.append(("aux", kwargs))
        return [{"slug": "normal", "name": "Normal", "models": ["cached"]}]

    def build_payload(received_context, **kwargs):
        calls.append(("payload", received_context, kwargs))
        return {
            "provider": context.current_provider,
            "model": context.current_model,
            "providers": [{"slug": "fresh", "name": "Fresh", "models": ["live"]}],
        }

    normal = plugin_api.load_smart_models_inventory(
        False,
        load_context=load_context,
        build_payload=build_payload,
        build_aux_rows=build_aux_rows,
    )
    refreshed = plugin_api.load_smart_models_inventory(
        True,
        load_context=load_context,
        build_payload=build_payload,
        build_aux_rows=build_aux_rows,
    )

    assert normal == {
        "provider": "current-provider",
        "model": "current-model",
        "providers": [{"slug": "normal", "name": "Normal", "models": ["cached"]}],
    }
    assert refreshed["providers"] == [
        {"slug": "fresh", "name": "Fresh", "models": ["live"]}
    ]
    assert calls == [
        ("context",),
        (
            "aux",
            {
                "current_provider": "current-provider",
                "current_model": "current-model",
                "current_base_url": "https://central.invalid",
                "max_models": 500,
            },
        ),
        ("context",),
        (
            "payload",
            context,
            {
                "for_picker": True,
                "refresh": True,
                "probe_custom_providers": True,
                "probe_current_custom_provider": False,
                "max_models": 500,
            },
        ),
    ]


def test_smart_models_catalog_is_exact_bounded_and_secret_free(plugin_api):
    provider_rows = [
        {
            "slug": "zeta",
            "name": "A" * 300,
            "models": ["model-b", "model-a", "model-a", "界" * 171],
            "key_env": "SECRET_ENV",
            "base_url": "https://secret.invalid",
            "api_key": "top-secret",
            "warnings": ["credential failed"],
            "pricing": {"model-a": "$1"},
        },
        {"slug": "moa", "name": "MoA", "models": ["fan-out"]},
        {
            "slug": "unavailable",
            "name": "Unavailable",
            "models": ["hidden"],
            "authenticated": False,
            "configured": False,
        },
        {
            "slug": "current-provider",
            "name": "Current Provider",
            "models": ["other-model"],
            "authenticated": False,
            "configured": False,
        },
        {"slug": "zeta", "name": "Ignored duplicate", "models": ["model-c"]},
    ]
    provider_rows.extend(
        {"slug": f"provider-{index:02d}", "name": f"Provider {index:02d}", "models": ["m"]}
        for index in range(70)
    )
    raw = {
        "provider": "current-provider",
        "model": "current-model",
        "providers": provider_rows,
        "api_key": "must not escape",
    }

    catalog = plugin_api.sanitize_smart_models_catalog(raw)

    assert set(catalog) == {"current", "providers"}
    assert catalog["current"] == {
        "provider": "current-provider",
        "model": "current-model",
    }
    assert len(catalog["providers"]) == 64
    assert catalog["providers"] == sorted(
        catalog["providers"], key=lambda row: (row["label"].casefold(), row["provider"])
    )
    current = next(
        row for row in catalog["providers"] if row["provider"] == "current-provider"
    )
    assert current["models"] == ["current-model", "other-model"]
    zeta = next(row for row in catalog["providers"] if row["provider"] == "zeta")
    assert zeta["models"] == ["model-a", "model-b", "model-c"]
    assert len(zeta["label"].encode("utf-8")) <= 256
    assert all(set(row) == {"provider", "label", "models"} for row in catalog["providers"])
    assert all(len(row["provider"].encode("utf-8")) <= 128 for row in catalog["providers"])
    assert all(len(row["models"]) <= 500 for row in catalog["providers"])
    assert all(
        len(model.encode("utf-8")) <= 512
        for row in catalog["providers"]
        for model in row["models"]
    )
    serialized = repr(catalog)
    for forbidden in (
        "SECRET_ENV",
        "secret.invalid",
        "top-secret",
        "credential failed",
        "api_key",
        "base_url",
        "key_env",
        "pricing",
        "warnings",
    ):
        assert forbidden not in serialized
    assert all(row["provider"] not in {"moa", "unavailable"} for row in catalog["providers"])

    current_moa = plugin_api.sanitize_smart_models_catalog(
        {
            "provider": "moa",
            "model": "fan-out",
            "providers": [{"slug": "moa", "name": "MoA", "models": ["fan-out"]}],
        }
    )
    assert current_moa["current"] == {"provider": "moa", "model": "fan-out"}
    assert current_moa["providers"] == []


@pytest.mark.asyncio
async def test_smart_models_route_injects_loader_refresh_and_generic_errors(
    plugin_api, monkeypatch
):
    refreshes = []

    def loader(refresh):
        refreshes.append(refresh)
        if len(refreshes) == 3:
            raise RuntimeError("api_key=must-not-leak")
        return {
            "provider": "provider",
            "model": "model",
            "providers": [{"slug": "provider", "name": "Provider", "models": ["model"]}],
        }

    monkeypatch.setattr(plugin_api, "smart_models_inventory_loader", loader)
    app = FastAPI()
    app.include_router(plugin_api.router)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        normal = await client.get("/smart/models")
        refreshed = await client.get("/smart/models?refresh=true")
        failed = await client.get("/smart/models")
        invalid = await client.get("/smart/models?refresh=maybe")
        extra = await client.get("/smart/models?extra=true")
        repeated = await client.get("/smart/models?refresh=true&refresh=false")
        wrong_method = await client.post("/smart/models", json={})

    expected = {
        "current": {"provider": "provider", "model": "model"},
        "providers": [{"provider": "provider", "label": "Provider", "models": ["model"]}],
    }
    assert normal.status_code == 200
    assert normal.json() == expected
    assert refreshed.status_code == 200
    assert refreshed.json() == expected
    assert refreshes == [False, True, False]
    assert failed.status_code == 502
    assert failed.json() == {"detail": "Model catalog is unavailable."}
    assert "api_key" not in failed.text
    assert invalid.status_code == 422
    assert extra.status_code == 422
    assert repeated.status_code == 422
    assert wrong_method.status_code == 405


@pytest.mark.asyncio
async def test_smart_start_validates_exact_current_catalog_pair_and_defaults_current(
    plugin_api, monkeypatch
):
    starts = []
    loads = []

    class FakeSmartSession:
        async def start(
            self, gpt_prompt, input_prompt, model_provider="", model_name=""
        ):
            starts.append((gpt_prompt, input_prompt, model_provider, model_name))
            return {"state": "listening", "session_id": "smart-1", "generation": 1}

    def loader(refresh):
        loads.append(refresh)
        return {
            "provider": "current",
            "model": "current-model",
            "providers": [
                {
                    "slug": "openrouter",
                    "name": "OpenRouter",
                    "models": ["lab/model", "other/model"],
                    "api_key": "must-not-leak",
                }
            ],
        }

    monkeypatch.setattr(plugin_api, "smart_session", FakeSmartSession())
    monkeypatch.setattr(plugin_api, "smart_models_inventory_loader", loader)
    app = FastAPI()
    app.include_router(plugin_api.router)

    base = {"gpt_system_prompt": "coach", "minicpm_input_prompt": "input"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        defaulted = await client.post("/smart/session/start", json=base)
        partial = await client.post(
            "/smart/session/start", json={**base, "model_provider": "openrouter"}
        )
        selected = await client.post(
            "/smart/session/start",
            json={
                **base,
                "model_provider": "openrouter",
                "model_name": "lab/model",
            },
        )
        stale = await client.post(
            "/smart/session/start",
            json={
                **base,
                "model_provider": "openrouter",
                "model_name": "stale/model",
            },
        )
        unavailable = await client.post(
            "/smart/session/start",
            json={
                **base,
                "model_provider": "not-configured",
                "model_name": "lab/model",
            },
        )

    assert defaulted.status_code == 200
    assert selected.status_code == 200
    assert partial.status_code == stale.status_code == unavailable.status_code == 400
    assert partial.json() == stale.json() == unavailable.json() == {
        "detail": "Model selection is unavailable."
    }
    assert "api_key" not in stale.text
    assert loads == [False, False, False]
    assert starts == [
        ("coach", "input", "", ""),
        ("coach", "input", "openrouter", "lab/model"),
    ]
