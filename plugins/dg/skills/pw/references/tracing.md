# Tracing

Capture detailed execution traces for debugging and analysis. Traces include DOM snapshots, screenshots, network activity, and console logs.

## Basic Usage

```bash
dg pw open
dg pw tracing-start

dg pw goto https://example.com
dg pw click e1
dg pw fill e2 "test"

dg pw tracing-stop
```

## Trace Output File

`dg pw tracing-stop` saves one zip: `$(dg stash pw trace-<ts>.zip)` (or under `--out=<dir>`). It holds the action log, network log, DOM snapshots, screenshots, and resources. Open it with `npx playwright show-trace <file>`.

## What Traces Capture

| Category | Details |
|----------|---------|
| **Actions** | Clicks, fills, hovers, keyboard input, navigations |
| **DOM** | Full DOM snapshot before/after each action |
| **Screenshots** | Visual state at each step |
| **Network** | All requests, responses, headers, bodies, timing |
| **Console** | All console.log, warn, error messages |
| **Timing** | Precise timing for each operation |

## Use Cases

### Debugging Failed Actions

```bash
dg pw open
dg pw tracing-start
dg pw goto https://app.example.com

dg pw click e5

dg pw tracing-stop
```

### Analyzing Performance

```bash
dg pw open
dg pw tracing-start
dg pw goto https://slow-site.com
dg pw tracing-stop
```

### Capturing Evidence

```bash
dg pw open
dg pw tracing-start

dg pw goto https://app.example.com/checkout
dg pw fill e1 "4111111111111111"
dg pw fill e2 "12/25"
dg pw fill e3 "123"
dg pw click e4

dg pw tracing-stop
```

## Trace vs Video vs Screenshot

| Feature | Trace | Video | Screenshot |
|---------|-------|-------|------------|
| **Format** | .zip trace | .webm video | .png/.jpeg image |
| **DOM inspection** | Yes | No | No |
| **Network details** | Yes | No | No |
| **Step-by-step replay** | Yes | Continuous | Single frame |
| **File size** | Medium | Large | Small |
| **Best for** | Debugging | Demos | Quick capture |

## Best Practices

### 1. Start Tracing Before the Problem

```bash
dg pw open
dg pw tracing-start
dg pw goto https://example.com
dg pw tracing-stop
```

Run every step that leads to the issue between start and stop.

### 2. Clean Up Old Traces

Traces can use a lot of disk. They live in scratch and expire after 14 days. Ask the user before deleting earlier.

## Limitations

- Traces add overhead to automation
- Large traces can consume significant disk space
- Some dynamic content may not replay perfectly
