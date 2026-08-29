# Maintenance, verification, and rollback

Use this playbook for publication, bug repair, Hermes upgrades, and companion
Server upgrades. Preserve the native-audio turn contract, exact user-owned
prompt behavior, loopback boundary, process ownership, and resource ceilings
unless a separately reviewed product change explicitly replaces them.

**Supported scope:** This package is a **Windows-only, Vulkan-targeted
deployment** for packaged Hermes Desktop, microphone capture, and device-split
GPU acceptance. Automated checks and packaged acceptance are exercised on
Windows.

## Reproduce the automated checks

From a clean clone at the repository root on Windows, create a disposable
environment. Windows PowerShell:

```powershell
python -m venv .venv
./.venv/Scripts/python -m pip install --upgrade pip
./.venv/Scripts/python -m pip install "fastapi>=0.115,<1" "httpx>=0.27,<1" "pydantic>=2.9,<3" "python-multipart>=0.0.9,<1" "websockets>=13,<16" "pytest>=8,<10" "pytest-asyncio>=0.24,<2"
./.venv/Scripts/python -m pytest plugins/minicpm-native-voice/tests -q
node --check plugins/minicpm-native-voice/desktop/plugin.js
node --test plugins/minicpm-native-voice/tests/plugin.test.cjs
hermes plugins doctor --ci plugins/minicpm-native-voice
git diff --check
```

Plugin Doctor is required on a Hermes development/release machine. The GitHub
workflow does not install Hermes and therefore runs the Python and Node suite
only. Neither path requires model weights or a running Server.

The tests may not be portable to non-Windows hosts because the managed-Server
executable-name contract requires a Windows `.exe` basename. No cross-platform
port is planned.

Before publishing, inspect `git status --short` and the complete diff. Scan all
changed publication files for local paths, credentials, prompt contents,
weights, logs, audio, and review artifacts. The only committed local Server
file must be the placeholder-only `server.local.example.json`.

## Packaged Desktop acceptance matrix

The clean-install and acceptance procedure covers only the **Windows-only,
Vulkan-targeted deployment**. Run packaged Desktop, microphone, and
device-split checks on Windows.

Automated checks cannot validate Electron permissions, live devices, Vulkan,
or audible output. Run this matrix on the exact packaged Desktop build,
companion Server commit, and model snapshot intended for release. Record the
three revisions and replace `NOT RUN` with `PASS`/`FAIL` in the release or pull
request record; do not commit machine paths, logs, audio, credentials, or prompt
contents.

For the Windows-only experimental Smart candidate, also verify Native is still
the persisted default, Smart Start loads the Server on demand, the two visible
prompt fields remain independent, and the current or explicitly saved Hermes text-model route is
the only non-loopback stage. Provider privacy, network transfer, cost, and
latency must be reviewed for that route. The Smart production path must contain
no separate transcription implementation, alternate voice fallback, or hidden
input instructions. Its reasoning stage must use the Hermes host `PluginLlm`
current or explicitly saved model through central authentication without
selecting an auxiliary slot or fallback pool. Explicit model selection also
requires plugin-scoped `allow_provider_override: true` and
`allow_model_override: true` with `allowed_providers: ["*"]` and
`allowed_models: ["*"]`. The wildcard trust is safe because Start validates the
pair against the central authenticated inventory; do not put credentials or
Base URLs in Coach storage and do not modify deployment config as part of a
source-only release.

| Area | Procedure | Expected result | Initial status |
|---|---|---|---|
| Clean unified install | Install the repository subdirectory disabled, run Plugin Doctor, enable backend, restart dashboard, enable Desktop half | One package supplies backend and Desktop; English Coach route/nav/command appear | NOT RUN |
| Missing local config | Remove/withhold `server.local.json`, open English Coach | Server shows stopped/not configured; Start Server fails with a bounded configuration error and no private path | NOT RUN |
| Managed Server start | Install placeholder-replaced config, ensure `9060` is free, select Start Server | State moves starting -> ready; exactly one child starts; main model and Token2Wav use Vulkan, HiFiGAN uses CPU | NOT RUN |
| External Server safety | Launch the compatible Server outside Hermes, refresh the page | State is external; voice Start is allowed; Server Start/Stop controls cannot adopt or kill it | NOT RUN |
| Port conflict safety | Occupy `9060` with an incompatible listener, select Start Server | Start is rejected; no child spawns and the unrelated listener remains alive | NOT RUN |
| Prompt empty | Clear the prompt, End/Start, remount route, restart Desktop | Field remains exactly empty and no hidden/default model-facing prose is sent | NOT RUN |
| Prompt persistence | Enter a non-sensitive marker with deliberate surrounding whitespace; repeat End/Start, remount, hot reload, full restart | The exact value and whitespace persist and reach session init once | NOT RUN |
| Prompt byte ceiling | Use synthetic prompts of exactly 65,536 and 65,537 UTF-8 bytes at Desktop and API boundaries, including a multibyte paste below the textarea character limit but above the byte limit | The boundary value persists and is sent exactly; the larger value is rejected before storage/session mutation or upstream serialization, the prior controlled value remains visible/stored, and a bounded alert appears without an uncaught UI exception, trimming, or truncation | NOT RUN |
| Controls collapse | Open/remount English Coach, expand Controls, then hide it while a session and history are present | Each mount starts collapsed with only the compact Controls/mode/Details row from the configuration area; meter, history, timing, and errors remain visible; Details/Hide changes no session, model, prompt, Server, or runtime state | NOT RUN |
| Prompt collapse | Expand Controls, expand Prompts, edit both fields, then hide Prompts and Controls | Prompts starts nested-collapsed with accurate MiniCPM/Coach set status; Details/Hide changes only page-local visibility and the exact existing fields/handlers remain authoritative | NOT RUN |
| Microphone permission | Select Start with permission undecided, then allow | One mic stream opens, meter responds, and UI enters listening | NOT RUN |
| Microphone denial | Deny permission | Controlled error appears and no track/context remains owned | NOT RUN |
| Initial silence | Start, remain silent for 30 seconds, then speak continuously to the 60-second cap | One turn contains at most 500 ms pre-roll plus the full 60 seconds from speech onset; the earlier silence is absent | NOT RUN |
| Voice trigger threshold | At the default setting feed/produce levels around `0.03` and `0.05`; change the threshold during an unsent utterance and repeat after reset/restart | `0.03` does not start default VAD, `0.05` does; the persisted current threshold is used on every capture generation and changing it discards the old unsent generation atomically | NOT RUN |
| Normal turn | Speak one sentence and wait through the silence window | One native-audio turn uploads, state moves thinking -> speaking -> listening, text/audio arrive incrementally | NOT RUN |
| Persistent history | Complete enough 64 KiB-field turns to exceed 1 MiB, then End/Start without recreating the plugin runtime; also inject late text/audio and duplicate done events | Chronological user-right/assistant-left bubbles remain readable; oldest completed turns are evicted first at 100 turns or 1 MiB combined UTF-8 text; the active pending turn remains; completed assistant text/audio stay frozen | NOT RUN |
| Display-only STT | Run with configured STT success, configured failure plus installed local fallback, and total STT failure | The correct right bubble updates by turn ID on success, including after response completion; failure leaves `Native audio · N s`; native model input/response proceeds without waiting; no cloud provider, package, or model is configured, installed, or downloaded by the plugin | NOT RUN |
| Multipart temporary-file cleanup | Point the packaged runtime's temp directory at an isolated test location, submit accepted and oversized turns, then end the session | FastAPI/Starlette may spool upload bytes there before route validation; each request closes its `UploadFile` and releases active temporary files, with any filesystem remanence handled by local policy | NOT RUN |
| Manual turn end | Speak and select I'm done before the silence timeout | Exactly one turn submits immediately | NOT RUN |
| Discard utterance | Arm auto-submit and separately queue manual submit, then select Discard before lifecycle execution; speak and submit again | No first `/turn` or `/smart/turn`, bubble, transcript, history, session interruption, or REST side effect occurs; active listening/server state remains and new speech submits normally | NOT RUN |
| Playback quality | Listen to short, 60-second, and multi-chunk responses through the intended device and inspect state after upstream completion but before the final source ends | First audio begins intact after the 30 ms lead-in; Smart audio plays at generated PCM pitch/speed (`1.0x`); chunks are gapless and final words play; state remains speaking until the final scheduled source drains, then returns to listening | NOT RUN |
| Interrupt | During playback select Interrupt | Playback stops immediately; a fresh session starts with the exact same prompt; no old delta plays | NOT RUN |
| Experimental barge-in | Enable toggle, speak for at least 300 ms during playback | Playback/session restart occurs once and bounded pre-roll begins the new turn | NOT RUN |
| End cleanup | Select End while listening, thinking, transcribing, and speaking in separate runs | Tracks, nodes, contexts, sources, sockets, STT tasks/WAVs, timers, and queues release; state returns shell_ready | NOT RUN |
| Managed stop | With an active turn select Stop Server; separately exercise a failed kill/reap | Voice resources end first; a confirmed-exited owned child stops gracefully or by bounded escalation and UI reports stopped; failed exit confirmation returns a bounded error while ownership and the log remain available for retry | NOT RUN |
| Backend restart ownership | Start managed Server, restart/crash backend, reopen page | Surviving Server is external and is not killed by plugin controls | NOT RUN |
| Reload behavior | Update package, restart dashboard, reload Desktop plugins | New backend and Desktop revisions load without duplicate routes, sockets, timers, or stale state | NOT RUN |
| OAuth-remote limitation | Connect with the remote OAuth Desktop mode if available | Polling may show state; incremental socket audio is documented unavailable rather than misrepresented as supported | NOT RUN |
| Smart prompt separation | Select Smart, leave input instructions blank, then use distinct non-sensitive markers in both fields and restart the session | Blank Smart Start is rejected; each exact prompt reaches only its owned stage and edits apply on the next session | NOT RUN |
| Smart real chain | With the separately built candidate Server, select Smart and complete one synthetic/non-sensitive spoken turn through the current or explicitly saved Hermes text route | Right bubble is the MiniCPM interpretation, left bubble is exact model text, native 24 kHz speech drains fully, and no alternate path is used | NOT RUN |
| Smart unknown token | Return split `<u` + `nk>` deltas and final `<unk> um a little faster`, then repeat with mid-sentence and `<UNK>` text | No split/whole exact `<unk>` is displayed or sent onward; final text is `um a little faster`; case variants remain literal and hard wrappers still fail closed | NOT RUN |
| Smart interruption and ownership | Interrupt input/reasoning/speech turns, then End against both a session-started Server and an independently running Server | Late results remain inert; history stays visible; only the session-started Server stops | NOT RUN |

Also capture non-sensitive timing observations for session creation, first text,
first audio, and return to listening. Performance targets are hardware-specific;
regressions matter more than universal thresholds.

## Hermes API upgrade playbook

When upgrading Hermes Agent/Desktop:

1. Read the Hermes changelog and diffs for unified plugin discovery,
   `plugin.yaml`, dashboard manifest/API mounting, authenticated plugin route
   middleware, the WebSocket auth gate, Desktop disk plugin discovery, and the
   plugin SDK.
2. Run Plugin Doctor with the new Hermes executable before launching Desktop.
3. Confirm `ctx.rest(path, options)` still supplies authentication, JSON bodies,
   multipart `upload`, and the configured timeout semantics used here. Recheck
   FastAPI/Starlette `UploadFile` spooling thresholds and close/cleanup behavior;
   the route's 5 MiB read bound applies only after multipart parsing.
4. Confirm `ctx.socket('/events', handler)` still reaches the canonical
   authenticated WebSocket and returns an idempotent disposer. Never replace it
   with an unauthenticated raw socket to make a test pass.
5. Confirm SDK areas `ROUTES_AREA`, `SIDEBAR_NAV_AREA`, and `PALETTE_AREA`, the
   `host.navigate` call, storage get/set semantics, and React host imports.
6. Confirm unified package discovery still reads
   `$HERMES_HOME/plugins/<id>/desktop/plugin.js`, remains opt-in, and does not
   require a duplicate file under `desktop-plugins`.
7. Confirm dashboard lifespan cleanup still runs on restart/shutdown and the
   canonical auth middleware covers all HTTP routes.
8. Update test harness mocks only after confirming the production API change.
   Add a regression for every altered shape or lifecycle edge.
9. Run all automated checks and the entire packaged Desktop acceptance matrix.
10. Update the compatibility statement with the exact tested build. Do not
    broaden a version claim based only on source inspection.

Watch especially for auth refactors: `_ws_upgrade_authorized` delegates to the
Hermes dashboard host and fails closed when that auth gate is unavailable or
raises. Tests that need an authorized socket must monkeypatch the gate
explicitly; never add an allow-on-import-failure fallback.

## Companion Server upgrade playbook

When rebasing or advancing
`feat/hermes-native-audio-server`:

1. Record old/new Server commit IDs and the official model snapshot/revision.
2. Compare `llama-omni-server` build output/name and Vulkan requirements.
3. Diff `/health`, `/v1/stream/omni_init`, `/backend`, and
   `/sessions/{session_id}/close` semantics.
4. Verify `session.init`, `session.created`, `input.append`, text/audio delta,
   `response.done`, `session.closed`, sample-rate, and metrics shapes against
   [ARCHITECTURE.md](ARCHITECTURE.md).
5. Verify the exact official model directory layout, required companion files,
   and main GGUF naming. Do not copy weights into this repository.
6. Reconfirm main-model Vulkan offload, Token2Wav `gpu:0`, child-only
   `OMNI_T2W_FUSED_QKV=0`, HiFiGAN CPU, and no SYCL deployment.
7. Recheck why keepalive pings are disabled. Re-enable them only after the
   Server reads control frames throughout synchronous decode, and add a long
   turn regression before changing the client.
8. Run protocol/bridge tests with the loopback fake upstream, then the complete
   automated suite.
9. Run the packaged matrix with short, long, interrupted, and multi-chunk
   responses. Listen for sample-rate and chunk-order regressions.
10. Update documentation and tests in the same change as a protocol change.

If the Server changes wire behavior, prefer a narrow compatibility adapter at
the bridge boundary. Do not leak Server-specific defaults into the user prompt
or relax validation globally.

## Bug repair workflow

1. Classify the symptom using the source map in `ARCHITECTURE.md`.
2. Reproduce with the smallest existing boundary: pure Desktop unit, ASGI
   route, bridge with fake socket, Server manager with fake process, real
   loopback fake Server, then packaged integration.
3. Capture only bounded, non-sensitive metadata: state, generation, event type,
   sizes, sample rate, and timing. Never capture actual prompt contents or audio
   in repository artifacts.
4. Add a failing regression that proves the ownership, order, bound, or exact
   payload requirement.
5. Make the narrowest fix. Preserve independent lifecycle lanes for voice and
   Server controls and preserve stale-result rejection.
6. Run all automated checks. For runtime changes, run the affected manual rows
   plus the full cleanup/reload rows.
7. Review the diff for accidental defaults, new persistence, path exposure,
   arbitrary upstreams, shell command construction, or weakened bounds.

## Rollback and uninstall

Before rollback, select **End**. If the Server card says managed/running, select
**Stop Server** and wait for stopped. An `external` Server belongs to its
original launcher and must be stopped there if desired.

To disable without deleting local configuration:

```powershell
hermes plugins disable minicpm-native-voice
```

Then disable **MiniCPM Native Voice** in Desktop settings and restart the
dashboard/backend. This preserves the installed package and
`server.local.json` for later re-enable.

To uninstall:

```powershell
hermes plugins disable minicpm-native-voice
hermes plugins remove minicpm-native-voice
```

Removal deletes the installed package, including its installed
`server.local.json`. Back up that file outside the repository only if the local
paths are needed later. Hermes-managed Desktop plugin storage may outlive source
removal depending on Desktop version; clear the prompt in the UI before removal
when it must not persist, or use the Desktop's supported plugin-data reset.
Do not manually delete unrelated Hermes storage.

Server output and logs are not removed because they are user-selected external
paths. Model weights and the companion Server worktree are also independent and
must be retained or removed by their owner. The plugin never removes an
external Server process or these external data locations.

For a code rollback, install a reviewed earlier repository commit with Hermes'
`--ref <40-character-commit>` option, re-create the installed-only config if
needed, run Plugin Doctor, restart both halves, and repeat the acceptance rows
affected by the rollback. Verify companion Server protocol compatibility; a
plugin rollback does not roll back the Server or model snapshot.

## Contribution and review rules

- Branch from the current public `main`; keep changes scoped to this plugin.
- Separate functional protocol/runtime changes from documentation-only or CI
  changes so reviewers can audit behavior precisely.
- Preserve all existing unrelated worktree changes.
- Do not edit generated caches or commit `__pycache__`, `.pytest_cache`, local
  config, weights, logs, audio, credentials, prompt content, or review output.
- Update documentation, exact payload/argv tests, and manual acceptance rows
  whenever a boundary changes.
- Use primary upstream sources for Hermes, the companion Server, and OpenBMB
  model instructions. Link to weights; never redistribute them.
- Report commands and exact pass/fail/skip counts. State clearly which manual
  checks were not run and why.
- Do not merge if Plugin Doctor, Python tests, Node syntax/tests,
  `git diff --check`, publication scans, or required manual rows fail.
