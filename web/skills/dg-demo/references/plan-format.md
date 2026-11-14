# Plan format

The web tour reads the same Markdown plan as DeeGee's `/dg:demo`. Keep to this
grammar so a plan written here can be recorded as a real video later.

## Frontmatter

```yaml
---
title: Saved filters                            # shown in captions and the intro card
startUrl: http://localhost:4200/dashboard       # the first screen; http(s) only
stage: mock                                     # web only: mock or screenshots
intro: "Demo | Saved filters | Keep your views" # Eyebrow | Title | Detail
outro: "Done | That is it | Thanks for watching"
---
```

- `intro` defaults to the eyebrow `Demo` and the plan `title`.
- No outro plays unless you set one.
- `/dg:demo` ignores `stage`. The web player ignores `mode` and `includeSetup`.

## Steps

```text
N. **<title>** [`<css-selector>`] [→ <navigate-url>] [<action>] — <body> [`<timing>`]
```

Only the number and the body are required.

| Part | Meaning |
| --- | --- |
| `` `<css-selector>` `` | The element to highlight. Leave it out for a centered caption over a dimmed page. |
| `→ <url>` | Switch to that screen before the step shows. It must match a mock section's `data-dg-url`. |
| `@click` | The tour clicks the target. |
| `@type="<text>"` | The tour types `<text>` into the target, one key at a time. Escape `"` and `\` as `\"` and `\\`. |
| `` `<timing>` `` | `4s`, `500ms` or a bare count of milliseconds auto-advances. `next` waits for the › control. `click` waits for a person to click the target. With no timing, a step holds about 3.5 seconds. |

The `click` timing and the `@click` action are different things. The timing waits for a
person, and the action is done by the tour. For a step that runs on its own, pair
`@click` with a number: `` `#save` @click — Save it. `2s` ``.

`@click` and `@type` are the only actions. Hover, drag, select and key presses don't
exist. Write a step like that with the `next` timing and no action, and say in the body
what the user would do.

## Picking selectors

- Prefer stable hooks: `data-testid`, `id`, `aria-label`, or a role. Avoid positional
  chains like `div > div:nth-child(3)`.
- Use the selectors the real app uses, and give the mock elements the same ones. Then the
  plan works here and in a real recording.
- Each selector must match exactly one element on the screen the step shows.

## Writing captions

- One idea per step, one or two sentences of body text.
- Lead with the verb: "Click…", "Notice…", "Now the results…".
- The title is the label and the body explains it. Don't repeat one in the other.

## Not in the web version

`## Setup`, `includeSetup`, credential variables, and narration. A plan that uses
them still plays here: the player skips `## Setup` and shows a `@type` value as typed
text. Never put a real password, token or code in a plan.
