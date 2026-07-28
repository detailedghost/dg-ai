import { describe, expect, it } from "bun:test";
import { createMailboxCliAuthority } from "@/lib/background/mailbox-cli-authority";

const CONNECTION = Object.freeze({
	schemaVersion: 1 as const,
	origin: "http://127.0.0.1:45678",
	runAlias: "run_0123456789abcdef0123456789abcdef",
	nonce: "fedcba9876543210fedcba9876543210",
	token:
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});

describe("mailbox CLI inbound authority", () => {
	it.each([
		["chrome", "chrome-extension://dgtest/", "dgtest"],
		["Firefox", "moz-extension://dg-test/", "dg-test"],
	] as const)(
		"binds one approved %s session to the exact tabs, frame, capability, and replay key",
		async (_name, extensionOrigin, extensionId) => {
			const values = new Map<string, unknown>();
			let approvalUrl = "";
			const authority = createMailboxCliAuthority({
				extensionOrigin,
				session: {
					get: async (key) => values.get(key),
					async set(key, value) {
						values.set(key, structuredClone(value));
					},
					async delete(key) {
						values.delete(key);
					},
				},
				async openApproval(url) {
					approvalUrl = url;
					return { id: 22 };
				},
				now: () => 1_900_000_000_000,
				randomBytes: (size) =>
					new Uint8Array(size).map((_, index) => index + 1),
			});
			const approved = authority.authorize(CONNECTION, {
				id: extensionId,
				frameId: 0,
				url:
					`${CONNECTION.origin}/mailbox-cleanup/v1/connect/` +
					CONNECTION.runAlias,
				tab: { id: 11 },
			});
			await Promise.resolve();
			await Promise.resolve();
			const alias = new URL(approvalUrl).hash.slice(
				"#approval=".length,
			);
			const sender = {
				id: extensionId,
				frameId: 0,
				url: approvalUrl,
				tab: { id: 22 },
			};

			await expect(authority.inspect(alias, sender)).resolves.toEqual({
				schemaVersion: 1,
				origin: CONNECTION.origin,
				runAlias: CONNECTION.runAlias,
				expiresAt: new Date(1_900_000_060_000).toISOString(),
			});
			await expect(
				authority.inspect(alias, {
					...sender,
					tab: { id: 23 },
				}),
			).rejects.toThrow("not authorized");
			await authority.decide(alias, "approve", sender);
			await expect(approved).resolves.toBeUndefined();
			await expect(
				authority.authorize(CONNECTION, {
					id: extensionId,
					frameId: 0,
					url:
						`${CONNECTION.origin}/mailbox-cleanup/v1/connect/` +
						CONNECTION.runAlias,
					tab: { id: 11 },
				}),
			).rejects.toThrow("not authorized");
			authority.dispose();
		},
	);

	it("fails closed when the trusted approval page denies the connection", async () => {
		let approvalUrl = "";
		const authority = createMailboxCliAuthority({
			extensionOrigin: "chrome-extension://dgtest/",
			session: {
				async get() {},
				async set() {},
				async delete() {},
			},
			async openApproval(url) {
				approvalUrl = url;
				return { id: 22 };
			},
			now: () => 1_900_000_000_000,
			randomBytes: (size) =>
				new Uint8Array(size).map((_, index) => index + 1),
		});
		const pending = authority.authorize(CONNECTION, {
			id: "dgtest",
			frameId: 0,
			url:
				`${CONNECTION.origin}/mailbox-cleanup/v1/connect/` +
				CONNECTION.runAlias,
			tab: { id: 11 },
		});
		await Promise.resolve();
		await Promise.resolve();
		const alias = new URL(approvalUrl).hash.slice("#approval=".length);

		await authority.decide(
			alias,
			"deny",
			{
				id: "dgtest",
				frameId: 0,
				url: approvalUrl,
				tab: { id: 22 },
			},
		);
		await expect(pending).rejects.toThrow("denied");
		authority.dispose();
	});

	it("expires an unconsumed approval without exposing connection authority", async () => {
		let now = 1_900_000_000_000;
		let approvalUrl = "";
		const authority = createMailboxCliAuthority({
			extensionOrigin: "chrome-extension://dgtest/",
			session: {
				async get() {},
				async set() {},
				async delete() {},
			},
			async openApproval(url) {
				approvalUrl = url;
				return { id: 22 };
			},
			now: () => now,
			randomBytes: (size) =>
				new Uint8Array(size).map((_, index) => index + 1),
			approvalTtlMs: 5_000,
		});
		const pending = authority.authorize(CONNECTION, {
			id: "dgtest",
			frameId: 0,
			url:
				`${CONNECTION.origin}/mailbox-cleanup/v1/connect/` +
				CONNECTION.runAlias,
			tab: { id: 11 },
		});
		await Promise.resolve();
		await Promise.resolve();
		now += 5_001;

		await expect(
			authority.inspect(
				new URL(approvalUrl).hash.slice("#approval=".length),
				{
					id: "dgtest",
					frameId: 0,
					url: approvalUrl,
					tab: { id: 22 },
				},
			),
		).rejects.toThrow("not authorized");
		authority.dispose();
		await expect(pending).rejects.toThrow("closed");
	});
});
