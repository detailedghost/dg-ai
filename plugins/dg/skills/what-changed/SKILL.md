---
name: what-changed
description: Draft release notes or a changelog from a repository's tags, merged pull requests, and commits for a requested release or range. Supports technical notes for engineers and non-technical notes for non-engineers. Use when asked what changed or what shipped, for "/what-changed", "release notes", "technical release notes", "non-technical release notes", "changelog", or to prepare release copy; publishing is a separate action. Flags: -t/--technical (default), -n/--nontechnical, or both; -d/--demo runs /demo on the user-visible changes after the notes; an optional range argument overrides the default range.
---

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

# What Changed

Draft notes grounded in the code that actually belongs to the release.

## Flags

| Flag | Audience | Content |
|------|----------|---------|
| `-t`, `--technical` (default) | Engineers | Changes by Conventional Commit type and scope, with PR numbers and links. Breaking changes and migration steps. Config and env var changes. Infra and deploy notes. Dependency bumps. |
| `-n`, `--nontechnical` | Non-engineers | User-facing changes grouped as New, Improved, Fixed. No commit types, internal refactors, CI, chores or dependency bumps unless users can see the effect. Short plain sentences, no jargon. |
| `-t -n` | Both | Both sections in one output, technical first. |
| `-d`, `--demo` | Any | After the notes, demo the user-visible changes with `/demo`. See step 6. Combines with any audience flag. |
| `<range>` | Any | An explicit range, tag, commit or date. It overrides the default range. |

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
6. With `--demo`, after the notes, list the user-visible changes from the range as demo candidates, one per PR, each with its PR number and one line on what to show. Skip CI, chores, refactors, dependency bumps and changes with no visible effect. Ask the user which candidates to demo. Then invoke the `demo` skill once per chosen PR with the PR number as its argument, one at a time, and let it run its own confirmation and format prompts. Pass `--attach-pr` only when the user asks for it. When the demos are done, save the notes as `what-changed-notes.md` in `$("$DG" stash -G demo)/`, next to the videos, with a table of the video files and what each one shows. On WSL, also copy the notes and the videos to the Windows Downloads folder. Print the full notes in chat, with the path of every saved file.
   - The final combined video always starts with an introduction title card.
   - Render the card at 1440x900 in Chromium with Playwright. Set the font to `Adwaita Sans` by name on this machine. Headless Chromium maps `system-ui` to a monospace font.
   - The card shows the product logo, the title "What's new in <product>", the upcoming version (the next version that the release workflow will compute), and a short list of the user-visible changes in the same order as the video.
   - Show the card for about 6 seconds with a short fade. Then use ffmpeg to join the demo parts after it into one video.
   - With `-n`, captions and cards must not show PR numbers such as "#1234" or technical terms.
   - Run `/unslop` on all card and caption text before rendering.

If a range or release target cannot be established from repository evidence, draft the parts that are known and ask for the missing boundary.
