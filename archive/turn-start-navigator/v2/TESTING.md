# Regression tests

Run from the repository root:

```powershell
node --test .\turn-start-navigator-v2\plugin.test.cjs
```

The dependency-free harness executes the real plugin source with deterministic DOM,
timer, animation-frame, MutationObserver, and browser scroll-clamping fakes.
