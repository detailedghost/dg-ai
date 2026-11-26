# Versions

A round can hold more than one version, like `/dg:proto` variants.
Run `add` once per version with the same round id:

```bash
dg verify add settings-nav nav-r2 --title="Nav" --follows=nav-r1 --round=2 --variant=A --variant-label="Tabs" --shots=./shots/a
dg verify add settings-nav nav-r2 --title="Nav" --follows=nav-r1 --round=2 --variant=B --variant-label="Rail" --shots=./shots/b --pending=nav-r2
```

A version key is 1 to 16 letters or digits.
Dante flips versions with the switcher, the arrow keys, or the keys 1 to 9. The captions read "Now" and "Version B".
Approve records the shown version. `status` and `watch` print `picked B`.
A version `add` clears a pending entry only when you pass `--pending=KEY`.

