# Board layout

Three review tabs across the top re-group the same diff, with an optional Demo tab when assets are attached:

| Tab | Shows |
|---|---|
| **Files** | the compact nested directory tree (default). The navigation and diff panes use the same shared folder-first, case-insensitive ordering. |
| **Commit** | one section per commit, in history order |
| **Spec** | one collapsible row per slice in the spec's own order — heading, one-line description, file count and ±lines. Collapsed by default; opening a row reveals that slice's file cards **and closes whichever row was open**, so you review one slice at a time. Slices no changed file touched still appear, dimmed, so the list reads as the checklist it is. Needs `--spec`. |
| **▶ Demo** | the `--demo` assets (below). Only present when `--demo` was passed. |

Diff and full-code views infer a language from each file path and highlight registered source formats. Highlighting is optional UI enhancement: an unknown extension, grammar error, or failed client dependency load falls back to safely escaped plain text without interrupting navigation, comments, or verdict submission.

Slice rows come from `payload.review.slices` (`{id, name, label, description?, files[]}`, emitted in spec order); a row lists every changed file its `files[]` **declares**. Descriptions are lifted from the spec body — the slice's own `### Slice N` section first, its `## Slice Summaries` entry as fallback. Anything no slice claims collects in a trailing "Docs & other" row. Open/collapsed rows survive a re-render, so adding a comment or marking a file viewed never collapses the reviewer's place.

**The left file tree follows the slice accordion.** With a slice expanded, the tree narrows to exactly the files that slice shows, so tree and diff pane never disagree; collapse it and the tree widens back to the whole range rather than going empty. Clicking a tree entry for a file that several slices declare jumps to its card in an already-open slice instead of one buried in a collapsed row.

**Sticky prev/next bars walk the slices in spec order.** While a slice is open, a bar pinned to the top of the pane jumps to the slice before it and one pinned to the bottom jumps to the slice after — each naming that slice and its file count. The bar is omitted at either end of the list, so the first slice has no "previous" and the trailing "Docs & other" row has no "next". Clicking either closes the current slice, opens the target, scrolls it to the top, and re-narrows the tree in one step.

> Slice rows are driven by state, not by the DOM's `open` attribute, and `setOpenSlice()` rebuilds the pane because the sticky bars depend on *which* slice is open. The rebuilt `<details open>` fires its own `toggle` on insertion, so the toggle handler must no-op when the DOM already agrees with state — without that guard it re-enters `setOpenSlice` forever and the pane re-renders in a loop (it still *looks* right, which is what makes it easy to miss).

> `slices[].files` in spec frontmatter is read in both YAML shapes — flow (`files: ["a","b"]`, what `dg-skills spec` emits) and block (`files:` + indented `- path`). A file several slices declare appears under **each** of them — attributing it to one would render the slice that created a file as empty once a later slice revised it. Its card is badged with the slice whose row it sits under; the `Commit`/`Files` tabs badge it with `ReviewFile.slice`, which is single-valued (last declaring slice wins).

## Demo attachment (`--demo`)

A review board can lead with the feature actually working — pass `--demo <assets-dir>` (plus optional `--demo-caption "<text>"`) pointing at a directory of `/demo` output, conventionally `$(~/.dg/bin/dg-skills stash -G demo)/`. It renders as its own **Demo** tab, not a section above the diff:

```sh
~/.dg/bin/dg-skills viz review --repo "$REPO" --base "$BASE" --head "$HEAD" \
  --demo $(~/.dg/bin/dg-skills stash -G demo) --demo-caption "Adding a child from the tree, then removing it"
```

- Picks the first `*.mp4`/`*.webm` as the video, `poster.*` as its poster frame, and every other image as a screenshot — labels are humanized from filenames (`01-add-child-row.png` → "add child row"), so name the files for the moment they capture.
- Assets are copied into the Astro `public/demo-assets/<slug>/` dir because session dirs sit outside the Astro project and a browser won't load `file://` subresources into an `http://` page. Idempotent per slug, so the request-changes re-render loop replaces rather than accumulates.
- The video renders `controls` only — never autoplay, so opening a board can't ambush the reviewer with sound.
- **A newly-named asset 404s until the viz server restarts.** The Astro dev server resolves `public/` against a listing built at boot, so a file whose *name* it has not seen before is missing even though `stageDemoAssets` copied it and `ls` shows it there. Re-rendering does not help; `~/.dg/bin/dg-skills viz stop` then re-render does. Verify with `curl -o /dev/null -w '%{http_code}'` per asset rather than trusting the payload's screenshot count — the count comes from the staging dir, not from anything the browser could load.
- Omit the flag and nothing changes; the tab only exists when `payload.demo` does.
- Screenshots alone are fine, but a short screen recording carries far more than a slideshow of stills — record one if the flow is worth watching.

Run `/demo` first to produce the assets (it writes to `$(~/.dg/bin/dg-skills stash -G demo)/` and must never write into the git tree), then pass that directory here.
