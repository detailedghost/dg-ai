# Project Vocabulary Reference

## Domain Terms

| Term | Definition |
|------|------------|
| **Live-page prototype** | A throwaway comparison of app-native interface choices rendered inside a real page. _src:_ plugins/dg/skills/proto/SKILL.md |
| **Prototype answer** | The durable approved variation exported under `.agents/prototype`. (avoid: answer) _src:_ plugins/dg/skills/proto/SKILL.md |

## Architectural Patterns

| Term | Summary |
|------|---------|
| **Canonical serialization** | Style guides serialize with stable key order for repeatable handoffs. _src:_ pkg/common/src/proto-format.ts |
| **Shadow-root rendering** | Prototype controls render in closed shadow roots to isolate page styles. _src:_ pkg/extension/lib/features/prototype.ts |
| **Double sanitization** | Prototype markup is sanitized before planting and again before export. _src:_ pkg/common/src/proto-format.ts |
| **Bounded sampling** | Style scraping enforces fixed limits on page inspection and output. _src:_ pkg/extension/lib/features/prototype.ts |
| **Completion marker** | `NOTES.md` proves every durable prototype answer finished exporting. _src:_ pkg/skills-cli/src/commands/proto.ts |

## Concepts

| Term | Summary |
|------|---------|
| **TourSetup** | Optional preparation that runs before or inside the tutorial. _src:_ pkg/common/src/types.ts |
| **Stepper editor** | The required live-page review gate before tour playback or recording. _src:_ plugins/dg/skills/demo/SKILL.md |
| **Recording bundle** | A downloaded archive containing a tour video and its rerunnable plan. _src:_ plugins/dg/skills/demo/SKILL.md |
| **StyleGuide** | A bounded snapshot of a live page's visual tokens and controls. _src:_ pkg/common/src/types.ts |
| **ProtoPlan** | The validated comparison contract transported to the extension. _src:_ pkg/common/src/types.ts |
| **ProtoVariation** | One self-contained HTML and CSS choice in a prototype comparison. _src:_ pkg/common/src/types.ts |
| **Prototype picker** | The live-page control that previews and selects prototype variations. _src:_ pkg/extension/lib/picker.ts |
| **Verdict** | The user's explicit approval or feedback-bearing rejection of one variation. _src:_ pkg/common/src/types.ts |
| **Reject loop** | The rework cycle that preserves the slug and incorporates fresh feedback. _src:_ plugins/dg/skills/proto/SKILL.md |
