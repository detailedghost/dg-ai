---
name: phone-friend
description: Renamed to phone. This hidden alias still works for two minor releases, with a one-line notice on stderr naming the removal release.
---

# phone-friend has been renamed

`phone-friend` is now `phone`. `dial`, `on`, `off`, and `card` still work,
hidden, as synonyms for `accept`, `open`, `close`, and `number`, for two
minor releases, printing one notice to stderr the first time each call runs.
`answer`, `deliver`, `whoami`, `name`, and `--line` are gone outright and
fail with their replacement named. Use [/dg:phone](../phone/SKILL.md) from
here on; this page is a pointer, not a second copy of the skill.
