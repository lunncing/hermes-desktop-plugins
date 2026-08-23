# Token Tracker

Hermes Desktop status-bar plugin that displays:

- an estimated live generation/reasoning rate based on gateway delta events;
- cumulative token usage for the focused session.

The live `tok/s` value is an event-rate estimate, not an authoritative tokenizer count. Final cumulative usage comes from `host.state.focusedUsage`.

## Install

Copy this directory to:

```text
$HERMES_HOME/desktop-plugins/token-tracker/
```

Then enable **Token Tracker** under **Settings → Plugins**.
