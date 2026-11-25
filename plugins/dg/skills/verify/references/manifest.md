# Build the manifest

Write a JSON file. Every URL must be loopback (`127.0.0.1`, `localhost`, or `::1`).
Do not point at production.
Do not put real sessions, passwords, or access tokens in headers or cookies.
Use seed roles only.
A role may name a saved sign-in instead: set `"state": "<name>"`, where `<name>` is a state saved with `dg pw state save <name>`.
Verify loads the state and signs in as that user. Only loopback pages are captured.
A state role needs the `playwright` engine. The `http` engine refuses it.
The manifest holds the state name only. The cookies stay in the saved state and never reach the board, the session files, or the logs.
If a page lands on another path, such as a sign-in page, capture stops and tells you to save a sign-in and add `state` to the role.

```json
{
  "name": "settings-nav",
  "stackUrl": "http://127.0.0.1:3000/",
  "tests": { "summary": "12 passed", "passed": 12, "failed": 0 },
  "items": [
    {
      "id": "settings",
      "title": "Settings",
      "what": "Moves the settings links into a side menu.",
      "owner": "dg:implementer",
      "beforeRef": "master",
      "afterRef": "feat/settings-nav",
      "beforeUrl": "http://127.0.0.1:4001/settings",
      "afterUrl": "http://127.0.0.1:4002/settings",
      "targetUrl": "http://127.0.0.1:4321/",
      "record": ".agents/spec/007_notes/prototype/slice_2_accepted.json",
      "rootSelector": "[data-verify-root=\"settings-nav\"]",
      "roles": [
        { "id": "admin", "headers": { "x-seed-role": "admin" } },
        { "id": "member", "headers": { "x-seed-role": "member" } }
      ]
    }
  ]
}
```

`what` is optional. It is one or two sentences on what changed, shown under the title.
`owner` is the agent who owns the after side. Name them the way the work was assigned. See [references/owners.md](owners.md).

`beforeRef` and `afterRef` are labels (a branch or a worktree).
This command does not check out branches or boot apps.
Start the before stack and the after stack yourself, then put their URLs in the manifest.
`stackUrl` is the after stack. Each captured round shows an "Open in app" link to it.
`targetUrl` is optional.
Set it only when a prototype page is already running.
The column says there is no prototype target when the field is absent.

`record` is the committed `slice_N_accepted.json` that `spec prototype-ref` copied into the bundle. See [layout-check.md](layout-check.md). `rootSelector` is optional and defaults to `[data-verify-root]`.

`tests` is the suite result for the change. A `cmd` array is an argv that runs without a shell. Only put a command in it that you would run yourself. A `summary` is enough when the suite already ran.

Capture details, viewports, and the accessibility check: [references/capture.md](capture.md).

