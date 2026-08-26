# Architecture and repair map

This document is the durable engineering map for `minicpm-native-voice`. The
V2 preserves end-to-end native audio with serialized turns: microphone PCM
goes directly to MiniCPM-o, and model PCM returns directly to Web Audio. A
concurrent, display-only STT side path labels the user's turn bubble; it never
gates, alters, or replaces MiniCPM-o input. There is no strict full-duplex
scheduler.

## Component boundaries

| Component | Owns | Does not own |
|---|---|---|
| Hermes Desktop plugin | Route/UI registration, bounded session-local turn history, user prompt and preferences, microphone acquisition, resampling, VAD, turn upload, socket consumption, playback, browser-resource cleanup | Dashboard authentication policy, upstream process ownership, model inference |
| Hermes dashboard plugin | Authenticated HTTP/WebSocket surface, loopback-only URL construction, protocol validation, session/turn serialization, display-only STT task/temp-file lifecycle, event bounds, upstream cleanup | Microphone permission, browser playback, model files |
| Local Server manager | Strict local configuration, exact child argv/environment, port conflict detection, health/init waits, ownership-safe stop | Arbitrary command input, external process adoption, persistent process recovery |
| Companion `llama-omni-server` | Native-audio WebSocket protocol, MiniCPM-o decode, Token2Wav, HiFiGAN, session close, health/init endpoints | Hermes authentication, Desktop UI, prompt persistence |
| Model directory | Main GGUF and the published audio, TTS, and Token2Wav/HiFiGAN files required by the audio-only `media_type=1` profile; optional vision companion file for separately verified vision use | Plugin code or configuration |

## End-to-end lifecycle

1. Desktop loads `desktop/plugin.js`, constructs one runtime, binds the Hermes
   authenticated socket, and begins a three-second Server/status poll.
2. **Start Server** calls `POST /server/start`. The backend validates the
   installed-only config, rejects a pre-existing port owner, starts one exact
   child, waits up to 30 seconds for health, and allows up to 180 seconds for
   native-audio initialization.
3. **Start** validates the exact stored prompt against the 65,536-byte UTF-8
   ceiling, primes Web Audio synchronously, then calls `POST /session/start`.
   The backend independently enforces the same byte ceiling, connects to the
   selected loopback port with bounded WebSocket settings, and sends
   `session.init`.
4. After `session.created`, the backend publishes `ready`, then `listening`.
   Desktop acquires one mono microphone stream and resamples frames to 16 kHz.
5. Before speech, capture retains only the latest 500 ms as pre-roll. Speech
   onset starts the 60-second/960,000-sample allowance; VAD ends the utterance
   after the selected silence interval or that post-onset cap. **I'm done**
   requests the same submission explicitly.
6. Desktop uploads `turn.f32le.pcm` as multipart field `file`. FastAPI/Starlette
   parses it into a spooled `UploadFile` before the route runs, so the framework
   may use operating-system temporary-file storage. The route then performs its
   bounded read, closes the upload, validates before Base64 encoding, assigns a
   unique `turn_id`, publishes `turn.started`, and sends one `input.append`.
   Only after upstream acceptance, a worker converts the same validated PCM to
   a bounded temporary PCM16 WAV for display-only Hermes transcription; the WAV
   is always deleted and transcription never changes the native model payload.
7. The reader forwards bounded text/audio deltas in order with `turn_id`.
   Desktop routes them into a session-local history bounded to 100 turns,
   1 MiB of combined user/assistant UTF-8 text, and 64 KiB per field, evicting
   oldest completed turns first. It validates Base64 and byte/duration headroom
   before Web Audio allocation.
8. `response.done` marks upstream generation complete, but Desktop remains
   `speaking` until every scheduled Web Audio source reports `onended` and the
   local playback queue drains. Later text/audio deltas and duplicate done
   events cannot mutate that completed turn, while late display STT may still
   update its matching user bubble. It then returns to `listening`.
   **Interrupt** explicitly discards playback, closes/recreates the upstream
   session, and preserves the exact user prompt. **End**, unmount, errors, and
   disable dispose owned resources.

The bridge uses a monotonically increasing generation plus session and turn
IDs to ignore late reader events, poll completions, socket traffic, and display
transcripts from the wrong owner. Desktop has a separate serialized lifecycle
lane and cancellation epoch for the same purpose.

## Source map and symptom routing

Every production, configuration, and test file in the package is listed here.

| File | Ownership | Debug here when |
|---|---|---|
| `plugin.yaml` | Unified package identity, version, kind, license, tags, manifest/API versions | Hermes cannot discover the package or Plugin Doctor rejects metadata |
| `__init__.py` | No-op Python registration shim; declares that surfaces come from dashboard/Desktop halves | Core plugin discovery/import fails before dashboard mounting |
| `dashboard/manifest.json` | Dashboard plugin identity, hidden tab declaration, and `plugin_api.py` entry | Backend plugin is discovered but API entry is not mounted |
| `dashboard/plugin_api.py` | Strict Server config, owned child process, loopback probes/URLs, native-audio protocol, event queues, FastAPI routes, WebSocket auth delegation, lifespan cleanup | `401`/socket policy, `4xx`/`5xx`, port `9060`, Server ownership, missing events, protocol sizes, stale sessions, backend cleanup |
| `desktop/plugin.js` | SDK registration, English Coach UI, prompt/preferences, capture/resampling/VAD, REST/socket lifecycle, barge-in, playback bounds, browser cleanup | Page/nav/command missing, mic/VAD behavior, prompt persistence, silent/distorted playback, stale UI, resource leaks |
| `server.local.example.json` | Placeholder-only template for the five-field installed Server configuration | Operators need the exact schema; never add a real path here |
| `README.md` | Supported scope, prerequisites, installation, model layout, runtime/device contract, operation, troubleshooting, privacy, limitations | Reproduction or operator instructions are unclear |
| `ARCHITECTURE.md` | Component flow, source ownership, wire protocol, security/resource invariants | A maintainer must locate a fault or extend a boundary |
| `MAINTENANCE.md` | Upgrade, validation, acceptance, rollback, and contribution playbook | Hermes/Server changes or a release must be evaluated |
| `tests/conftest.py` | Imports `dashboard/plugin_api.py` directly as a session-scoped fixture | Test collection/import isolation breaks |
| `tests/test_protocol_payloads.py` | Prompt fidelity, URL allowlist, upload validation, exact session/turn payloads, audio delta pre-decode bounds | Wire JSON or PCM validation changes |
| `tests/test_bridge_state.py` | Event count/byte overflow, WebSocket bounds, session conflicts, stale-event rejection, ordered forwarding, cleanup, loopback fake Server | Concurrency, state, event ordering, or cleanup regresses |
| `tests/test_api_routes.py` | ASGI route status/error mapping, public snapshots, lifecycle order | HTTP status or route contract changes |
| `tests/test_server_manager.py` | Five-field config, exact argv/env/init payload, port conflict, startup/timeout/stop ownership, public-data redaction | Managed Server controls or process safety changes |
| `tests/plugin.test.cjs` | Desktop transforms, VAD, playback, prompt storage, registration/UI, lifecycle races, polling, Server buttons, browser cleanup | Any Desktop or Web Audio behavior changes |
| `.github/workflows/minicpm-native-voice.yml` | Path-scoped clean Windows/Ubuntu Python 3.12 and Node 20/22 checks | CI environment or documented test commands drift |

The Server branch is a second debugging boundary. If Hermes sends the exact
documented frames but `/backend` rejects them, health/init disagree, or
Token2Wav/HiFiGAN fails after valid audio is accepted, reproduce against the
companion branch before changing the plugin.

## Hermes API surface

Hermes mounts all routes below:

```text
/api/plugins/minicpm-native-voice
```

HTTP requests inherit the dashboard's authenticated plugin middleware. The
WebSocket calls Hermes' canonical dashboard upgrade-auth gate before accept.
Desktop must use SDK `ctx.rest` and `ctx.socket`; callers must not build an
unauthenticated bypass.

| Method and plugin-relative path | Request | Successful response/behavior |
|---|---|---|
| `GET /health` | none | `{state, upstream:{reachable,state,http_status?}}`; generic upstream `status: ok` is only `shell_ready` |
| `GET /status` | none | Stable `{state,session_id,generation,turn_id,metrics}` snapshot; never includes prompt or credentials |
| `GET /server/status` | none | Bounded `{configured,state,running,managed,message,pid?}`; never includes paths, argv, environment, prompt, or log contents |
| `POST /server/start` | empty JSON | Serializes duplicate starts, starts at most one configured child, health-checks and initializes it |
| `POST /server/stop` | empty JSON | Releases voice first; terminates only the owned child, escalating after a five-second graceful wait and retaining ownership/log state with a bounded error unless the second bounded reap confirms exit |
| `POST /session/start` | JSON `system_prompt` string of at most 65,536 UTF-8 bytes; optional strict integer `port` | Creates one audio-only, TTS-enabled upstream session; over-limit prompts and extra JSON fields are rejected |
| `POST /turn` | multipart field `file`, required `application/octet-stream`, native PCM | Accepts one turn only when a session exists and no turn is active |
| `POST /session/stop` | empty JSON | Idempotently cancels the reader, requests upstream close, closes the socket, and clears state |
| `WS /events` | authenticated upgrade | Initial `status`, then ordered `state`, `turn.started`, `text.delta`, `audio.delta`, `user.transcript`, `response.done`, or `error` objects |

HTTP error mapping is deliberate: malformed requests/config are `400`, a
missing or unexpected upload part media type is `415`, upload overflow is
`413`, ownership/session conflicts are `409`, upstream/cleanup failures are
`502`, and managed startup/init timeout is `504`.

### Desktop-to-Hermes payloads

The session request contains only the exact value owned by the user:

```json
{
  "system_prompt": "<EXACT_USER_OWNED_VALUE>"
}
```

The turn is little-endian IEEE-754 Float32 PCM, mono, 16,000 samples/second.
It is sent as a single multipart file named `turn.f32le.pcm` in field `file`.

Every event emitted by the bridge includes `type`; session events also carry
`seq`, `session_id`, and `generation`. Turn events carry the unique `turn_id`.
Relevant event fields are:

- `state`: `state` and optional `reason`;
- `turn.started`: bounded `duration_seconds`;
- `text.delta`: `turn_id`, `text`, and bounded numeric `metrics`;
- `audio.delta`: `turn_id`, Base64 `audio`, positive integer `sample_rate`, and metrics;
- `user.transcript`: `turn_id`, bounded display text, and bounded provider label;
- `response.done`: `turn_id`, optional `response_id`, complete bounded `text`, metrics;
- `error`: bounded `code` and `message`.

Desktop accepts events only when session ID and generation match the active
runtime. It accepts a current-generation error status after the backend has
cleared the session ID so failures are not hidden.

## Companion Server protocol

The bridge connects only to `ws://127.0.0.1:<port>/backend`. The Desktop omits
`port`, so normal operation uses `9060`; the authenticated API accepts only a
strict integer in `1..65535` and still fixes the host to loopback.

Session initialization is:

```json
{
  "type": "session.init",
  "payload": {
    "media_type": 1,
    "mode": "turn_based",
    "use_tts": true,
    "system_prompt": "<EXACT_USER_OWNED_VALUE>"
  }
}
```

The Server must answer with `type: "session.created"` and a non-empty
`session_id` within 120 seconds. A turn is:

```json
{
  "type": "input.append",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "audio", "data": "<BASE64_FLOAT32_PCM>"}
        ]
      }
    ],
    "streaming": true,
    "tts": {"enabled": true},
    "use_tts_template": true,
    "generation": {"max_new_tokens": 128, "length_penalty": 1.1}
  }
}
```

Recognized upstream output is `response.output.delta` with `kind: "text"` or
`kind: "audio"`, followed by `response.done`. `session.closed` is a controlled
failure. Session cleanup posts to
`http://127.0.0.1:<port>/sessions/<URL_ENCODED_SESSION_ID>/close` with a
three-second timeout.

Managed Server readiness uses `GET http://127.0.0.1:9060/health` and initializes
with `POST http://127.0.0.1:9060/v1/stream/omni_init`. The fixed init object is:

```json
{
  "media_type": 1,
  "use_tts": true,
  "duplex_mode": false,
  "output_dir": "<CONFIGURED_OUTPUT_DIRECTORY>",
  "system_prompt": "",
  "token2wav_device": "gpu:0"
}
```

The upstream WebSocket disables keepalive pings and ping timeout because the
Server's synchronous generation path may not read control frames while a turn
decodes. This exception does not remove bounds: connection open is 10 seconds,
close is two seconds, session creation is 120 seconds, incoming size is bounded,
and incoming queue depth is eight.

## Resource and security invariants

| Resource | Bound/behavior |
|---|---|
| Upstream host | Literal `127.0.0.1`; no user-selectable host and no proxy-environment trust for HTTP probes |
| Managed port | Fixed `9060`; a healthy unowned process is `external`, an incompatible owner is a conflict, neither is killed |
| Child execution | Exact argv list, `shell=False`, no stdin, combined configured log, hidden/new process group on Windows |
| Upload | FastAPI/Starlette multipart parsing occurs before the handler and may spool to OS temporary-file storage; the route then reads at most 5,242,881 bytes, accepts at most 5,242,880 positive/aligned bytes, and closes the `UploadFile` on success or rejection |
| Capture | 16 kHz mono Float32; at most 500 ms/8,000 samples of pre-roll plus 60 seconds/960,000 samples from speech onset; earlier initial silence is discarded |
| VAD | Threshold `0.02`; end silence defaults to 4,000 ms and clamps to 2,000-6,000 ms |
| Experimental barge-in | Off by default; 300 ms sustained speech and 500 ms bounded pre-roll |
| Per-subscriber queue | 64 events and 12 MiB serialized bytes; overflow clears pending items, emits one explicit error, then rejects later items for that subscriber |
| Text | 8 KiB UTF-8 per delta, 64 KiB current-turn total; truncation preserves valid UTF-8 |
| Display-only STT | Validated input is converted in a worker to a mono 16 kHz PCM16 temporary WAV; configured Hermes STT is tried first, then only the already-installed local fallback; the plugin never configures cloud access, installs a package, or downloads a model; text is 64 KiB UTF-8 maximum and failures are silent |
| Desktop history | Session-local only; at most 100 turns, 64 KiB UTF-8 per user/assistant field, and 1 MiB across all combined field text; oldest completed turns are evicted first, the active pending turn is never dropped or mutated to fit history, completed assistant text/audio are frozen, and late display STT may update the matching user field; cleared by runtime recreation, not response/session completion |
| User-owned prompt | Exact empty/whitespace semantics; maximum 65,536 UTF-8 bytes at Desktop storage/start and backend API; over-limit values are rejected without trimming, truncation, or normalization |
| Generated audio | Valid Base64, aligned Float32, 1 MiB decoded per delta, 8 MiB per turn; encoded length checked before decode |
| Playback | 75 seconds and 8 MiB raw Float32 scheduled; a bounded 30 ms first-source lead-in is reapplied after drain/interrupt; incoming Base64 and remaining queue/duration/turn headroom are checked before allocation |
| Sample rate | Positive upstream integer; missing/invalid value falls back to 24,000 Hz |
| Metrics | At most 32 string keys; keys at most 64 characters; numeric/boolean values only |
| Public errors/status | Messages bounded; Server status omits config paths, argv, environment, prompt, and logs |
| Persistence | Plugin storage contains only the prompt and two preferences; turn history is memory-only. Multipart parsing and display STT use OS temporary storage, and the companion Server may write under its configured output/log paths; none is a never-disk boundary |
| Cleanup | Tracks, nodes, sources, contexts, timers, subscribers, STT tasks/WAVs, clients, sockets, and `UploadFile`/spooled temporary files are released by their owning lifecycle; owned child/log state is released only after exit is confirmed and otherwise remains owned for a safe retry; host temp-file remanence and external Server output retention remain subject to local policy |

Do not expose port `9060` beyond loopback, add an arbitrary upstream URL, pass
Server arguments from the UI, adopt a process by PID/port, or weaken Hermes
authentication. Those changes cross the security boundary and are not routine
extensions.

## Safe extension seams

- New UI-only diagnostics should derive from bounded `/status` fields and must
  not expose prompt/config values.
- New upstream event kinds should be validated and bounded in
  `VoiceBridge._handle_upstream_event`, represented in Desktop
  `handleEvent`, and covered on both sides.
- A new audio format requires coordinated validation, content type, Server
  protocol, playback decoding, and fixture changes; do not reinterpret the
  existing `.f32le.pcm` contract.
- New persisted settings need an explicit owner/default/clear/migration policy.
- New Server flags belong in reviewed backend code and exact argv tests, never
  in user prompt text or free-form UI input.
- Process recovery across backend restart needs durable, verifiable ownership;
  port/PID matching alone is insufficient and must remain non-destructive.
