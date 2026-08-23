# Regression tests

Run from this directory:

```bash
node --test plugin.test.cjs
```

The dependency-free harness loads the real `plugin.js` source into a Node `vm`
sandbox with deterministic fakes for the DOM, CSS variables, event listeners,
scroll clamping, timers, `host.onEvent`, and the `activeSessionId` atom.

Coverage:

1. Middle mousedown on a user bubble scrolls the owning turn start to the
   thread viewport top and prevents default plus propagation.
2. A second middle mousedown on the same bubble retreats to the previous turn;
   repeated retreats clamp at the earliest turn.
3. Middle mousedown on a different bubble resets the retreat counter and jumps
   to that bubble's own turn.
4. Ctrl+middle mousedown jumps to the bottom, clears the spacer, and falls back
   to the workspace viewport when the event target is outside any viewport.
5. `metaKey` middle mousedown behaves like Ctrl on macOS.
6. Left mousedown/click, right mousedown, and non-bubble middle mousedown
   (without Ctrl) propagate untouched, with no `pointerdown` or `click`
   listeners installed.
7. Short replies set `--turn-start-extra-clearance` on the clicked viewport
   before `scrollTop` is clamped, with the exact `ceil(shortfall + 2)` value.
8. `message.start`, `activeSessionId` changes, and Ctrl+middle clear the spacer.
9. Tile-viewport middle mousedown writes only the tile viewport; Ctrl+middle
   inside the tile also leaves the workspace viewport untouched.
10. Hot reload disposes the previous instance and installs a working
    replacement; a transient same-module remount reuses the deferred-dispose
    instance.
11. Static source assertions forbid `scrollIntoView`, `window.scroll*`,
    `document.scrollingElement`, `pointerdown`/`click` listeners, and all
    removed double-click/selection machinery. They require the capture-phase
    `mousedown` listener, `button === 1`, the workspace viewport fallback for
    Ctrl+middle, and Ctrl/meta handling.
12. Style assertions verify the preserved blue user-bubble recognition styles,
    turn spacing, clearance calc consumer, the new status copy, and plugin
    identity.
