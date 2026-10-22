# Running Custom Playwright Code

Use `pw-code` to execute arbitrary Playwright code for advanced scenarios not covered by CLI commands.

## Approval

`pw-code` is its own command, not a `pw` subcommand. `~/.dg/bin/dg-skills pw run-code` prints `run-code moved to pw-code (it needs your approval each time).` and exits 2.

Code passed to `pw-code` runs in the daemon with full access to the page, the browser context, and the file system. `pw` and `pw-code` are two separate top-level `dg-skills` commands, never `pw code`, so an allow rule scoped to `Bash(~/.dg/bin/dg-skills pw:*)` does not match `pw-code`. The skill does not list `pw-code` in `allowed-tools`, so Claude Code asks you before every run. This keeps one approved `pw` rule from also approving arbitrary code. The daemon accepts code only from the `pw-code` client; a `pw` command cannot reach it.

Do not add `pw-code` to an allow rule.

## Syntax

```bash
~/.dg/bin/dg-skills pw-code [-s=<name>] [--raw] "async page => {
  // Your Playwright code here
  // Access page.context() for browser context operations
}"
```

## Geolocation

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 37.7749, longitude: -122.4194 });
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 51.5074, longitude: -0.1278 });
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.context().clearPermissions();
}"
```

## Permissions

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  await page.context().grantPermissions([
    'geolocation',
    'notifications',
    'camera',
    'microphone'
  ]);
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.context().grantPermissions(['clipboard-read'], {
    origin: 'https://example.com'
  });
}"
```

## Media Emulation

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  await page.emulateMedia({ colorScheme: 'dark' });
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.emulateMedia({ colorScheme: 'light' });
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.emulateMedia({ media: 'print' });
}"
```

## Wait Strategies

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  await page.waitForLoadState('networkidle');
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.locator('.loading').waitFor({ state: 'hidden' });
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.waitForFunction(() => window.appReady === true);
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.locator('.result').waitFor({ timeout: 10000 });
}"
```

## Frames and Iframes

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  const frame = page.locator('iframe#my-iframe').contentFrame();
  await frame.locator('button').click();
}"

~/.dg/bin/dg-skills pw-code "async page => {
  const frames = page.frames();
  return frames.map(f => f.url());
}"
```

## File Downloads

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).click();
  const download = await downloadPromise;
  await download.saveAs('./downloaded-file.pdf');
  return download.suggestedFilename();
}"
```

## Clipboard

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  await page.context().grantPermissions(['clipboard-read']);
  return await page.evaluate(() => navigator.clipboard.readText());
}"

~/.dg/bin/dg-skills pw-code "async page => {
  await page.evaluate(text => navigator.clipboard.writeText(text), 'Hello clipboard!');
}"
```

## Page Information

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  return await page.title();
}"

~/.dg/bin/dg-skills pw-code "async page => {
  return page.url();
}"

~/.dg/bin/dg-skills pw-code "async page => {
  return await page.content();
}"

~/.dg/bin/dg-skills pw-code "async page => {
  return page.viewportSize();
}"
```

## JavaScript Execution

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  return await page.evaluate(() => {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      cookiesEnabled: navigator.cookieEnabled
    };
  });
}"

~/.dg/bin/dg-skills pw-code "async page => {
  const multiplier = 5;
  return await page.evaluate(m => document.querySelectorAll('li').length * m, multiplier);
}"
```

## Error Handling

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  try {
    await page.getByRole('button', { name: 'Submit' }).click({ timeout: 1000 });
    return 'clicked';
  } catch (e) {
    return 'element not found';
  }
}"
```

## Complex Workflows

```bash
~/.dg/bin/dg-skills pw-code "async page => {
  await page.goto('https://example.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
  await page.getByRole('textbox', { name: 'Password' }).fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
  await page.context().storageState({ path: 'auth.json' });
  return 'Login successful';
}"

~/.dg/bin/dg-skills pw-code "async page => {
  const results = [];
  for (let i = 1; i <= 3; i++) {
    await page.goto(\`https://example.com/page/\${i}\`);
    const items = await page.locator('.item').allTextContents();
    results.push(...items);
  }
  return results;
}"
```
