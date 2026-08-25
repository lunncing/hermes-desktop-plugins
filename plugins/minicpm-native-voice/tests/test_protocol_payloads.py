from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest


def test_model_manifest_describes_actual_audio_only_reproduction_profile():
    manifest_path = Path(__file__).parents[1] / "MODEL_MANIFEST.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    readme = (manifest_path.parent / "README.md").read_text(encoding="utf-8")
    architecture = (manifest_path.parent / "ARCHITECTURE.md").read_text(
        encoding="utf-8"
    )

    assert manifest["reproduction_profile"] == {
        "media_type": 1,
        "modality": "audio-only",
        "vision_required": False,
    }
    assert manifest["source_revision"] is None
    assert manifest["source_revision_status"] == "unavailable"
    assert "unresolved" in manifest["source_revision_note"].lower()
    required_paths = {entry["path"] for entry in manifest["files"]}
    assert "vision/MiniCPM-o-4_5-vision-F16.gguf" not in required_paths
    assert manifest["optional_files"] == [
        {
            "path": "vision/MiniCPM-o-4_5-vision-F16.gguf",
            "required_for_media_type_1": False,
            "verification": "not part of the recorded acceptance candidate",
        }
    ]
    assert "revision-qualified remote retrieval remains unresolved" in readme
    assert "optional for this audio-only" in readme
    assert "audio-only `media_type=1` profile" in architecture


def test_blank_prompt_builds_actual_blank_session_payload(plugin_api):
    message = plugin_api.build_session_init("")

    assert message == {
        "type": "session.init",
        "payload": {
            "media_type": 1,
            "mode": "turn_based",
            "use_tts": True,
            "system_prompt": "",
        },
    }
    serialized = plugin_api.serialize_upstream_message(message)
    assert "English coach" not in serialized
    assert "assistant" not in serialized


def test_user_marker_prompt_is_preserved_exactly_once(plugin_api):
    marker = "  USER-MARKER\nKeep spacing:  x  "
    message = plugin_api.build_session_init(marker)
    serialized = plugin_api.serialize_upstream_message(message)

    assert message["payload"]["system_prompt"] == marker
    assert serialized.count("USER-MARKER") == 1


def test_prompt_utf8_ceiling_preserves_boundary_and_rejects_before_serialization(
    plugin_api, monkeypatch
):
    exact = " \n" + "é" * 32_766 + "  "
    oversized = exact + "x"
    assert plugin_api.MAX_SYSTEM_PROMPT_BYTES == 65_536
    assert len(exact.encode("utf-8")) == plugin_api.MAX_SYSTEM_PROMPT_BYTES
    assert len(oversized.encode("utf-8")) == plugin_api.MAX_SYSTEM_PROMPT_BYTES + 1
    assert plugin_api.build_session_init(exact)["payload"]["system_prompt"] == exact

    serialized = False

    def unexpected_serialization(*_args, **_kwargs):
        nonlocal serialized
        serialized = True
        raise AssertionError("oversized prompt reached serialization")

    monkeypatch.setattr(plugin_api.json, "dumps", unexpected_serialization)
    with pytest.raises(ValueError, match="65,536 UTF-8 bytes"):
        plugin_api.serialize_upstream_message(plugin_api.build_session_init(oversized))
    assert serialized is False


@pytest.mark.parametrize("bad_port", [0, 65536, -1, "9060", True, None])
def test_upstream_url_rejects_non_integer_or_out_of_range_ports(plugin_api, bad_port):
    with pytest.raises(ValueError):
        plugin_api.build_upstream_ws_url(bad_port)


def test_upstream_urls_are_fixed_to_loopback_and_fixed_paths(plugin_api):
    assert plugin_api.build_upstream_ws_url(9060) == "ws://127.0.0.1:9060/backend"
    assert plugin_api.build_upstream_http_url(9060, "/health") == "http://127.0.0.1:9060/health"
    with pytest.raises(ValueError):
        plugin_api.build_upstream_http_url(9060, "http://example.test/steal")
    with pytest.raises(ValueError):
        plugin_api.build_upstream_http_url(9060, "/not-allowed")


def test_audio_validation_rejects_over_five_mib_before_encoding(plugin_api, monkeypatch):
    called = False

    def forbidden(_raw):
        nonlocal called
        called = True
        raise AssertionError("base64 must not run for oversized uploads")

    monkeypatch.setattr(base64, "b64encode", forbidden)
    with pytest.raises(plugin_api.AudioValidationError, match="5 MiB"):
        plugin_api.build_turn_payload(b"\0" * (plugin_api.MAX_AUDIO_BYTES + 1))
    assert called is False


@pytest.mark.parametrize("raw", [b"", b"\0", b"\0\0", b"\0\0\0", b"\0" * 5])
def test_audio_validation_requires_positive_float32_byte_length(plugin_api, raw):
    with pytest.raises(plugin_api.AudioValidationError, match="Float32"):
        plugin_api.build_turn_payload(raw)


def test_turn_payload_puts_actual_audio_in_last_user_message(plugin_api):
    raw = b"\0\0\x80?\0\0\0\xbf"
    message = plugin_api.build_turn_payload(raw)

    assert message == {
        "type": "input.append",
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "audio",
                            "data": base64.b64encode(raw).decode("ascii"),
                        }
                    ],
                }
            ],
            "streaming": True,
            "tts": {"enabled": True},
            "use_tts_template": True,
            "generation": {
                "max_new_tokens": 128,
                "length_penalty": 1.1,
            },
        },
    }
    assert plugin_api.TURN_MAX_NEW_TOKENS == 128
    assert plugin_api.TURN_LENGTH_PENALTY == 1.1
    assert "text" not in plugin_api.serialize_upstream_message(message)


def test_audio_delta_size_is_rejected_before_base64_decode(plugin_api, monkeypatch):
    called = False

    def forbidden(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("decode must not run for an oversized encoded delta")

    monkeypatch.setattr(base64, "b64decode", forbidden)
    oversized = "A" * (plugin_api.MAX_AUDIO_DELTA_BASE64_BYTES + 4)
    with pytest.raises(plugin_api.AudioDeltaValidationError, match="encoded"):
        plugin_api.decode_audio_delta(oversized)
    assert called is False
