# Testing Hermes Trace Viewer

Run from `plugins/hermes-trace-viewer/`.

## Automated checks

```bash
node --check plugin.js
node --test plugin.test.cjs
```

The suite uses only Node built-ins and requires no `node_modules`.

For a bounded stress repetition on POSIX shells:

```bash
for i in $(seq 1 10); do
  node --test plugin.test.cjs || exit $?
done
```

PowerShell equivalent:

```powershell
1..10 | ForEach-Object {
  node --test plugin.test.cjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

## What the 25-test suite covers

- deterministic System/User/Assistant/Reasoning/Tool normalization and turn inference;
- recursive secret redaction, including JSON-shaped strings and common key/value text forms;
- search, lane filters and timeline geometry;
- 500-message, 100-session and 1,000-event bounds;
- read-only Desktop REST adapter behavior, profile scoping and newest-page loading;
- runtime/stored session ID refresh mapping;
- listener cleanup and hot-reload disposal;
- route/sidebar/Command Palette registration and localization;
- inline runtime layout contract for rows, panel shells and responsive split grid;
- identical bordered DetailPanel shells for empty and selected states;
- native DOM scrolling and clipping without Radix `ScrollArea` in the two critical panels;
- V4 revision marker rendering;
- absence of console diagnostics, polling, direct network access, hardcoded colors and unauthorized imports.

## Required packaged Desktop checks

Automated tests cannot prove final pixels. In a packaged Hermes Desktop build:

1. Install the plugin under `$HERMES_HOME/desktop-plugins/hermes-trace-viewer/` and reload desktop plugins.
2. Open **Trace** and confirm the `Layout V4` / `布局 V4` marker is visible.
3. With no node selected, confirm the empty detail state remains inside its own border and never overlays trace rows.
4. Select nodes and check Summary, Preview, Raw and Source; content must scroll inside the detail border.
5. Open a long session and confirm every trace row scrolls inside the TraceList border rather than painting below it.
6. Resize between wide and narrow layouts; list and detail must remain separate and stack cleanly.
7. Exercise search, lane filters, session selection, newest-500 loading and live refresh.
8. Verify secret-shaped values are redacted in Preview and Raw.
9. Repeatedly reload/disable the plugin and confirm no duplicate refreshes or listeners.

## Evidence boundary

A green Node suite proves data transformations, registration, containment props and lifecycle rules. It does not prove packaged host CSS, actual Radix behavior, renderer warnings, remote connection routing or visual quality. Treat a real Desktop check as a release gate, not an optional demonstration.
