# Video Recording

Capture browser automation sessions as video for debugging, documentation, or verification. Produces WebM (VP8/VP9 codec). Needs ffmpeg; if missing, `pw` prints the `bunx playwright-core install ffmpeg` hint. Relative filenames resolve against the output directory (`$(stash pw)/`).

## Light/dark before/after screenshot pairs

`pw screenshot [target] [--filename=<name>] [--full-page] [--color-scheme=light|dark]` emulates `prefers-color-scheme` before capturing, then restores the page's own preference, so a before/after pair never leaks one theme into the other:

```bash
~/.dg/bin/dg-skills pw screenshot --color-scheme=light --filename=before-light.png
~/.dg/bin/dg-skills pw screenshot --color-scheme=dark --filename=before-dark.png
# ... drive the change under test ...
~/.dg/bin/dg-skills pw screenshot --color-scheme=light --filename=after-light.png
~/.dg/bin/dg-skills pw screenshot --color-scheme=dark --filename=after-dark.png
```

This is the primitive a local demo recording composes into a before/after pair; it does not itself know about TourScript plans or the shared overlay module (`pkg/common/src/tour-overlay.ts`), which a later port wires in.

## Basic Recording

```bash
~/.dg/bin/dg-skills pw open

~/.dg/bin/dg-skills pw video-start demo.webm

~/.dg/bin/dg-skills pw video-chapter "Getting Started" --description="Opening the homepage" --duration=2000

~/.dg/bin/dg-skills pw goto https://example.com
~/.dg/bin/dg-skills pw snapshot
~/.dg/bin/dg-skills pw click e1

~/.dg/bin/dg-skills pw video-chapter "Filling Form" --description="Entering test data" --duration=2000
~/.dg/bin/dg-skills pw fill e2 "test input"

~/.dg/bin/dg-skills pw video-stop
```

## Best Practices

### 1. Use Descriptive Filenames

```bash
~/.dg/bin/dg-skills pw video-start recordings/login-flow-2024-01-15.webm
~/.dg/bin/dg-skills pw video-start recordings/checkout-test-run-42.webm
```

### 2. Record entire hero scripts.

When recording a video for the user or as a proof of work, it is best to create a code snippet and execute it with `pw-code` (it asks for your approval each time).
It allows pulling appropriate pauses between the actions and annotating the video. There are new Playwright APIs for that.

1) Perform scenario using CLI and take note of all locators and actions. You'll need those locators to request their bounding boxes for highlight.
2) Create a file with the intended script for video (below). Use pressSequentially w/ delay for nice typing, make reasonable pauses.
3) Use pw-code --filename your-script.js

**Important**: Overlays are `pointer-events: none` — they do not interfere with page interactions. You can safely keep sticky overlays visible while clicking, filling, or performing any actions on the page.

```js
async page => {
  await page.screencast.start({ path: 'video.webm', size: { width: 1280, height: 800 } });
  await page.goto('https://demo.playwright.dev/todomvc');

  // Show a chapter card — blurs the page and shows a dialog.
  // Blocks until duration expires, then auto-removes.
  // Use this for simple use cases, but always feel free to hand-craft your own beautiful
  // overlay via await page.screencast.showOverlay().
  await page.screencast.showChapter('Adding Todo Items', {
    description: 'We will add several items to the todo list.',
    duration: 2000,
  });

  // Perform action
  await page.getByRole('textbox', { name: 'What needs to be done?' }).pressSequentially('Walk the dog', { delay: 60 });
  await page.getByRole('textbox', { name: 'What needs to be done?' }).press('Enter');
  await page.waitForTimeout(1000);

  // Show next chapter
  await page.screencast.showChapter('Verifying Results', {
    description: 'Checking the item appeared in the list.',
    duration: 2000,
  });

  // Add a sticky annotation that stays while you perform actions.
  // Overlays are pointer-events: none, so they won't block clicks.
  const annotation = await page.screencast.showOverlay(`
    <div style="position: absolute; top: 8px; right: 8px;
      padding: 6px 12px; background: rgba(0,0,0,0.7);
      border-radius: 8px; font-size: 13px; color: white;">
      ✓ Item added successfully
    </div>
  `);

  // Perform more actions while the annotation is visible
  await page.getByRole('textbox', { name: 'What needs to be done?' }).pressSequentially('Buy groceries', { delay: 60 });
  await page.getByRole('textbox', { name: 'What needs to be done?' }).press('Enter');
  await page.waitForTimeout(1500);

  // Remove the annotation when done
  await annotation.dispose();

  // You can also highlight relevant locators and provide contextual annotations.
  const bounds = await page.getByText('Walk the dog').boundingBox();
  await page.screencast.showOverlay(`
    <div style="position: absolute;
      top: ${bounds.y}px;
      left: ${bounds.x}px;
      width: ${bounds.width}px;
      height: ${bounds.height}px;
      border: 1px solid red;">
    </div>
    <div style="position: absolute;
      top: ${bounds.y + bounds.height + 5}px;
      left: ${bounds.x + bounds.width / 2}px;
      transform: translateX(-50%);
      padding: 6px;
      background: #808080;
      border-radius: 10px;
      font-size: 14px;
      color: white;">Check it out, it is right above this text
    </div>
  `, { duration: 2000 });

  await page.screencast.stop();
}
```

Embrace creativity, overlays are powerful.

### Overlay API Summary

| Method | Use Case |
|--------|----------|
| `page.screencast.showChapter(title, { description?, duration?, styleSheet? })` | Full-screen chapter card with blurred backdrop — ideal for section transitions |
| `page.screencast.showOverlay(html, { duration? })` | Custom HTML overlay — use for callouts, labels, highlights |
| `disposable.dispose()` | Remove a sticky overlay added without duration |
| `page.screencast.hideOverlays()` / `page.screencast.showOverlays()` | Temporarily hide/show all overlays |

## Tracing vs Video

| Feature | Video | Tracing |
|---------|-------|---------|
| Output | WebM file | Trace file (viewable in Trace Viewer) |
| Shows | Visual recording | DOM snapshots, network, console, actions |
| Use case | Demos, documentation | Debugging, analysis |
| Size | Larger | Smaller |

## Limitations

- Recording adds slight overhead to automation
- Large recordings can consume significant disk space
