# Test Generation and Playwright Tests

## Generate test code

Add `--codegen` to a command, or `~/.dg/bin/dg-skills pw open --codegen` for the whole session, and each action prints the matching Playwright TypeScript code. Copy it into test files. Without the flag the code section is off to save context.

```bash
~/.dg/bin/dg-skills pw open --codegen https://example.com/login
~/.dg/bin/dg-skills pw snapshot
~/.dg/bin/dg-skills pw fill e1 "user@example.com"
~/.dg/bin/dg-skills pw fill e2 "password123"
~/.dg/bin/dg-skills pw click e3
```

The snapshot shows `e1 [textbox "Email"]`, `e2 [textbox "Password"]`, `e3 [button "Sign In"]`. Each action prints its code, for example:

```
### Ran Playwright code
await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
```

### Build a test file

Collect the generated code into a test:

```typescript
import { test, expect } from '@playwright/test';

test('login flow', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
  await page.getByRole('textbox', { name: 'Password' }).fill('password123');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/.*dashboard/);
});
```

### Best practices

1. Prefer semantic locators. Generated `getByRole(...)` calls resist change better than `page.locator('#submit-btn')`.
2. Snapshot before you record, so you know the page structure.
3. Add assertions by hand. Generated code captures actions, not expectations: `await expect(page.getByText('Success')).toBeVisible();`

## Run Playwright tests

Use `npx playwright test` or a package manager script. Set `PLAYWRIGHT_HTML_OPEN=never` to skip the interactive HTML report. These are not `pw` commands and are outside this skill's allowed tools, so the user approves each run.

```bash
PLAYWRIGHT_HTML_OPEN=never npx playwright test
PLAYWRIGHT_HTML_OPEN=never npm run special-test-command
```

## Debug a failing test

`pw` has no `attach <name>` and no `pause-at`, `resume`, or `step-over`. For `--debug=cli` sessions, use legacy `playwright-cli attach <session>`. It is outside this skill's allowed tools, so the user approves each run. To add these commands to `pw`, see "Extending" in `commands.md`.

`~/.dg/bin/dg-skills pw attach --cdp=<url>` still drives a running Chromium by CDP endpoint.
