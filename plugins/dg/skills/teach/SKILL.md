---
name: teach
description: Teach the user a new skill or concept within the current workspace, across multiple sessions.
---

The user has asked you to teach them something. This is a stateful request — they intend to learn the topic over multiple sessions.

## Teaching Workspace

Treat the current directory as a teaching workspace. The state of their learning is captured in several files:

- `MISSION.md`: Why the user is interested in the topic. Use the format in [MISSION-FORMAT.md](./references/MISSION-FORMAT.md).
- `./reference/*.html`: Compressed learnings — cheat sheets, reference algorithms, syntax, glossaries. Designed for quick reference and beautiful printing.
- `GLOSSARY.md`: Shared terms for the topic. Use the format in [GLOSSARY-FORMAT.md](./references/GLOSSARY-FORMAT.md).
- `RESOURCES.md`: Trusted sources and communities. Use the format in [RESOURCES-FORMAT.md](./references/RESOURCES-FORMAT.md).
- `./learning-records/*.md`: ADR-equivalent records of what the user has learned. Titled `0001-<dash-case-name>.md`, incrementing. Use the format in [LEARNING-RECORD-FORMAT.md](./references/LEARNING-RECORD-FORMAT.md).
- `./lessons/*.html`: Self-contained HTML lessons, one tightly-scoped thing per file. Titled `0001-<dash-case-name>.html`, incrementing. Primary unit of teaching.
- `NOTES.md`: User preferences and working notes for you.

Create directories lazily — only when first needed.

## Philosophy

To learn at a deep level the user needs:
- **Knowledge** — from high-quality, high-trust resources
- **Skills** — acquired through interactive lessons you devise
- **Wisdom** — from interacting with other learners and practitioners

Before `RESOURCES.md` is well-populated, focus on finding high-quality resources first. Never trust parametric knowledge alone.

### Fluency vs Storage Strength

- **Fluency strength**: in-the-moment retrieval
- **Storage strength**: long-term retention — the real goal

Design lessons for storage strength via desirable difficulty: retrieval practice, spacing, interleaving (for skills only).

## The Mission

Every lesson must be tied to the mission. If `MISSION.md` is missing or vague, interview the user before writing anything. A bad mission is worse than no mission.

Missions may evolve — update `MISSION.md` and write a learning record when they do. Confirm with the user first.

## Zone of Proximal Development

Each lesson should challenge the user "just enough." If the user doesn't specify what to learn, determine their ZPD by reading their `learning-records/` and matching to the mission. Teach the most relevant thing in range.

## Routing

| Task | Read |
|---|---|
| Writing lessons, reference documents, or delegating a question to community | `references/content-types.md` |

## `NOTES.md`

Record user preferences about how they want to be taught here. Consult it when designing lessons.
