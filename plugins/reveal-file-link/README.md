# Reveal File Link

Hermes Desktop transcript directive that reveals a local file in Finder or
Explorer without opening the file.

## Usage

Emit the directive as its own assistant-message paragraph:

```text
::reveal-file{path="D:\\path\\report.pptx" label="在文件夹中显示"}
```

The `label` attribute is optional. The path must be an absolute Windows drive,
UNC, or POSIX path. Relative paths, URLs, control characters, and paths longer
than 1024 characters are rejected.

Clicking the link uses the official `ctx.os.revealPath` plugin API. It selects
the path in the system file manager; it does not open the file.

## Install

Copy this directory to:

```text
$HERMES_HOME/desktop-plugins/reveal-file-link/
```

## Test

From the repository root:

```bash
node --check plugins/reveal-file-link/plugin.js
node --test plugins/reveal-file-link/plugin.test.cjs
```
