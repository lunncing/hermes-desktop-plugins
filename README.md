# Hermes Desktop Plugins

A small collection of user-maintained plugins for the native [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop app.

## Plugins

| Plugin | Purpose |
|---|---|
| [`token-tracker`](plugins/token-tracker/) | Shows estimated live token throughput and cumulative focused-session token usage in the status bar. |
| [`turn-start-navigator`](plugins/turn-start-navigator/) | Middle-click a user message to jump to that turn; repeated clicks move backward. Ctrl/Command + middle-click returns to the bottom. |
| [`hide-version-pill`](plugins/hide-version-pill/) | Hides the locked version/update pill from the desktop status bar. |
| [`hermes-trace-viewer`](plugins/hermes-trace-viewer/) | Read-only visual session trace: Input/Model/Tools timeline, turn-grouped nodes, filters, details, bounded data, and a future backend adapter seam. |

## Installation

Copy the desired plugin directory into your Hermes desktop plugin root:

```text
$HERMES_HOME/desktop-plugins/<plugin-id>/
```

For example:

```text
$HERMES_HOME/desktop-plugins/token-tracker/plugin.js
```

Hermes watches the directory and normally reloads disk plugins automatically. If necessary, open the command palette and run **Reload desktop plugins**. Plugins can be enabled or disabled under **Settings → Plugins**.

## Compatibility

These plugins use the public `@hermes/plugin-sdk`, but `turn-start-navigator` and `hide-version-pill` also inspect desktop DOM hooks. A future Hermes UI update may require selector maintenance even though the plugin files themselves survive normal Hermes updates.

## Tests

```bash
node --check plugins/token-tracker/plugin.js
node --check plugins/hide-version-pill/plugin.js
node --check plugins/turn-start-navigator/plugin.js
node --test plugins/turn-start-navigator/plugin.test.cjs
node --check plugins/hermes-trace-viewer/plugin.js
node --test plugins/hermes-trace-viewer/plugin.test.cjs
```

Historical v2/v3 snapshots for the navigator are classified under [`archive/`](archive/) rather than left as `.bak` files in the active plugin directory.

## License

MIT — see [LICENSE](LICENSE).
