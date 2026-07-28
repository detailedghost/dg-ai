import { describe, expect, it } from "bun:test";
import {
	createSessionAliasRegistry,
	scrubFreshMailboxInventoryFromBindings,
	scrubMailboxInventory,
	validateMailboxAliasScope,
} from "../index";

function entropy(seed: number): Uint8Array {
	return Uint8Array.from(
		{ length: 16 },
		(_, index) => (seed * 17 + index * 13) % 256,
	);
}

type Registry = ReturnType<typeof createSessionAliasRegistry>;

function bindHierarchy(
	registry: Registry,
	providerId = "fake-mail",
	accountRaw = `${providerId}-account`,
) {
	const accountScope = { providerId, surface: "inbox" };
	const accountAlias = registry.bind(accountScope, "account", accountRaw);
	const runScope = { ...accountScope, accountAlias };
	const runAlias = registry.bind(runScope, "run", `${accountRaw}-run`);
	const revisionScope = { ...runScope, runAlias };
	const revisionAlias = registry.bind(
		revisionScope,
		"revision",
		`${accountRaw}-revision`,
	);
	return { ...revisionScope, revisionAlias };
}

describe("scrubMailboxInventory", () => {
	it("withholds personal, financial, and user-authored sentinels", () => {
		const secret = "SENTINEL alice@example.test 4111 1111 1111 1111";
		let sequence = 0;
		const aliases = createSessionAliasRegistry({
			randomBytes: () => entropy(++sequence),
		});
		const scope = bindHierarchy(aliases);
		const scrubbed = scrubMailboxInventory(
			{
				accountName: secret,
				messages: [
					{
						id: "provider-message-42",
						subject: secret,
						snippet: secret,
						senderName: secret,
						receivedAt: "2026-07-26T12:00:00.000Z",
						read: false,
						hasAttachments: false,
					},
				],
				folders: [{ id: "provider-folder-1", name: secret }],
				labels: [],
				filters: [{ id: "provider-filter-1", terms: secret }],
			},
			{ ...scope, capturedAt: "2026-07-27T12:00:00.000Z" },
			{ aliases },
		);

		const outbound = JSON.stringify(scrubbed);
		expect(outbound).not.toContain("SENTINEL");
		expect(outbound).not.toContain("alice@example.test");
		expect(outbound).not.toContain("4111");
		expect(outbound).not.toContain("provider-message-42");
		expect(scrubbed.messages[0]?.alias).toMatch(/^msg_/);
	});

	it("reconstructs only accepted aliases from fresh raw state after restart", () => {
		let sequence = 0;
		const aliases = createSessionAliasRegistry({
			randomBytes: () => entropy(++sequence),
		});
		const scope = bindHierarchy(aliases);
		const context = {
			...scope,
			capturedAt: "2026-07-27T12:00:00.000Z",
		};
		const accepted = scrubMailboxInventory(
			{
				messages: [
					{
						id: "provider-message-1",
						receivedAt: "2026-07-26T12:00:00.000Z",
						read: false,
					},
				],
				folders: [{ id: "provider-folder-1", messageCount: 1 }],
			},
			context,
			{ aliases },
		);
		const messageAlias = accepted.messages[0]?.alias;
		const folderAlias = accepted.folders[0]?.alias;
		if (messageAlias === undefined || folderAlias === undefined) {
			throw new Error("expected accepted aliases");
		}

		const reconstructed = scrubFreshMailboxInventoryFromBindings(
			{
				messages: [
					{
						id: "provider-message-1",
						receivedAt: "2026-07-26T12:00:00.000Z",
						read: false,
					},
					{
						id: "provider-message-unrelated",
						subject: "SENTINEL should never cross",
						receivedAt: "2026-07-27T12:00:00.000Z",
					},
				],
				folders: [{ id: "provider-folder-1", messageCount: 1 }],
			},
			context,
			{
				[messageAlias]: "provider-message-1",
				[folderAlias]: "provider-folder-1",
			},
		);

		expect(reconstructed.messages).toEqual(accepted.messages);
		expect(reconstructed.folders).toEqual(accepted.folders);
		expect(JSON.stringify(reconstructed)).not.toContain("SENTINEL");
		expect(JSON.stringify(reconstructed)).not.toContain(
			"provider-message-unrelated",
		);
	});
});

describe("createSessionAliasRegistry", () => {
	it("bootstraps account, run, and revision aliases hierarchically", () => {
		let sequence = 0;
		const registry = createSessionAliasRegistry({
			randomBytes: () => entropy(++sequence),
		});
		const accountScope = {
			providerId: "fake-mail",
			surface: "inbox",
		};
		const accountAlias = registry.bind(
			accountScope,
			"account",
			"provider-account",
		);
		const runScope = { ...accountScope, accountAlias };
		const runAlias = registry.bind(runScope, "run", "cleanup-run");
		const revisionScope = { ...runScope, runAlias };
		const revisionAlias = registry.bind(
			revisionScope,
			"revision",
			"revision-1",
		);

		expect(accountAlias).toMatch(/^acct_[a-f0-9]{32}$/);
		expect(runAlias).toMatch(/^run_[a-f0-9]{32}$/);
		expect(revisionAlias).toMatch(/^rev_[a-f0-9]{32}$/);
		expect(registry.resolve(accountScope, "account", accountAlias)).toBe(
			"provider-account",
		);
		expect(registry.resolve(runScope, "run", runAlias)).toBe("cleanup-run");
		expect(
			registry.resolve(revisionScope, "revision", revisionAlias),
		).toBe("revision-1");
	});

	it("creates non-reversible aliases and rejects cross-scope reuse", () => {
		let sequence = 0;
			const registry = createSessionAliasRegistry({
				randomBytes: () => entropy(++sequence),
			});
			const scope = bindHierarchy(registry);
			const otherScope = bindHierarchy(
				registry,
				"fake-mail",
				"other-provider-account",
			);
			const alias = registry.bind(scope, "message", "provider-message-42");

		expect(alias).toMatch(/^msg_/);
		expect(alias).not.toContain("provider-message-42");
		expect(registry.resolve(scope, "message", alias)).toBe(
			"provider-message-42",
		);
		expect(() =>
				registry.resolve(
						otherScope,
					"message",
					alias,
			),
		).toThrow(/scope/i);
	});

	it("rejects collisions rather than overwriting an existing binding", () => {
		let calls = 0;
		const registry = createSessionAliasRegistry({
			randomBytes: () => {
				calls += 1;
				return calls <= 3 ? entropy(calls) : entropy(7);
			},
		});
		const scope = bindHierarchy(registry);
		registry.bind(scope, "message", "provider-message-1");

		expect(() =>
			registry.bind(scope, "message", "provider-message-2"),
		).toThrow(/collision/i);
	});

	it("returns the same alias for the same raw binding within one scope", () => {
		let sequence = 0;
		const registry = createSessionAliasRegistry({
			randomBytes: () => entropy(++sequence),
		});
		const scope = bindHierarchy(registry);
		const alias = registry.bind(scope, "message", "provider-message-1");

		expect(registry.bind(scope, "message", "provider-message-1")).toBe(alias);
	});

	it("scrubs the same raw inventory idempotently with its caller-owned registry", () => {
		let sequence = 0;
		const aliases = createSessionAliasRegistry({
			randomBytes: () => entropy(++sequence),
		});
		const scope = bindHierarchy(aliases);
		const raw = {
			messages: [
				{
					id: "provider-message-1",
					receivedAt: "2026-07-27T12:00:00.000Z",
				},
			],
		};
		const context = {
			...scope,
			capturedAt: "2026-07-27T12:00:00.000Z",
		};

		expect(scrubMailboxInventory(raw, context, { aliases })).toEqual(
			scrubMailboxInventory(raw, context, { aliases }),
		);
	});

	it("rejects forged low-entropy aliases in a scrub context", () => {
		let sequence = 0;
		const registry = createSessionAliasRegistry({
			randomBytes: () => entropy(++sequence),
		});
		const scope = bindHierarchy(registry);
		expect(() =>
			validateMailboxAliasScope({
				...scope,
				revisionAlias: `rev_${"1".repeat(32)}`,
			}),
		).toThrow(/scope/i);
	});

	it("rejects an account alias minted under a different provider", () => {
		let sequence = 0;
		const registry = createSessionAliasRegistry({
			randomBytes: () => entropy(++sequence),
		});
		const alphaScope = { providerId: "alpha-mail", surface: "inbox" };
		const accountAlias = registry.bind(
			alphaScope,
			"account",
			"alpha-account",
		);

		expect(() =>
			registry.bind(
				{
					providerId: "beta-mail",
					surface: "inbox",
					accountAlias,
				},
				"run",
				"beta-run",
			),
		).toThrow(/scope/i);
	});

	it("rejects run and revision aliases from the wrong parent chain", () => {
		let sequence = 0;
		const registry = createSessionAliasRegistry({
			randomBytes: () => entropy(++sequence),
		});
		const root = { providerId: "fake-mail", surface: "inbox" };
		const accountAlias = registry.bind(root, "account", "account-a");
		const otherAccountAlias = registry.bind(root, "account", "account-b");
		const runScope = { ...root, accountAlias };
		const runAlias = registry.bind(runScope, "run", "run-a");

		expect(() =>
			registry.bind(
				{ ...root, accountAlias: otherAccountAlias, runAlias },
				"revision",
				"wrong-revision",
			),
		).toThrow(/scope/i);

		const revisionScope = { ...runScope, runAlias };
		const revisionAlias = registry.bind(
			revisionScope,
			"revision",
			"revision-a",
		);
		const otherRunScope = { ...root, accountAlias: otherAccountAlias };
		const otherRunAlias = registry.bind(otherRunScope, "run", "run-b");

		expect(() =>
			registry.bind(
				{
					...otherRunScope,
					runAlias: otherRunAlias,
					revisionAlias,
				},
				"message",
				"wrong-message",
			),
		).toThrow(/scope/i);
	});
});
