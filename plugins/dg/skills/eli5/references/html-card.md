# `-v` / `-p` — the eli5 card

Same five parts as the inline answer, on one page. The card is a nicer copy of the answer, not
a longer one — if the page says more than the chat did, you wrote too much.

## Where it goes

| Flag | Destination |
|------|-------------|
| `-v`, `--viz` | `$(~/.dg/bin/dg-skills stash eli5 <slug>.html)`, then open it locally |
| `-p`, `--publish` | The `Artifact` tool, same file as the source |

`<slug>` is the topic in kebab-case. Open on WSL with:

```bash
/mnt/c/Windows/explorer.exe "$(wslpath -w $(~/.dg/bin/dg-skills stash eli5 <slug>.html))"
```

Always print the path (or the artifact link) as the last line of the chat answer.

## Page rules

- **Self-contained.** No CDN, no external font, no fetch. Inline the CSS.
- **Big and calm.** Body text 18px or more, `max-width: 46rem`, centered, `line-height: 1.7`.
  One column. Generous space between the five parts.
- **Light and dark aware** — a `prefers-color-scheme: dark` block, per the project convention.
  Define the light palette on `:root`, then redefine the same tokens in the dark block.
- **The picture** goes in a `<pre>` holding the same ASCII drawing from the chat answer, in a
  monospace stack, with `overflow-x: auto` so a wide drawing scrolls instead of breaking the
  page. Reach for inline SVG only when color genuinely carries meaning.
- **One emoji per box, at most.** Emoji is a label, never decoration.
- **No JavaScript** unless the drawing cannot work without it.
- **Prints well:** no fixed heights, no dark background on the print sheet.

## Do not

- Do not build a slide deck, a tab strip, or an accordion. One page, one scroll.
- Do not restate the glossary table as prose as well.
- Do not publish with `-p` unless the user passed it — local file is the default.
