<!-- Quality learnings. Max 100 lines. Prune oldest when full. -->
<!-- Format: - [YYYY-MM-DD] one learning per line, concise and actionable -->
<!-- Any agent may add entries. Prune the oldest lines when the file passes 100 lines. -->
- [2026-11-19] Run every code review with local Codex, three rounds per change.
- [2026-11-19] When Codex is out of quota, run 3 antagonistic `/dg:thrash -s 4` local rounds. A quota failure is not a dry round.
- [2026-11-19] Never use Copilot for review.
- [2026-11-19] Agents never merge unless Dante said merge on green or `--auto`.
- [2026-11-19] Get one approval for a batch of PRs before opening any.
- [2026-11-19] Write no inline code comments.
- [2026-11-19] Add no Co-Authored-By trailers.
- [2026-11-20] A spec that passes `--state` to prototype or verify must set `AI_STATE_DIR` to a temp dir and save a fake state; otherwise pw states resolve to the user's real state root.
- [2026-11-20] Do not set `TMPDIR` for a full `bun test` in pkg/skills-cli: pw/protected-session.spec and the path fence expect `/tmp`.
- [2026-11-20] When a verb ships, delete the older docs spec check that bans it. Do not add a per-file exemption.
