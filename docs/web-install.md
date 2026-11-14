# Web install

DeeGee's web skills bring part of DeeGee to Claude chat, and to other chat bots that
take uploaded skills. They work entirely inside the chat: they make artifacts and
replies, run no commands, and reach nothing on your computer.

Claude Code and Codex stay the first-class way to run DeeGee. The web skills are
separate, chat-safe versions of a few first-class skills. They don't change the
originals or how those work.

## The skills

| Skill | Adapted from | What it does in chat |
| --- | --- | --- |
| `dg-demo` | `/dg:demo` | Plays a guided tour as an artifact: chapter cards, captions and a highlight on each target, over a mock of the UI (the default) or uploaded screenshots. It also gives back the plan, which `/dg:demo` can later record as a real video. |
| `dg-proto` | `/dg:proto` | Builds UI variants, a clickable walkthrough of a plan, or an interactive state model as one artifact. You pick and refine with chat replies such as `approve C: tighten the spacing`, and the artifact keeps the round history. |

The other skills need your machine, git, the dg CLI, a browser or a mailbox, so they
have no web version.

## Get the ZIPs

macOS / Linux:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --web-only
```

Windows, in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1))) -WebOnly
```

This downloads `dg-web-skills-<version>.zip` from the latest release, checks it
against the release's `SHA256SUMS`, and unpacks it into `./dg-web-skills`: one ZIP
per skill and an `UPLOAD.md`. Nothing else is installed and nothing it downloads is
run.

| `bootstrap.sh` | `bootstrap.ps1` | Effect |
| --- | --- | --- |
| `--dest <dir>` | `-Dest <dir>` | Unpack somewhere other than `./dg-web-skills` |
| `--version <x.y.z>` | `-Version <x.y.z>` | Use that release instead of the newest |

`--web-only` can't be combined with the other install modes, and it has no
environment-variable form.

You can also download `dg-web-skills-<version>.zip` from the
[releases page](https://github.com/detailedghost/dg-ai/releases) and unzip it yourself.

## Upload them to Claude

1. In Claude, open **Customize**, then **Skills**, and choose **Upload a skill**.
2. Upload `dg-demo.zip`, then `dg-proto.zip`. Each one is a separate skill.
3. Turn on code execution in **Settings**, under **Capabilities**, if it isn't on.

Custom skills need a paid plan. On a Team or Enterprise plan, an owner can add the
skills for the whole organization instead. The menu names may differ slightly as
Claude's settings change.

An agent can run the web-only install and hand you the ZIPs, but uploading them is
your step: Claude has no way to add a skill to your account from inside a chat.

## Use them

Ask in plain words. For example:

- "Demo the saved-filters feature from this component code."
- "Make a demo tour over these three screenshots."
- "Prototype three layouts for this settings page."
- "Prototype this plan so I can click through every workflow."

## Build them from a checkout

```bash
mise run package:web -- X.Y.Z
```

This validates every web skill and writes `dist/web/dg-web-skills-X.Y.Z.zip`. The
rules, the shared theme and how the web skills track their first-class sources are in
[`web/README.md`](../web/README.md).
