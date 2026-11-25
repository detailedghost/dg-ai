<!-- Performance learnings. Max 100 lines. Prune oldest when full. -->
<!-- Format: - [YYYY-MM-DD] one learning per line, concise and actionable -->
<!-- Any agent may add entries. Prune the oldest lines when the file passes 100 lines. -->
- [2026-11-23] Measure peak RSS with `bun scripts/ram-budget.ts --dg <compiled dg>`; Bun.spawn uses vfork, so a child's ru_maxrss starts at the parent's peak. The harness spawns through a small Python helper.
- [2026-11-23] A freshly written binary maps large folios and reads about 16 MB higher; drop its page cache (`dd iflag=nocache count=0`) before measuring.
- [2026-11-23] Most of a dg process's RSS is JSC code pages. The JIT tiers alone cost 7 to 30 MB; long-running commands re-exec with BUN_JSC_useJIT=0 (ADR 0056).
- [2026-11-23] A dynamic `import("@dg/common")` keeps the whole barrel, zod included; import the leaf subpath instead.
- [2026-11-23] Importing node:crypto costs about 5 MB; use the global `crypto.randomUUID()` or `Bun.CryptoHasher` on startup paths.
- [2026-11-23] Import nostr-tools by subpath; the index pulls nip04 and the noble AES tables.
- [2026-11-23] `require()` of a package keeps it in the importer's chunk; use `await import()` for heavy drivers.
- [2026-11-23] `Bun.YAML.parse` is native; the `yaml` package plus the JIT cost adr lint about 12 MB.
- [2026-11-25] C# front door: measure allocations with GC.GetAllocatedBytesForCurrentThread over N calls after a warmup; pin the result as a ceiling in a test through tests/Shared/AllocationProbe.cs.
- [2026-11-25] C# hot paths: PathFlavor, config key checks, and PrBodyScanner work on spans with stackalloc (ArrayPool above 512 chars); JsonProperty.NameEquals(u8) avoids a string per JSON property; cache SpellingTable per locale.
- [2026-11-25] ProcessEnvironment.Capture cannot go below the runtime's Hashtable snapshot (about 30 KB); keep callers from capturing twice.
