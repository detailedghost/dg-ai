# Request Mocking

Intercept, mock, modify, and block network requests.

## CLI Route Commands

```bash
dg-skills pw route "**/*.jpg" --status=404

dg-skills pw route "**/api/users" --body='[{"id":1,"name":"Alice"}]' --content-type=application/json

dg-skills pw route "**/api/data" --body='{"ok":true}' --header="X-Custom: value"

dg-skills pw route "**/*" --remove-header=cookie,authorization

dg-skills pw route-list

dg-skills pw unroute "**/*.jpg"
dg-skills pw unroute
```

## URL Patterns
```
**/api/users           - Exact path match
**/api/*/details       - Wildcard in path
**/*.{png,jpg,jpeg}    - Match file extensions
**/search?q=*          - Match query parameters
```

## Advanced Mocking with pw-code

These recipes use `dg-skills pw-code`, which asks for your approval each time. For conditional responses, request body inspection, response modification, or delays:

### Conditional Response Based on Request

```bash
dg-skills pw-code "async page => {
  await page.route('**/api/login', route => {
    const body = route.request().postDataJSON();
    if (body.username === 'admin') {
      route.fulfill({ body: JSON.stringify({ token: 'mock-token' }) });
    } else {
      route.fulfill({ status: 401, body: JSON.stringify({ error: 'Invalid' }) });
    }
  });
}"
```

### Modify Real Response

```bash
dg-skills pw-code "async page => {
  await page.route('**/api/user', async route => {
    const response = await route.fetch();
    const json = await response.json();
    json.isPremium = true;
    await route.fulfill({ response, json });
  });
}"
```

### Simulate Network Failures

```bash
dg-skills pw-code "async page => {
  await page.route('**/api/offline', route => route.abort('internetdisconnected'));
}"
```

Other abort reasons: `connectionrefused`, `timedout`, `connectionreset`.

### Delayed Response

```bash
dg-skills pw-code "async page => {
  await page.route('**/api/slow', async route => {
    await new Promise(r => setTimeout(r, 3000));
    route.fulfill({ body: JSON.stringify({ data: 'loaded' }) });
  });
}"
```
