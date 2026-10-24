# Extension commands and recovery

These commands run the `--ext` flow. Every one carries `--ext`; without it `dg-skills proto` runs the local mode.

If a step fails, run ~/.dg/bin/dg-skills doctor proto prototype stash.

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

This is the extension flow's own precondition. When the marker is absent, stop and
tell the user; do not attempt scrape and do not fall back to the local mode unasked.

The marker proves the installer completed, not that the extension is enabled in
the current browser profile, or that it is paired to a live `dg-daemon` session.
`scrape` and `plant` run entirely over that daemon relay now: they connect to the
sole `dg-daemon` session matching the current working directory (pass
`--session <id>` to pick a different one), send the daemon a request, and wait
for the paired extension to answer. If no daemon is running, or no session is
registered, or no extension is paired to the session, the command fails fast
with a message naming the problem — it never falls back to a Downloads
timeout. If scrape or plant times out anyway, report:

> Prototype scrape timed out. Run the browser skill's `install` command, confirm
> the extension is enabled in the browser that opened, confirm it is paired to
> this session (open the daemon's printed `/start#_chat=` URL in that browser),
> and retry.

A typed not-ready error (`login-page`, `http-error`, `redirected`, or
`mount-missing`) means the extension reached a page it could not scrape or
plant against. The command's stderr names the code, the reason, and the URL
the browser actually landed on — read that before retrying; retrying into the
same login wall or redirect will not help.

## CLI bootstrap

Use the installed binary at `~/.dg/bin/dg-skills`; install or refresh it when it
is missing or too old. In a development checkout, rebuild and reinstall it first:

```bash
~/.dg/bin/dg-skills proto --ext --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.1/pkg/skills-cli/bootstrap.sh | sh
```

On Windows PowerShell, pipe the repository's raw `bootstrap.ps1` to
`Invoke-Expression`.

If extension source changed in a dev checkout, also rebuild the extension and
reload the unpacked extension in the browser; the browser does not execute CLI
source code.

## Scrape

Warn about authenticated/private page inspection and obtain explicit
confirmation first when applicable. Then run:

```bash
STYLE_GUIDE="$(~/.dg/bin/dg-skills proto --ext scrape "$URL")"
SLUG="$(basename "$(dirname "$STYLE_GUIDE")")"
PLAN="/tmp/ai/proto/$SLUG/plan.json"
mkdir -p "$(dirname "$PLAN")"
```

The command opens the marked page in the paired browser through the daemon relay and blocks until
the extension collects and validates the StyleGuide, with a 45-second default `--timeout` (an
extension round-trip, not a human decision). Pass `--session <id>` when more than one session is
registered. Use its printed stable scratch path; do not guess a slug.

## Plant and claim

Write the approved ProtoPlan to `$PLAN`, then invoke plant from the target
project root:

```bash
( cd "$TARGET_ROOT" && ~/.dg/bin/dg-skills proto --ext plant "$PLAN" )
```

The command opens the marked page in the paired browser through the daemon relay and blocks for a
fresh Verdict, with a 900-second default `--timeout` (a human reviewing the page, not a download).
Pass `--session <id>` when more than one session is registered. Its stdout is authoritative:

- Approve with no notes prints `.agents/prototype/<slug>/index.html` after export
  completes. The chain is over.
- Approve with notes exports the round, then prints `Prototype approved with notes
  (refine):`, the selected key, the notes, and the instruction to build the next
  round from that variation. Do not clean up.
- Tweak prints `Prototype tweak requested (refine):`, the selected key, and the
  notes. Edit that variation in place and re-plant the same plan. Nothing is
  exported.
- Reject prints the feedback and tells the agent to rework and re-plant the same
  slug.

Do not wait on a Downloads folder or fabricate a Verdict; the CLI only waits on the daemon relay.

## Cleanup

After an approve with no notes and only from the target project root, run:

```bash
( cd "$TARGET_ROOT" && ~/.dg/bin/dg-skills proto --ext cleanup "$SLUG" )
```

Cleanup requires `.agents/prototype/<slug>/NOTES.md`. It removes only the
stable agent scratch for that slug, is safe to repeat, and never removes the
exported answer. It never touches your Downloads folder — `--ext` never wrote
one.
