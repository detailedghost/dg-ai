---
name: what-changed
description: Draft release notes or a changelog from a repository's tags, merged pull requests, and commits for a requested release or range. Supports technical notes for engineers and non-technical notes for non-engineers. Use when asked what changed or what shipped, for "/dg:what-changed", "release notes", "technical release notes", "non-technical release notes", "changelog", or to prepare release copy; publishing is a separate action. Flags: -t/--technical (default), -n/--nontechnical, or both; -d/--demo runs /dg:demo on the user-visible changes after the notes; an optional range argument overrides the default range.
---

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills stash --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor stash.

# What Changed

Draft notes grounded in the code that actually belongs to the release.

## Flags

**Usage:** `/dg:what-changed [-t | --technical] [-n | --nontechnical] [-d | --demo] [<range>]`

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--technical` | `-t` | Engineers. Changes by Conventional Commit type and scope, with PR numbers and links. Breaking changes and migration steps. Config and env var changes. Infra and deploy notes. Dependency bumps. | on when no audience flag is given |
| `--nontechnical` | `-n` | Non-engineers. User-facing changes grouped as New, Improved, Fixed. No commit types, internal refactors, CI, chores or dependency bumps unless users can see the effect. Short plain sentences, no jargon. | off |
| `-t -n` | none | Both sections in one output, technical first. | off |
| `--demo` | `-d` | After the notes, demo the user-visible changes with `/dg:demo`. See step 6. Combines with any audience flag. | off |
| `<range>` | none | An explicit range, tag, commit or date. It overrides the default range. | the range from `scripts/range.ts` |

With neither audience flag, use `--technical`.

## Default range

With no range argument, run `bun run <skill-dir>/scripts/range.ts` (`<skill-dir>` is this skill's base directory) in the repo. It prints JSON with the range. To override, pass the range as the first argument.

The script computes:

1. Fetch `origin` and its tags.
2. Default branch: `git symbolic-ref refs/remotes/origin/HEAD`. Fallback: `gh repo view --json defaultBranchRef`, or `glab repo view` on GitLab.
3. Last release: the latest provider release (`gh release list` or the GitLab releases API) that exists as a local tag. Fallback: the latest semver tag reachable from `origin/<default>`.
4. Range: `<last-release-tag>..origin/<default>`. It never uses the current checkout's HEAD, so it is safe on a feature branch.
5. With no release and no tag, the range is `origin/<default>` alone (the whole history). Say so in the output.

If the range holds no commits, say that nothing has merged since the last release.

## Steps

1. Establish the range. Honor tags, commits, dates, or a release named by the user. Otherwise use the default range above. Tag names alone may not reflect ancestry, so check the remote refs and release record.
2. Collect merged pull requests and commits in that range. Use the repository's provider and link each included change to its PR or commit. Check the diff, migration, or release workflow when a title does not establish the shipped behavior. Exclude changes outside the range, even when their PR closed during it.
3. Group the changes for the chosen audience (see Flags). Explain concrete effects in plain language. In technical notes, mention dependencies only when they are bumps worth listing; in non-technical notes, mention them only when users see the effect.
4. Distinguish merged code from deployed code. State the release target and any unverified rollout, test, or migration condition plainly. Do not claim a change shipped to production based only on a merged PR or a green build.
5. Deliver a concise draft with its range and source links. Follow an existing repository release-note format when present. If the user asks to update a file, edit that file and verify the diff. Create a tag, GitHub release, or external announcement only when the user authorizes that action.
6. With `--demo`, after the notes:
   1. List the user-visible changes from the range as demo candidates, one per PR, each with its PR number and one line on what to show. Skip CI, chores, refactors, dependency bumps and changes with no visible effect.
   2. Ask the user which candidates to demo. Invoke the `demo` skill once per chosen PR with the PR number as its argument, one at a time, and let it run its own confirmation and format prompts. Pass `--attach-pr` only when the user asks for it.
   3. Save the notes as `what-changed-notes.md` in `$(~/.dg/bin/dg-skills stash -G demo)/`, next to the videos, with a table of the video files and what each one shows.
   4. On WSL, also copy the notes and the videos to `/mnt/c/Users/<user>/Downloads`.
   5. Print the full notes in chat, with the path of every saved file.
   - The final combined video always starts with an introduction title card.
   - Render the card at 1440x900 in Chromium with Playwright. Name an installed sans-serif font explicitly (check with `fc-list`) and keep the font name in your local config, not in this skill. Headless Chromium can map `system-ui` to a monospace font.
   - The card shows the product logo (use the logo file the repository ships, such as the one its README references; ask the user when there is none), the title "What's new in <product>", the upcoming version (read it from the release workflow's version step, or ask the user when the workflow does not state it), and a short list of the user-visible changes in the same order as the video.
   - Show the card for about 6 seconds with a short fade. Then use ffmpeg to join the demo parts after it into one video.
   - With `-n`, captions and cards must not show PR numbers such as "#1234" or technical terms.
   - Before rendering, edit all card and caption text. Cut filler openers, hedges, and stock phrases such as "In today's fast-paced world". Use short, concrete, active sentences.

If a range or release target cannot be established from repository evidence, draft the parts that are known and ask for the missing boundary.
