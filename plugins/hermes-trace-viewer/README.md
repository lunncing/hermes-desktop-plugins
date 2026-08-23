# Hermes Trace Viewer

`hermes-trace-viewer` is a read-only Hermes Desktop plugin that projects persisted session messages into a native trace-inspection page. It adds:

- the `/trace` workspace route;
- a `轨迹` / `Trace` sidebar item;
- an `打开轨迹检查器` / `Open Trace Viewer` Command Palette action;
- a three-lane Input / Model / Tools timeline, turn-grouped trace rows, search and lane filters, and a responsive detail inspector;
- a visible `布局 V4 / Layout V4` revision badge in the page header for packaged live verification.

## Install

Copy this directory to the active Hermes Desktop plugin directory so the folder name and plugin id are both `hermes-trace-viewer`:

```text
<HERMES_HOME>/desktop-plugins/hermes-trace-viewer/plugin.js
```

`HERMES_HOME` is normally `~/.hermes`. A named profile commonly uses `~/.hermes/profiles/<profile>/`. Confirm the active path with `hermes doctor` or Settings → Plugins, then use **Reload desktop plugins** from the Command Palette if the file watcher has not already loaded it.

The runtime is a single uncompiled `plugin.js`. It has no package-manager dependencies and must not be installed with `node_modules`.

## Capabilities

V2 normalizes a maximum of 500 persisted messages per selected session into a stable node shape. It requests the newest bounded page, including compacted messages, in chronological display order. It infers turns, separates assistant reasoning, projects tool calls/results, caps recent sessions at 100, and retains at most 1,000 completion events.

Preview and Raw recursively sanitize object and array values without mutating their source. JSON-shaped strings are parsed and recursively redacted; non-JSON strings redact common single-line `:`, `=`, and Bearer-style values for `api_key`, `apikey`, `token`, `authorization`, `password`, `secret`, and `cookie`. This is an explicit key/value contract, not arbitrary natural-language secret detection.

The adapter reports:

```js
{
  persistedMessages: true, // false if the Desktop REST bridge is absent
  contextNodes: false,
  exactDurations: false,
  sourceMetadata: false,
  liveEvents: true
}
```

Historical reads use the current Desktop preload REST bridge through one isolated, capability-checked adapter function that preserves the bridge method receiver. A non-empty current `host.state.profile` value is trimmed and attached to each request. The session selector only reads data; it never activates, resumes, archives, renames, or otherwise mutates a session. With no focused or active session, the first valid recent session is selected after listing. A `message.complete` event refetches only the directly selected identity or the active runtime identity mapped to the selected focused stored session, with no polling.

## V4 runtime layout contract

Packaged Desktop builds its stylesheet with Tailwind at build time and never scans runtime plugins, so layout-critical geometry is applied through React inline styles from one exported contract, `TRACE_LAYOUT`:

```js
{
  traceRowGrid: 'auto minmax(0, 1fr) auto', // badge | content | timestamp
  summaryRowGrid: '7rem minmax(0, 1fr)',    // detail label | value
  wideSplitGrid: 'minmax(0, 1fr) 22rem',    // list | detail
  narrowSplitGrid: 'minmax(0, 1fr)',        // stacked list + detail
  traceListHeight: 'min(42rem, 55vh)',      // trace list panel shell
  traceListMinHeight: '12rem',              // bounded floor on short viewports
  detailHeight: 'min(34rem, 48vh)',         // detail panel shell
  detailMinHeight: '10rem'                  // bounded floor on short viewports
}
```

V3 passed its Node suite but still overlapped in packaged Desktop because the host `ScrollArea`'s real Radix Viewport behavior is not represented by the Node stub, and the empty detail state bypassed the panel shell entirely. V4 therefore fixes three confirmed live overlap cases with explicit containment instead of more classes:

1. **No selected node:** the detail `EmptyState` no longer floats over REASONING rows. `DetailPanel` always returns the same bordered `aside` shell, and the empty state renders inside the constrained detail body.
2. **Selected node:** the Summary/Preview/Raw/Source field set can no longer overlay trace rows. The detail body scrolls inside the bounded shell.
3. **List border overflow:** later Assistant/Reasoning rows can no longer draw past the TraceList border. The bordered shell clips overflow and the rows scroll inside it.

The containment contract is inline and explicit:

- Panel shells (TraceList `section`, DetailPanel `aside`): `display: 'flex'`, `flexDirection: 'column'`, bounded contract `height`/`minHeight` from `TRACE_LAYOUT`, `minWidth: 0`, `overflow: 'hidden'`. The border wraps the complete visible shell.
- Panel bodies: plain `div` elements (no `ScrollArea`; the import is removed) with `flex: '1 1 auto'`, `minHeight: 0`, `minWidth: 0`, `overflowY: 'auto'`, `overflowX: 'hidden'`.
- List/detail split: inline `display: 'grid'` with `gridTemplateColumns` from `splitGridColumns(wide)`, `alignItems: 'start'`, a bounded `0.75rem` gap, and `minWidth: 0`. TraceList and DetailPanel are separate grid items, so narrow mode stacks them in separate rows without overlap.

The page header shows a deliberate bilingual revision badge, `布局 V4 / Layout V4` (registered as `layoutRevisionZh` / `layoutRevisionEn` in both locales), so packaged live verification can confirm the deployed revision without opening details. Cosmetic properties keep standard host utilities that exist in the packaged stylesheet; the Node suite proves the element tree and inline style contracts, and packaged Desktop remains the final visual gate.

## Limitations

- Timeline blocks represent message timestamps with deterministic minimum widths. They are point-in-time estimates, not exact node durations.
- The current backend does not expose per-turn injected context, so the UI shows one capability notice and does not fabricate context nodes.
- The current session REST response does not provide authoritative per-node source metadata, model start/end times, retries, fallbacks, or compression boundaries.
- Without the Desktop REST bridge, the plugin degrades to an explicit current-session-only capability/error state.
- Registered-remote cross-connection routing remains a V1 limitation because the SDK does not expose an authoritative remote `connectionId`; the plugin does not invent one.
- Runtime UI behavior must still be checked inside Hermes Desktop; the Node suite verifies normalization, adapter calls, security, bounds, lifecycle, and registration without bundling the host application.

The V4 candidate has passed 25 automated tests, 10 bounded repetitions, and a full-code Codex review. Final packaged Desktop pixel acceptance remains a manual release gate; see [TESTING.md](./TESTING.md) and [RETROSPECTIVE.md](./RETROSPECTIVE.md).

## Future backend extension contract

The UI consumes only normalized trace nodes and the adapter API (`listSessions`, `loadSession`, `normalizeMessages`, `subscribe`, `capabilities`). A future version can replace the V1 message adapter with a versioned `trace.*` backend adapter without changing the page information architecture.

That backend may add exact `context.injected`, `model.started`, `model.completed`, `tool.started`, and `tool.completed` events plus retry, fallback, compression, and parent/child metadata. It should populate the reserved `startedAt`, `endedAt`, `durationMs`, `sourcePath`, `parentId`, and `metadata` fields, set the corresponding capability flags truthfully, and preserve the existing normalized node contract.

See [TESTING.md](./TESTING.md) for automated and live checks.
