# Storage Management

Manage cookies, localStorage, sessionStorage, and browser storage state.

## Storage State

`dg-skills pw state save|load|list|delete|import <name>` is the main path. See `session-management.md`. The file forms `state-save [file]` and `state-load <file>` are in `commands.md`; `state-save` writes mode 0600 and defaults to `storage-state-<ts>.json` in the output directory.

## Raw state files

`dg-skills pw state-save <file>` writes the full cookie jar and localStorage to a plain file in mode 0600. It stays on disk until you delete it, and a path outside the output directory has no 0700 parent. Use `dg-skills pw state save <name>` instead: it keeps the file under `~/.local/state/ai/pw/states/` in a 0700 directory and gives you `dg-skills pw state delete <name>`. If you must use `state-save <file>`, delete the file when done.

## Storage State File Format

The saved file contains:

```json
{
  "cookies": [
    {
      "name": "session_id",
      "value": "abc123",
      "domain": "example.com",
      "path": "/",
      "expires": 1735689600,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": [
    {
      "origin": "https://example.com",
      "localStorage": [
        { "name": "theme", "value": "dark" },
        { "name": "user_id", "value": "12345" }
      ]
    }
  ]
}
```

## Cookies and web storage

The `cookie-*`, `localstorage-*`, and `sessionstorage-*` commands are in `commands.md`. For several values at once, use `dg-skills pw-code` (it asks for your approval each time):

```bash
dg-skills pw-code "async page => {
  await page.context().addCookies([
    { name: 'session_id', value: 'sess_abc123', domain: 'example.com', path: '/', httpOnly: true },
    { name: 'preferences', value: JSON.stringify({ theme: 'dark' }), domain: 'example.com', path: '/' }
  ]);
}"
```

```bash
dg-skills pw-code "async page => {
  await page.evaluate(() => {
    localStorage.setItem('token', 'jwt_abc123');
    localStorage.setItem('user_id', '12345');
  });
}"
```

## IndexedDB

### List Databases

```bash
dg-skills pw-code "async page => {
  return await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return databases;
  });
}"
```

### Delete Database

```bash
dg-skills pw-code "async page => {
  await page.evaluate(() => {
    indexedDB.deleteDatabase('myDatabase');
  });
}"
```

## Common Patterns

### Authentication State Reuse

```bash
dg-skills pw open https://app.example.com/login
dg-skills pw fill e1 "user@example.com"
dg-skills pw fill e2 "password123"
dg-skills pw click e3
dg-skills pw state save app
```

Later, skip the login:

```bash
dg-skills pw open --from=app https://app.example.com/dashboard
```

## Security Notes

- State files hold live credentials. Never commit them or print their contents.
- Saved states stay under `~/.local/state/ai/pw/states/` with mode 0600.
- Delete states you no longer need: `dg-skills pw state delete <name>`.
- Use environment variables for sensitive data.
