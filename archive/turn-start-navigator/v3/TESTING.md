# Regression tests

Run from this directory:

```bash
node --test plugin.test.cjs
```

The dependency-free harness loads the real `plugin.js` source into a Node `vm`
sandbox with deterministic fakes for the DOM, CSS variables, event listeners,
scroll clamping, `getSelection`, `Date.now`, timers, `host.onEvent`, and the
`activeSessionId` atom.

Coverage:

1. Single click on a user bubble scrolls the owning turn start to the thread
   viewport top (`pointerdown` stops propagation, `click` also prevents default).
2. Double-click second strike (`detail=2`, same `data-message-id`, within 400 ms)
   is released without navigation, including a click-only event sequence; rapid
   clicks on two different questions are not mistaken for a double click.
3. Clicks with a non-collapsed text selection are released, even when the
   selection was observed at `pointerdown` and collapses before `click`.
4. Clicks on non-bubble transcript elements are released.
5. Short replies set `--turn-start-extra-clearance` on the clicked viewport before
   `scrollTop` is clamped, with the exact `ceil(shortfall + 2)` value.
6. `message.start` and `activeSessionId` changes clear the spacer.
7. Tile-viewport clicks write only the tile viewport, never the workspace one.
8. Hot reload disposes the previous instance and installs a working replacement;
   a transient same-module remount reuses the deferred-dispose instance.
9. Static source assertions forbid `scrollIntoView`, `window.scroll*`,
   `document.scrollingElement`, `document.querySelector`, `MutationObserver`,
   and the removed v2 auto-scroll machinery.
10. Style assertions verify the preserved blue user-bubble recognition styles,
    turn spacing, clearance calc consumer, status copy, and plugin identity.
