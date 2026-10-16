# Deepening

How to deepen a cluster of shallow modules safely, given its dependencies. Assumes the vocabulary in [language.md](language.md) — **module**, **interface**, **seam**, **adapter**.

Verbatim from [mattpocock/skills/improve-codebase-architecture/DEEPENING.md](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/DEEPENING.md), with light wording adaptations.

## Dependency categories

When assessing a candidate for deepening, classify its dependencies. The category determines how the deepened module is tested across its seam.

### 1. In-process

Pure computation, in-memory state, no I/O. Always deepenable — merge the modules and test through the new interface directly. No adapter needed.

### 2. Local-substitutable

Dependencies that have local test stand-ins (PGLite for Postgres, in-memory filesystem, SQLite for production-Postgres). Deepenable if the stand-in exists. The deepened module is tested with the stand-in running in the test suite. The seam is internal; no port at the module's external interface.

### 3. Remote but owned (Ports & Adapters)

Your own services across a network boundary (microservices, internal APIs). Define a **port** (interface) at the seam. The deep module owns the logic; the transport is injected as an **adapter**. Tests use an in-memory adapter. Production uses an HTTP/gRPC/queue adapter.

Recommendation shape: *"Define a port at the seam, implement an HTTP adapter for production and an in-memory adapter for testing, so the logic sits in one deep module even though it's deployed across a network."*

### 4. True external (Mock)

Third-party services (Stripe, Twilio, Snowflake, etc.) you don't control. The deepened module takes the external dependency as an injected port; tests provide a mock adapter. Production wires the real client.

## Seam discipline

- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a port unless at least two adapters are justified (typically production + test). A single-adapter seam is just indirection.
- **Internal seams vs external seams.** A deep module can have internal seams (private to its implementation, used by its own tests) as well as the external seam at its interface. Don't expose internal seams through the interface just because tests use them.

## Testing strategy: replace, don't layer

- Old unit tests on shallow modules become waste once tests at the deepened module's interface exist — delete them.
- Write new tests at the deepened module's interface. The **interface is the test surface**.
- Tests assert on observable outcomes through the interface, not internal state.
- Tests should survive internal refactors — they describe behaviour, not implementation. If a test has to change when the implementation changes, it's testing past the interface.

## Migration path (when proposing deepening to the user)

For a chosen candidate, the design conversation should produce a migration plan with these elements:

1. **Identify** — current shallow modules + which dependencies they touch (categorize per above).
1. **Define the deep interface** — types, invariants, ordering, error modes. Don't anchor to the existing implementations.
1. **Choose adapters** — match dependencies to categories 1–4. Skip ports for category 1; add ports only when ≥2 adapters are justified.
1. **Move tests to the new seam** — write at the deepened interface. Old shallow-module tests get deleted, not preserved.
1. **Cut over** — replace shallow callers with the deep interface. Delete the old modules. Run the deletion test mentally to confirm nothing was load-bearing that the new interface doesn't cover.

This path can be expressed as vertical slices for `/spec` once the design is final.
