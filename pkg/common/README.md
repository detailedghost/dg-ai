# @dg/common

Shared TypeScript types and pure utility functions used by both the browser extension (`pkg/extension`) and the skills CLI (`pkg/skills-cli`).

## Contents

- **`src/types.ts`** — `TourScript`, `TourSetup`, `TourStep`, `TourMode`, `StepAdvance`
- **`src/plan-format.ts`** — `toPlanMarkdown`, `validate`, `partitionTourSteps`, `extractScriptFromMarkdown`

## Usage

```typescript
import {
  partitionTourSteps,
  TourScript,
  toPlanMarkdown,
  validate,
} from "@dg/common";
```

`TourScript.setup` is optional. `includeInTour: false` keeps its steps in a
separate, user-paced preparation phase; `true` prepends them to tutorial and
recording playback. Use `partitionTourSteps()` wherever playback order matters.

This package uses Bun workspace resolution. Run `bun install` from the repo root.
