# @dg/common

Shared TypeScript types and pure utility functions used by both the browser extension (`pkg/extension`) and the skills CLI (`pkg/skills-cli`).

## Contents

- **`src/types.ts`** — `TourScript`, `TourStep`, `TourMode`, `StepAdvance`
- **`src/plan-format.ts`** — `toPlanMarkdown`, `validate`, `extractScriptFromMarkdown`

## Usage

```typescript
import { TourScript, toPlanMarkdown, validate } from "@dg/common";
```

This package uses Bun workspace resolution. Run `bun install` from the repo root.
