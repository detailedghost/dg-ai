# Mailbox Cleanup Core

Mailbox Cleanup Core is DeeGee's provider-neutral, non-destructive mailbox
workflow. It captures a bounded mailbox inventory, scrubs it, creates immutable
plan revisions, executes only an accepted typed revision, verifies each action,
and produces a sanitized debrief.

Real provider adapters and optional local inference are separate follow-on
bundles. The core is complete and conformant with the bundled fake provider
alone.

## Safety boundary

- `@dg/common` owns the exact outbound mailbox schemas and canonical
  serialization.
- Raw subjects, snippets, names, addresses, provider identifiers, filter text,
  financial data, selectors, URLs, and other user-authored text are withheld or
  category-replaced before model, chat, IndexedDB, download, or log handoff.
- Raw alias-to-page bindings exist only in browser session storage. Sanitized
  plans and immutable revisions use a dedicated versioned IndexedDB store.
- Provider work requires a normalized English locale and a provider-owned
  positive layout signature.
- Local inference and chat proposals are advisory Draft inputs. Neither can
  accept a revision or authorize mutation.

The frozen action union contains only non-destructive operations: archive,
mark read, move to folder, create or rename folders, create or rename labels or
categories, apply labels or categories, and create, change, or deactivate
filters. Delete, trash, scripts, provider commands, arbitrary URLs, and raw
locators are not plan authority.

## Retention and limits

| Data or operation | Limit |
| --- | --- |
| Raw binding inactivity | 1 hour |
| Draft revision retention | 30 days |
| Approved, In flight, Completed, and Canceled retention | 7 days |
| Inbox messages captured | 5,000 |
| Folders captured | 500 |
| Labels captured | 1,000 |
| Tags captured | 1,000 |
| Categories captured | 256 |
| Filters captured | 500 |
| Capture chunk | 250 items |
| Capture chunks | 256 |
| Buffered capture chunks | 1 |
| Assembled inventory | 9,000 items |
| Sanitized capture text | 1,000,000 characters |
| Chat payload | 1,000,000 characters |
| Consented body checks | 20 messages |
| Scrubbed body text | 2,000 Unicode characters per body |
| Execution journal unit | 100 actions |

Raw-binding activity is renewed only by a defined user decision or active
execution checkpoint. Listing, polling, page opens, alarms, progress updates,
and worker wakes are passive and do not renew it. Logical expiry applies at
`now >= expiresAt`, even when browser suspension delays physical cleanup.
Account changes, restart-required state, completion, and cancellation also
invalidate raw bindings. Passive access never extends plan retention.

Body checks require one consent decision per capture run and explicit message
aliases. The provider removes attachments and quoted history before the
scrubber bounds each body.

Stale is orthogonal to Draft, Approved, In flight, and Completed. A stale Draft
keeps Draft retention but cannot execute. Completed remains listable only until
its exact expiry.

## Restart and execution

Execution and restart contend on one durable compare-and-set registry.
Execution receives a random, expiring, owner-checked admission. While that
admission is live, Restart returns blocked without writing a restart fence.
After admission release or expiry, Restart may claim the revision; that claim
blocks both the source and candidate revisions before raw bindings can be used.

Restart always invalidates the old revision bindings, creates a fresh run and
revision scope, rescans provider state, rechecks account and layout, and binds
fresh aliases. Approval is preserved only when the canonical remaining-scope
authority is identical and fresh preflight passes. Any canonical change creates
a Draft requiring acceptance.

Interrupted In flight work keeps durable verified, Review, and skipped history.
Verified work is never dispatched again. Review blocks every later pending
action. Fresh provider state is compared with the latest durable remaining
authority, rather than the original pre-execution fingerprint. Old locators
cannot execute after a successful restart claim.

## Chat and debrief

Submit to Chat sends one re-scrubbed sanitized inventory through the nonce-bound
one-shot synchronous bridge. Submit does not grant execution consent. A
validated chat proposal is stored as a Draft, and later user edits fork another
Draft. The bridge sends no mailbox content before Submit and waits until Submit,
Cancel, or a clear error. A disconnected chat leaves the sanitized Draft
recoverable.

The CLI bridges use unique request IDs, synchronously consumed request/result
phases, replay rejection, authenticated liveness polling, bounded deadlines,
and cancellation that reaches the core operation.

A terminal run durably regenerates and downloads one canonical plain-language
debrief. It reports completed, skipped, Review, failed, folder, label or
category, and Added, Changed, or Deactivated filter outcomes. Download
availability is recorded only after the matching browser download completes.
Only a fresh provider observation of zero Inbox messages may claim Inbox Zero.
The downloaded file lives outside extension retention and TTL cleanup.

## Provider handoff

Provider and optional inference work may start only after the shared core
checkpoint is committed, frozen, and its conformance gate passes:

```bash
cd pkg/extension
bun run conformance:mailbox-core
```

The gate runs the mailbox contract and fake-provider tests, protected-boundary
checks, TypeScript, the Chrome build, and the Firefox build. It emits one
machine-readable contract version/hash record only after every phase passes.
The declared protected inventory and expected digest live in
[`mailbox-provider-v1.json`](../../pkg/extension/mailbox-provider-v1.json).

Each later provider bundle must add a JSON pin outside the adapter root:

```json
{
  "commit": "<40-character lowercase checkpoint commit>",
  "contract": "mailbox-provider-v1",
  "hash": "<64-character lowercase hash from the gate record>",
  "version": 1
}
```

Run the unchanged gate against that pin:

```bash
cd pkg/extension
bun scripts/mailbox-core-gate.ts --pin path/to/mailbox-core-pin.json
```

The pin check requires the checkpoint commit to resolve as an ancestor of
`HEAD`, matches the contract version and hash, and rejects every post-checkpoint
change except direct adapter entrypoints and the pin itself.

Provider bundles must also:

1. Leave the protected core, locale seam, inference seam, fake provider,
   conformance harness, checker, gate, and canonical documentation unchanged.
2. Add each provider as a direct, visible, statically bundled `.ts` entrypoint
   under `providers/adapters/`, named for its literal provider ID. Subdirectories,
   symlinks, hidden files, helper modules, other source forms, and runtime-loaded
   modules fail the boundary check.
3. Avoid provider SDKs, Graph, MSAL, fetch, XHR, WebSocket, and other network
   primitives. Core adapters operate through the provider page contract, not a
   provider API.
4. Run the pinned gate unchanged.

An intentional core change requires a new contract version, manifest hash,
checkpoint commit, and review. A repository-local hash detects drift; branch
protection and code ownership remain the authorization controls for protected
changes.

## Testing seams

The provider-neutral adapter harness injects clock, storage, browser restart,
and download seams. It checks locale and layout gates, capture, typed-action
persistence, restart handoff, preflight, dispatch, fresh observation,
verification, Inbox observation, and sanitized report download. Adapter
conformance must use this harness rather than copy core provider logic.

The gate's mailbox test suite separately runs the bundled fake provider through
capture, deterministic planning, acceptance, execution, expiry, restart, and
durable debrief behavior. The fake provider remains the reference
`mailbox-provider-v1` implementation; local inference is not required.
