# Changelog

## v1.35.0 (2026-11-03)

### Features

- feat(install): prune stale dg plugin cache versions on install ([#132](https://github.com/detailedghost/dg-ai/pull/132))

## v1.34.2 (2026-11-03)

### Fixes

- fix(dg-daemon): require a credential for no-Origin service and job requests ([#131](https://github.com/detailedghost/dg-ai/pull/131))

## v1.34.1 (2026-11-03)

### Fixes

- fix(dg-daemon): refuse no-Origin requests without a token ([#130](https://github.com/detailedghost/dg-ai/pull/130))

## v1.34.0 (2026-11-03)

### Features

- feat(dg-daemon): serve the chat and board pages on loopback ([#129](https://github.com/detailedghost/dg-ai/pull/129))

## v1.33.0 (2026-11-02)

### Features

- feat(stat): order checklist by critical path and offer /dg:walk ([#127](https://github.com/detailedghost/dg-ai/pull/127))

## v1.32.2 (2026-11-02)

### Fixes

- fix(sdlc): stop checkbox and confirmation deferrals from blocking slice waves ([#126](https://github.com/detailedghost/dg-ai/pull/126))

## v1.32.1 (2026-11-02)

### Fixes

- fix(install): update the unpacked extension in place and retire the batch extension ([#125](https://github.com/detailedghost/dg-ai/pull/125))

## v1.32.0 (2026-11-02)

### Features

- feat(hooks): add an opt-in hook that removes AI co-author trailers ([#124](https://github.com/detailedghost/dg-ai/pull/124))

## v1.31.0 (2026-11-02)

### Features

- feat(demo): play demos locally without the extension ([#122](https://github.com/detailedghost/dg-ai/pull/122))

## v1.30.1 (2026-11-02)

### Fixes

- fix(meaningful): add --onto to rebuild a stacked branch on a reshaped parent ([#123](https://github.com/detailedghost/dg-ai/pull/123))

## v1.30.0 (2026-11-02)

### Features

- feat(prototype): pass the page through by default with a Responsive width ([#121](https://github.com/detailedghost/dg-ai/pull/121))

## v1.29.0 (2026-11-02)

### Features

- feat(prototype): add a More versions decision to the viewer bar ([#118](https://github.com/detailedghost/dg-ai/pull/118))

## v1.28.1 (2026-11-02)

### Fixes

- fix(inbox): block Proton mailbox changes on an account mismatch ([#117](https://github.com/detailedghost/dg-ai/pull/117))

## v1.28.0 (2026-11-02)

### Features

- feat(skills-cli): make the dg-ai-extension opt-in with --ext ([#115](https://github.com/detailedghost/dg-ai/pull/115))
- feat(hooks): add opt-in dg hooks for Claude, Codex and opencode ([#114](https://github.com/detailedghost/dg-ai/pull/114))
- feat(pw): port the pw browser skill into dg-skills ([#113](https://github.com/detailedghost/dg-ai/pull/113))

### Fixes

- fix(extension): stop old tab-group markers from re-grouping tabs ([#112](https://github.com/detailedghost/dg-ai/pull/112))

## v1.27.0 (2026-11-01)

### Features

- feat(phone): multi-party threads v1 ([#111](https://github.com/detailedghost/dg-ai/pull/111))
- feat(ssms): add Google Messages and Signal providers ([#107](https://github.com/detailedghost/dg-ai/pull/107))

### Fixes

- fix(phone): supervise the listener with open --ensure, widen catch-up, watch --new ([#109](https://github.com/detailedghost/dg-ai/pull/109))
- fix(phone): relay publish reliability and listener liveness ([#108](https://github.com/detailedghost/dg-ai/pull/108))

## v1.26.0 (2026-10-29)

### Features

- feat(verify): add /dg:verify round-based review board ([#97](https://github.com/detailedghost/dg-ai/pull/97))

## v1.25.2 (2026-10-29)

### Fixes

- fix(phone): reload invites without restarting the listener ([#96](https://github.com/detailedghost/dg-ai/pull/96))

## v1.25.1 (2026-10-29)

### Fixes

- fix(thrash): encode the GitLab target ref in file reads ([#103](https://github.com/detailedghost/dg-ai/pull/103))

## v1.25.0 (2026-10-29)

### Features

- feat(thrash): run the action in GitLab CI ([#102](https://github.com/detailedghost/dg-ai/pull/102))

### Fixes

- fix(phone): refuse an unnamed or colliding accept ([#98](https://github.com/detailedghost/dg-ai/pull/98))

## v1.24.0 (2026-10-28)

### Features

- feat(assign): one model and effort tier table ([#92](https://github.com/detailedghost/dg-ai/pull/92))

### Fixes

- fix(phone): remove the phone-friend alias as announced ([#101](https://github.com/detailedghost/dg-ai/pull/101))

## v1.23.0 (2026-10-28)

### Features

- feat(thrash): clear fixed findings and review only new work ([#94](https://github.com/detailedghost/dg-ai/pull/94))

### Fixes

- fix(install): keep the piped bootstrap script away from the installer ([#99](https://github.com/detailedghost/dg-ai/pull/99))
- fix(phone): move the phone-friend alias removal to 1.23.0 ([#100](https://github.com/detailedghost/dg-ai/pull/100))

## v1.22.0 (2026-10-28)

### Features

- feat(release): release automatically from conventional commits ([#95](https://github.com/detailedghost/dg-ai/pull/95))

### Fixes

- fix(install): replace the dg-skills binary by rename ([#89](https://github.com/detailedghost/dg-ai/pull/89))
