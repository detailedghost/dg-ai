# dg

Personal Claude Code utilities.

## Prerequisites

- [Bun](https://bun.sh) on your `PATH` (the skills shell out to `bun`).

## Install

```text
/plugin marketplace add ~/code/dg
/plugin install dg@detailedghost
```

For local development:

```bash
claude --plugin-dir ~/code/dg
```

## Usage

Install the companion browser extension:

```text
/dg:browser-batch install
```

Open a batch of PRs:

```text
/dg:browser-batch open work#1517 work#1518
```

The `install` command adds the companion Chrome/Edge extension that groups tabs.
Tabs group only in the browser profile where you loaded that extension.
