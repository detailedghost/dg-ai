# Commands and recovery

## Extension precondition

Gate this skill before scrape on the installer marker used by
`isProtoExtensionInstalled` and `markerPath`:

```bash
INSTALL_MARKER="$HOME/.config/dg/browser-batch-installed"
if [ ! -f "$INSTALL_MARKER" ]; then
  echo "dg-ai-extension is not installed; run the browser skill's install command first."
  exit 1
fi
```

This is the proto skill's own precondition. Do not delegate to another prototype
skill and do not attempt scrape when the marker is absent.

The marker proves the installer completed, not that the extension is enabled in
the current browser profile. If scrape times out, report:

> Prototype scrape timed out. Run the browser skill's `install` command,
> confirm the extension is enabled in the browser that opened, and retry. Also
> disable “ask where to save each file” and check whether Downloads was
> relocated.

## CLI bootstrap

Use a freshly compiled binary in a development checkout; otherwise use the
installed binary and bootstrap it once if missing:

```bash
DG="$HOME/.dg/bin/dg-skills"
SRC=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] &&
  [ -f "$CLAUDE_PLUGIN_ROOT/pkg/skills-cli/package.json" ]; then
  SRC="$CLAUDE_PLUGIN_ROOT/pkg/skills-cli"
elif [ -f "$PWD/pkg/skills-cli/package.json" ]; then
  SRC="$PWD/pkg/skills-cli"
fi
if [ -n "$SRC" ]; then
  ( cd "$SRC" && bun run build ) && DG="$SRC/dist/dg-skills"
fi
if [ ! -x "$DG" ]; then
  if [ -n "$SRC" ]; then
    sh "$SRC/bootstrap.sh"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

On Windows PowerShell, use the checkout's `bootstrap.ps1` when a local source
tree was found; otherwise pipe the repository's raw `bootstrap.ps1` to
`Invoke-Expression`.

If extension source changed in a dev checkout, also rebuild the extension and
reload the unpacked extension in the browser; the browser does not execute CLI
source code.

## Scrape

Warn about authenticated/private page inspection and obtain explicit
confirmation first when applicable. Then run:

```bash
STYLE_GUIDE="$("$DG" proto scrape "$URL")"
SLUG="$(basename "$(dirname "$STYLE_GUIDE")")"
PLAN="/tmp/ai/proto/$SLUG/plan.json"
mkdir -p "$(dirname "$PLAN")"
```

The command blocks until the extension downloads and validates the StyleGuide.
Use its printed stable path; do not guess a slug.

## Plant and claim

Write the approved ProtoPlan to `$PLAN`, then invoke plant from the target
project root:

```bash
( cd "$TARGET_ROOT" && "$DG" proto plant "$PLAN" )
```

The command clears the prior same-slug verdict before opening the browser and
blocks for a fresh Verdict. Its stdout is authoritative:

- Approve prints `.agents/prototype/<slug>/index.html` after export completes.
- Reject prints the feedback and tells the agent to rework and re-plant the same
  slug.

Do not poll Downloads independently or fabricate a Verdict.

## Cleanup

After an approved export and only from the target project root, run:

```bash
( cd "$TARGET_ROOT" && "$DG" proto cleanup "$SLUG" )
```

Cleanup requires `.agents/prototype/<slug>/NOTES.md`. It removes
`Downloads/dg-proto/<slug>/` and stable agent scratch, is safe to repeat, and
never removes the exported answer.
