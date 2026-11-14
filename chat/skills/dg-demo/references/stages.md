# Stages

The stage is what the tour plays over. It's 1440 × 810 logical pixels, the same frame
as a `/dg:demo` recording, and the player scales it to fit the window.

## Mock stage (default)

Rebuild each screen the tour visits as plain HTML and CSS inside `#dg-stage`:

```html
<section data-dg-url="http://localhost:4200/dashboard">
  <header class="app-bar">…</header>
  <button id="save-filter-btn" type="button">Save filter</button>
</section>
<section data-dg-url="http://localhost:4200/filters">…</section>
```

- One `<section data-dg-url="…">` per page. The first one is `startUrl`. A step's
  `→ <url>` switches to the section with the same `data-dg-url`.
- **Build from the real thing.** Read the components, styles and copy the user shares,
  and match the layout, labels, colors and density. A tour over a generic look-alike
  demos the wrong product.
- **Use the real selectors.** Give each target the `id`, `data-testid` or `aria-label`
  the real app uses, so the plan's selectors match both.
- **Make the actions land.** The tour really clicks and types. A button the tour clicks
  should do what the real one does, in a few lines of inline script: open the dialog,
  add the row, switch the tab. An input the tour types into must be a real `<input>` or
  `<textarea>`.
- **Self-contained.** Inline all CSS and script. No external fonts, images, scripts or
  stylesheets. Draw icons with inline SVG or text, and use realistic placeholder data.
- Scope mock styles under `#dg-stage` so they can't restyle the player.

## Screenshot stage

Use it when the user would rather show their real screens than a rebuilt mock.

```html
<figure data-dg-screen="dashboard"><img alt="Dashboard" src="data:image/jpeg;base64,…"></figure>
<figure data-dg-screen="filters"><img alt="Filters page" src="data:image/jpeg;base64,…"></figure>
```

- One `<figure data-dg-screen="<id>">` per screenshot, in the order the tour uses them.
- Embed each image as a `data:` URI. If you can run code, resize it to at most
  1440 pixels wide and save it as JPEG, quality about 80, before encoding, so the
  artifact stays small. If you can't embed an image, tell the user and offer the mock
  stage instead.
- In the JSON, each step names its `screen` and a `box` around the target, as percentages
  of the screenshot: `{ "x": 62.5, "y": 8, "w": 10, "h": 5 }`. Find the box by looking
  at the screenshot. Leave `box` out for a centered caption.
- Nothing reacts on a screenshot. `@click` and `@type` steps highlight their box and
  move on. Say in the caption what the user would do.
- In the plan Markdown, a screenshot step has no selector. Tell the user to add the real
  selectors before recording it with `/dg:demo`.
