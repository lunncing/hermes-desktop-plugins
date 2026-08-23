# Turn Start Navigator

Hermes Desktop navigation and readability plugin.

## Controls

- Middle-click a user message: move that turn to the top of the transcript.
- Repeated middle-clicks on the same message: walk backward through earlier turns.
- Ctrl/Command + middle-click: return to the bottom.

The plugin also adds theme-aware user-bubble emphasis and extra spacing between turns.

## Install

Copy this directory to:

```text
$HERMES_HOME/desktop-plugins/turn-start-navigator-v2/
```

The installed folder must retain the plugin ID `turn-start-navigator-v2` declared in `plugin.js`.

## Test

```bash
node --test plugin.test.cjs
```

See [TESTING.md](TESTING.md) for detailed coverage.
