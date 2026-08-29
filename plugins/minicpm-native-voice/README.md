# MiniCPM Native Voice

`minicpm-native-voice` is one unified Hermes plugin package: an **English
Coach** page in Hermes Desktop plus an authenticated dashboard/backend bridge
to a local `llama-omni-server`. Native mode remains the persisted default and
keeps the V2 behavior: it sends microphone samples to MiniCPM-o as native
audio, shows a concurrent display-only transcript in persistent turn bubbles,
and plays native audio returned by Token2Wav and HiFiGAN.

This is **native audio, turn-based streaming V2**. STT is display-only: it never
gates, alters, or replaces raw audio sent to MiniCPM-o. This is not an STT/text
generation/TTS cascade and is not strict full duplex. Experimental client-side
barge-in is available but is off by default.

Display STT tries the user's already-configured Hermes transcription provider,
then an already-installed local fallback. The plugin does not configure a cloud
provider, install an STT package, or download a transcription model.

## Experimental Smart mode

Windows users may opt into the experimental `smart-minicpm` mode. It uses this
exact turn pipeline:

```text
raw Float32LE 16 kHz microphone PCM
  -> MiniCPM-o native audio understanding with the user's visible input prompt
  -> the current or explicitly saved Hermes text-model route with the user's optional model prompt
  -> exact assistant text
  -> MiniCPM teacher-forced native speech at 24 kHz
  -> the existing history and playback queue
```

Smart mode has two separate user-owned prompt fields. Both default to empty;
Smart Start requires nonblank MiniCPM input-understanding instructions, while
the model prompt remains optional. The plugin supplies no hidden input prompt,
dictionary, coach persona, memory, skills, tools, or fabricated transcript.
All configuration and action UI mounts collapsed behind the page-local
**Controls** row. Its compact row shows the current interaction mode and a
**Details** button; expansion changes the button to **Hide**. The Server and
Prompts sections retain their own nested details controls. None of these
expansion states are persisted or alter session, model, prompt, Server, or
runtime state.
The middle stage uses the Hermes host `PluginLlm` facade with central Hermes
authentication; the plugin selects no auxiliary slot or fallback pool. **Smart
model** defaults to the current Hermes model. An optional saved provider/model
pair is chosen only from the authenticated central inventory and is frozen when
Smart Start succeeds. The Coach stores only those two identifiers and never
receives, returns, logs, or stores API keys, OAuth data, or Base URLs.
There is no separate transcription stage and no alternate voice fallback in
the Smart production path. If native speech generation fails after reasoning,
the exact assistant text remains visible and no substitute audio plays.
Smart native audio plays at `1.0x`, preserving the pitch, speed, and timing of
the generated PCM.

Smart Start loads the configured Server on demand and stops it at End only when
that Smart session started it. An already-running managed or external Server is
never adopted. The input WebSocket is request-owned and closes before text
reasoning and native speech begin. Smart Interrupt cancels only the current
turn and keeps the session listening; Smart mode is turn-based and not full
duplex. A failed Smart input/reasoning request is terminalized as one failed
turn, best-effort interrupted on the backend, and returns the same session to
listening; invalid session/generation identities still fail closed. Exact
case-sensitive MiniCPM `<unk>` placeholders are removed from the
interpretation before partial display, Hermes reasoning, history, or the final
event; other text and hard-rejected model-audio wrappers keep their existing
semantics.

The companion Omni candidate is a separately built runtime dependency. Its
audio-task and exact-text speech endpoints are required, but its source is not
embedded or duplicated in this plugin.

The exact MiniCPM native-speech response is JSON with only `text`, `audio`
(Base64 Float32LE), and `sample_rate` fields. After strict validation, the
plugin normalizes `audio` to `audio_base64` only in its session/frontend
response.

Privacy, network, cost, and latency depend on the configured Hermes text-model
route: the MiniCPM audio stages remain fixed to loopback, while the middle text
request may leave the machine, incur provider charges, and add model latency.
Cold local Server startup commonly adds 15–30 seconds. Review the selected
Hermes provider before enabling Smart mode and do not use sensitive prompts or
audio unless that provider is appropriate.

Automated Smart tests use injected dependencies and synthetic PCM. Packaged
GUI, microphone, listening-quality, and real-chain acceptance are **NOT RUN**
in this source change and must be recorded separately on Windows.

Deployments that use explicit Smart provider/model selection must configure this
plugin-scoped Hermes LLM trust block (do not add credentials to the plugin):

```yaml
plugins:
  entries:
    minicpm-native-voice:
      llm:
        allow_provider_override: true
        allow_model_override: true
        allowed_providers: ["*"]
        allowed_models: ["*"]
```

The wildcard allowlists are safe here because every REST selection is validated
against the central authenticated inventory immediately before session Start;
central Hermes remains responsible for routing and auth resolution. A missing
trust block remains fail-closed. This repository task does not modify deployment
configuration.

For implementation ownership, protocol details, and symptom-to-source routing,
see [ARCHITECTURE.md](ARCHITECTURE.md). For release checks, upgrades, recovery,
and rollback, see [MAINTENANCE.md](MAINTENANCE.md).

## Runtime architecture

```text
microphone
  -> Hermes Desktop plugin (capture, VAD, 16 kHz mono Float32 PCM)
  -> authenticated Hermes plugin API (multipart HTTP)
     -> concurrent Hermes STT -> display-only user bubble
  -> loopback bridge (127.0.0.1 only)
  -> llama-omni-server WebSocket (/backend)
  -> MiniCPM-o native-audio inference
  -> Token2Wav on Vulkan -> HiFiGAN on CPU
  -> bounded audio events through authenticated Hermes WebSocket
  -> Hermes Desktop incremental Web Audio playback
```

The Desktop half uses the public Hermes plugin SDK for its route, sidebar
entry, command, authenticated REST client, authenticated socket, and plugin
storage. The Python half is mounted by the authenticated Hermes dashboard
plugin host below `/api/plugins/minicpm-native-voice/`. The only upstream host
the bridge can contact is `127.0.0.1`.

## Compatibility and prerequisites

**Supported deployment:** This package is a **Windows-only, Vulkan-targeted
deployment** for packaged Hermes Desktop, microphone capture, and device-split
GPU acceptance. Its automated checks are exercised on Windows.

The publication checks cover the following compatibility bands; they are test
targets, not promises about every future release in each band:

- Windows 11 x64 is the V2 deployment target. A current Vulkan-capable GPU and
  vendor driver are required for the main model and Token2Wav path.
- Hermes Agent/Desktop must support unified native plugin packages,
  `manifest_version: 2`, dashboard plugin APIs, and the Desktop plugin SDK
  areas used by this package. Publication verification used a Hermes
  development build reporting `0.20.5`; that is evidence, not a minimum-version
  guarantee. Run Plugin Doctor against the exact Hermes build being deployed.
- Python `3.12.x` runs the backend and its tests.
- Node.js `20.x` through `22.x` runs the source and unit checks. Node is not a
  production dependency of the packaged Desktop application.
- The Python compatibility bands resolved by CI are FastAPI `>=0.115,<1`,
  HTTPX `>=0.27,<1`, Pydantic `>=2.9,<3`, python-multipart `>=0.0.9,<1`,
  websockets `>=13,<16`, pytest `>=8,<10`, and pytest-asyncio `>=0.24,<2`.
  CI resolves one current set inside those bands; it does not exhaustively test
  every historical combination.
- Git is needed for clean installation. Building the companion Server on
  Windows requires the tools and Vulkan SDK/driver prerequisites documented by
  that branch (normally CMake plus a supported MSVC Build Tools toolchain).
- Loopback TCP port `9060` must be free if the plugin will manage the Server.
- A working microphone, permission for Hermes Desktop to use it, and an audio
  output device are required for the end-to-end feature.

Python runtime dependencies are `fastapi`, `httpx`, `pydantic`,
`python-multipart`, and `websockets`. The test-only dependencies are `pytest`
and `pytest-asyncio`. The Desktop production imports (`@hermes/plugin-sdk`,
`react`, and `react/jsx-runtime`) are supplied by Hermes Desktop; do not bundle
a second React or SDK copy.

The tests may not be portable to non-Windows hosts because the managed-Server
executable-name contract requires a Windows `.exe` basename. No cross-platform
port is planned. SYCL is not a supported deployment path for this integration.

## Clean installation

This clean-install procedure is for the **Windows-only, Vulkan-targeted
deployment**: packaged Desktop, microphone, and device-split acceptance are
performed on Windows, as are the automated checks.

### 1. Install the unified Hermes package

Once this repository is public, install the plugin subdirectory from the
default branch:

```powershell
hermes plugins install https://github.com/lunncing/hermes-desktop-plugins/tree/main/plugins/minicpm-native-voice --no-enable
hermes plugins doctor --ci minicpm-native-voice
hermes plugins enable minicpm-native-voice --no-allow-tool-override
```

This creates one package at
`$HERMES_HOME/plugins/minicpm-native-voice`. For a source checkout under review,
copy the complete `plugins/minicpm-native-voice` directory to that location;
do not copy only `desktop/plugin.js`.

The CLI enable command enables backend discovery. Restart the Hermes dashboard
or gateway so `dashboard/plugin_api.py` is mounted. In the packaged Desktop
application, open **Settings -> Plugins**, enable **MiniCPM Native Voice**, then
use the sidebar entry or **Open English Coach** in the command palette. The
Desktop half is deliberately opt-in even when the backend half is enabled.

If a source save is not reflected, use **Reload desktop plugins** and restart
the dashboard/backend. See the stale-reload troubleshooting entry below before
changing code.

### 2. Obtain the companion Server

Use the pinned experimental companion source at this immutable commit:

<https://github.com/lunncing/llama.cpp-omni/tree/46c09e5ad93823fcc6de46e48976761247a12d2f>

The moving development branch is
[`feat/hermes-native-audio-server`](https://github.com/lunncing/llama.cpp-omni/tree/feat/hermes-native-audio-server),
but exact reproduction must check out commit
`46c09e5ad93823fcc6de46e48976761247a12d2f`. Build
`llama-omni-server` from that commit using its documented Vulkan build steps.
Do not substitute the ordinary upstream `llama-server`: the bridge requires the
fork's `/backend`, `/v1/stream/omni_init`, and session-close contracts. The
expected Windows artifact is `llama-omni-server.exe`. This personal-fork
companion remains experimental; review its published
[known limitations](https://github.com/lunncing/llama.cpp-omni/issues/1) before
use or extension.

The model weights are not part of this repository. Download them from the
official [OpenBMB MiniCPM-o 4.5 GGUF model repository](https://huggingface.co/openbmb/MiniCPM-o-4_5-gguf)
and review the official [MiniCPM-o source and model documentation](https://github.com/OpenBMB/MiniCPM-V).
The recorded local download used for this publication did not retain its
Hugging Face revision metadata. Do not infer or claim a revision from the file
names: revision-qualified remote retrieval remains unresolved.
[`MODEL_MANIFEST.json`](MODEL_MANIFEST.json) instead records the exact sizes and
SHA-256 values of the files used by the verified audio-only `media_type=1`
candidate. After downloading, compute SHA-256 for every required GGUF and
compare it to the manifest before running acceptance tests. Preserve this
required layout; the configured `model` is the main GGUF file at its root:

```text
<MODEL_ROOT>/
|-- MiniCPM-o-4_5-Q4_K_M.gguf
|-- audio/
|   `-- MiniCPM-o-4_5-audio-F16.gguf
|-- token2wav-gguf/
|   |-- encoder.gguf
|   |-- flow_extra.gguf
|   |-- flow_matching.gguf
|   |-- hifigan2.gguf
|   `-- prompt_cache.gguf
|-- tts/
|   |-- MiniCPM-o-4_5-projector-F16.gguf
|   `-- MiniCPM-o-4_5-tts-F16.gguf
```

`vision/MiniCPM-o-4_5-vision-F16.gguf` is optional for this audio-only
`media_type=1` reproduction and was not part of the recorded acceptance
candidate. Add it only for a separately verified vision-capable profile. The
manifest intentionally supplies no size/hash for that optional, unverified
artifact.

The official model repository may also contain Core ML assets and other main
GGUF quantizations. Keep any selected main GGUF at `<MODEL_ROOT>` and keep all
native-audio companion directories in their published relative locations.
Never commit weights or generated model artifacts to this plugin repository.

### 3. Configure managed Server controls

Copy `server.local.example.json` to `server.local.json` beside `plugin.yaml` in
the installed package, then replace every placeholder. The file must contain
exactly these five string fields and no others:

```json
{
  "executable": "<ABSOLUTE_PATH_TO_LLAMA_OMNI_SERVER_EXECUTABLE>",
  "model": "<ABSOLUTE_PATH_TO_MAIN_MINICPM_O_GGUF>",
  "working_directory": "<ABSOLUTE_PATH_TO_COMPANION_SERVER_WORKTREE>",
  "output_directory": "<ABSOLUTE_PATH_TO_RUNTIME_OUTPUT_DIRECTORY>",
  "log_file": "<ABSOLUTE_PATH_TO_SERVER_LOG_FILE>"
}
```

All values must be absolute. `executable` and `model` must already be files;
the model filename must end in `.gguf`. `working_directory` must already be a
directory. On Windows the executable basename must be exactly
`llama-omni-server.exe`. Output and log directories are created only after all
fields validate. `server.local.json` is machine-local, ignored by Git, and must
not contain credentials.

The plugin constructs this command as an argument list with `shell=False`; the
UI, prompt, and environment cannot add flags:

```text
llama-omni-server.exe --host 127.0.0.1 --port 9060 -m <MAIN_MODEL_GGUF> -ngl 99 -c 4096 --seed 42 -ctk q4_0 -ctv q4_0 -fa on
```

The managed child receives `OMNI_T2W_FUSED_QKV=0`; the parent environment is
not changed. Initialization is fixed to native audio/TTS, turn-based mode,
an empty Server-init system prompt, the configured output directory, and
`token2wav_device: "gpu:0"`.

### Vulkan runtime contract

- The MiniCPM-o main model runs on Vulkan (`-ngl 99`).
- Token2Wav runs on Vulkan (`token2wav_device: "gpu:0"`).
- `OMNI_T2W_FUSED_QKV=0` is set only in the managed child because that path is
  required by this Vulkan integration.
- HiFiGAN remains on CPU. Do not move it to the GPU when reproducing V2.
- Do not use a SYCL build or deployment for this published configuration.

If you launch the companion Server yourself, reproduce the same device split
and child environment. A compatible Server already healthy on port `9060`
appears as `external`; the plugin will use it for voice but will never adopt,
stop, or kill it.

## User-owned prompt contract

The model prompt belongs entirely to the user:

- The storage key is `userOwnedModelPrompt` in the Desktop plugin's
  `minicpm-native-voice` storage namespace.
- Missing storage defaults to the exact empty string.
- Clearing the field stores the exact empty string.
- The value may contain at most **65,536 UTF-8 bytes**. A value at that exact
  boundary is stored and sent unchanged; an over-limit value is rejected
  before Desktop storage or session start and by the backend API. No boundary
  trims, truncates, or normalizes the value.
- End/Start, route remount, hot reload, and full Desktop restart restore the
  exact stored value, including leading/trailing whitespace.
- The value is sent unchanged as `session.init.payload.system_prompt`.
- The backend serializes the value for that initialization message but does
  not retain it in bridge session state.
- Placeholder text is display-only. Neither Desktop nor the backend adds
  hidden, fallback, coaching, or other model-facing prose.
- Managed Server initialization independently sends an exact empty
  `system_prompt`.

Do not add a default prompt as a convenience change. That would change the
model-facing contract and must be treated as a product change.

## Normal operation

1. Open **English Coach**. The Server status updates every three seconds.
2. Expand **Controls**, expand **Server** with **Details**, and select **Start
   Server** for a configured, stopped Server, or start a
   contract-compatible Server yourself on `127.0.0.1:9060`.
3. Wait for `ready` (managed) or `external` (self-managed).
4. Expand **Prompts** with **Details** and enter an optional prompt. Empty is
   valid and means exactly empty. The Controls and Prompts accordions collapse
   again on route remount.
5. Select **Start** and grant microphone permission.
6. Speak. V2 retains at most 500 ms of pre-roll, starts the 60-second utterance
   allowance when the microphone level reaches the persisted voice-trigger
   threshold (default `0.040`, range `0.005`-`0.100`), and submits after the
   configured 2,000-6,000 ms silence window; select **I'm done** to submit
   sooner. Select **Discard utterance** while listening to clear only the
   current unsent capture. Earlier initial silence is discarded. The
   right-side bubble first shows the native-audio
   duration, then updates in place if display transcription succeeds; prior
   user-right/assistant-left turn pairs remain visible for this runtime. A
   completed turn ignores later text/audio deltas and duplicate completion;
   late display STT may still update its matching user bubble. History keeps at
   most 100 turns and 1 MiB of combined user/assistant UTF-8 text, evicting the
   oldest completed turns first without dropping the active pending turn.
7. Use **Interrupt** to stop playback and create a fresh upstream session with
   the same exact prompt. Use **End** to release the voice session.
8. **Stop Server** first ends voice resources and then stops only the process
   object spawned by this plugin.

## Troubleshooting

| Symptom | Checks and recovery |
|---|---|
| English Coach page is missing | Confirm the complete unified package is under `$HERMES_HOME/plugins/minicpm-native-voice`, run `hermes plugins doctor --ci minicpm-native-voice`, enable the backend with the CLI, enable the Desktop half in **Settings -> Plugins**, then reload Desktop plugins. |
| HTTP `401` or WebSocket authentication failure | Use `ctx.rest`/`ctx.socket` through the signed-in Desktop connection. Do not call plugin routes as anonymous public endpoints. Confirm Desktop points to the same local dashboard/backend and refresh the Hermes login/token-mode session. |
| Server card says `external` on port `9060` | A compatible unowned process answered health. The plugin intentionally disables Start/Stop ownership controls. Stop that process with the tool that launched it, or keep it and use voice. If health is incompatible but the port is occupied, find and stop the owning process outside the plugin. |
| Start Server fails | Validate all five `server.local.json` fields, exact Windows executable basename, main `.gguf`, worktree, writable output/log parents, Vulkan driver, companion build, and free port. Inspect only the configured Server log; path details are intentionally absent from the public status response. |
| Microphone does not start | Check Windows microphone privacy settings, packaged Desktop permission, input device routing, and whether another application owns the device. End the session before retrying. |
| Microphone meter moves but no turn is sent | Speak above the VAD threshold, wait through the selected silence window, or select **I'm done**. Initial silence beyond the 500 ms pre-roll is intentionally ignored; the 60-second allowance starts at speech onset. |
| Ambient noise starts a turn | Raise **Voice trigger threshold**. Changing it discards any current unsent utterance before the new threshold applies, so one capture never mixes thresholds. |
| Prompt is rejected | Encode the exact value as UTF-8 and keep it at or below 65,536 bytes. The plugin never silently trims or truncates an over-limit prompt. |
| No audio events arrive | Verify a local token-mode Desktop/backend connection, Server `/backend` compatibility, and that `/status` reaches `thinking`/`speaking`. OAuth-remote Desktop sockets are unsupported in V2; polling reports state but cannot carry incremental audio. |
| User bubble stays at native-audio duration | Display STT is best-effort. Check the configured Hermes STT provider and credentials, then confirm an already-installed local fallback exists. Failure never blocks native MiniCPM input or voice playback. |
| Audio is distorted, too fast, or too slow | Confirm input is mono 16 kHz little-endian Float32 PCM and output deltas are aligned little-endian Float32 with a correct positive `sample_rate`. Missing Server sample rate falls back to 24 kHz. Check the required Token2Wav/HiFiGAN layout and device split. |
| Prompt is missing or changed | Inspect the `userOwnedModelPrompt` value through plugin behavior, not model logs. Confirm the field was not cleared and that no fork added defaults or trimming. The backend and wire payload must preserve whitespace exactly. |
| Backend or Desktop appears stale after an update | End the voice session, Stop Server if it is managed, restart the dashboard/gateway to remount Python, use **Reload desktop plugins**, and reopen the route. If needed, fully exit and restart packaged Desktop. Do not diagnose stale bytecode by editing production behavior. |

## Data and privacy

- Installed source and `server.local.json` live under
  `$HERMES_HOME/plugins/minicpm-native-voice`.
- The prompt and preferences live in Hermes Desktop's plugin-scoped storage:
  `userOwnedModelPrompt`, `minicpmInputUnderstandingPrompt`,
  `voiceInteractionMode`, `silenceMs`, `voiceTriggerThreshold`, and
  `experimentalBargeIn`. Prompt-section expansion and turn history are not
  persisted.
- Server output and the combined stdout/stderr log live only at the two paths
  selected in `server.local.json`.
- Turn uploads are parsed by FastAPI/Starlette as multipart `UploadFile`
  objects before the route applies its 5 MiB read bound. The framework uses a
  spooled temporary file: an upload may roll from memory into the operating
  system's temporary-file storage, including before an oversized request is
  rejected. The route closes the `UploadFile` after reading or rejection so
  framework-managed temporary storage can be released, but this is not a
  never-disk privacy guarantee. Temporary-file remnants, indexing, backup, and
  endpoint-security behavior depend on the host operating system and its temp
  directory policy.
- Display STT writes each accepted turn to a bounded mono PCM16 WAV in the
  operating-system temporary directory and deletes it after the configured/local
  transcription attempt. The plugin does not retain audio or transcripts in
  plugin storage or logs. Generated bridge events and session-local history are
  memory-bounded, while the companion Server may write artifacts under the
  configured output directory; treat that directory, the configured log, and
  the system temporary directory as potentially containing sensitive voice data
  and secure/clean them according to local policy.
- No credentials, OAuth material, model weights, logs, generated audio, or
  prompt contents belong in source control or bug reports.

## Known limitations and non-goals

- One voice session and one active turn are supported at a time.
- V2 is native-audio turn-taking with best-effort display STT, not STT plus text generation plus TTS.
- Session-local history retains at most 100 turns, 65,536 UTF-8 bytes per user
  or assistant field, and 1 MiB of combined field text. Oldest completed turns
  are evicted first; the active pending turn is retained within its field caps.
- Interrupt creates a fresh upstream session; it does not preserve generation
  state.
- Automatic barge-in is experimental client-side behavior, not strict full
  duplex.
- OAuth-remote Desktop sockets cannot stream incremental audio in V2.
- Managed process ownership is in-memory. After a backend crash/restart, a
  surviving Server is `external` and is never killed automatically.
- Server model weights, Server builds, microphone permission, device routing,
  echo behavior, and audible quality are outside automated CI.
- Vision/video, custom voices, voice cloning, multi-user sessions, remote
  Servers, public port exposure, SYCL, and background recording are non-goals.

## Development checks

From the repository root, create an isolated Python environment and run the
exact checks:

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

On POSIX, activate/use `.venv/bin/python` instead. No `npm install`, model
weights, microphone, or running Server is required for the automated suite.

## Contributing

Keep functional changes separate from documentation and CI changes. Read
[ARCHITECTURE.md](ARCHITECTURE.md), follow the upgrade and acceptance process in
[MAINTENANCE.md](MAINTENANCE.md), run every automated check, and include a
manual acceptance matrix when a runtime boundary changes. Never commit
`server.local.json`, model files, logs, audio, prompts, credentials, or review
artifacts.
