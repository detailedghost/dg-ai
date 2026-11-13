import { describe, expect, it } from "bun:test";
import type { ApprovalAnswer, ApprovalRequest } from "@/lib/background/approval";
import {
	createRememberedWebMcpGrants,
	createWebMcpGrants,
	REMEMBER_DAYS,
	requestWebMcpApproval,
} from "@/lib/background/webmcp-approval";
import { createWebMcpSigner } from "@/lib/background/webmcp-signing";
import { createIdbGrantNonces, type GrantNonces } from "@/lib/background/webmcp-grant-nonces";
import { IDBFactory } from "fake-indexeddb";

function memoryStorage() {
	const data: Record<string, unknown> = {};
	const local: Record<string, unknown> = {};
	return {
		data,
		localData: local,
		session: {
			get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
			set: async (items: Record<string, unknown>) => void Object.assign(data, items),
			remove: async (key: string) => void delete data[key],
		},
		local: {
			get: async (key: string) => ({ [key]: structuredClone(local[key]) }),
			set: async (items: Record<string, unknown>) => void Object.assign(local, structuredClone(items)),
		},
	};
}

const ORIGIN = "https://outlook.live.com";
const SITE = "https://live.com";
const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 13, 12, 0);

const keyLoader = () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

function setup(
	answer: ApprovalAnswer = "allow",
	options: { remember?: boolean; key?: Promise<CryptoKey>; nonces?: GrantNonces } = {},
) {
	const requests: ApprovalRequest[] = [];
	const storage = memoryStorage();
	const clock = { now: START };
	const key = options.key ?? keyLoader();
	const nonces = options.nonces ?? createIdbGrantNonces(new IDBFactory());
	const grants = createWebMcpGrants({ storage });
	const remembered = createRememberedWebMcpGrants({
		storage,
		signer: createWebMcpSigner({ loadKey: () => key }),
		nonces,
		now: () => clock.now,
	});
	const approvals = {
		ask: async (request: ApprovalRequest) => {
			requests.push(request);
			return { answer, remember: options.remember ?? false };
		},
	};
	const ask = (overrides: Partial<Parameters<typeof requestWebMcpApproval>[0]> = {}) =>
		requestWebMcpApproval({
			approvals,
			grants,
			remembered,
			sessionId: "s1",
			agentIdentity: "claude-orchestrator",
			tool: "dg_outlook_delete",
			args: { ids: ["AAMkADQ1=", "AAMkADQ2="] },
			origin: ORIGIN,
			class: "each",
			...overrides,
		});
	return { requests, storage, grants, remembered, ask, clock, key, nonces };
}

describe("requestWebMcpApproval", () => {
	it("shows the tool, the origin, the agent and the ids in the prompt", async () => {
		const { requests, ask } = setup();
		expect(await ask()).toBe("allow");
		expect(requests).toEqual([
			{
				title: "Allow dg_outlook_delete on live.com?",
				origin: ORIGIN,
				lines: [
					"Agent: claude-orchestrator",
					"Tool: dg_outlook_delete",
					'Args: {"ids":["AAMkADQ1=","AAMkADQ2="]}',
					expect.stringContaining("every time"),
				],
			},
		]);
	});

	it("clips the args JSON to 600 characters and says how many were cut", async () => {
		const { requests, ask } = setup();
		const note = "n".repeat(5_000);
		await ask({ args: { note } });
		const line = requests[0]?.lines.find((entry) => entry.startsWith("Args: ")) ?? "";
		const total = JSON.stringify({ note }).length;
		expect(line).toBe(`Args: ${JSON.stringify({ note }).slice(0, 600)} (${total - 600} more characters not shown)`);
	});

	it("shows control and bidi characters as escapes", async () => {
		const { requests, ask } = setup();
		await ask({ args: { name: "a\u202Eb\u0007c\u200Bd" } });
		const line = requests[0]?.lines.find((entry) => entry.startsWith("Args: ")) ?? "";
		expect(line).toContain("\\u202e");
		expect(line).toContain("\\u0007");
		expect(line).toContain("\\u200b");
		expect(line).not.toMatch(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e]/);
	});

	it("passes the deny and timeout answers through", async () => {
		expect(await setup("deny").ask()).toBe("deny");
		expect(await setup("timeout").ask()).toBe("timeout");
	});

	it("asks every time for the each class and stores nothing", async () => {
		const { requests, storage, ask } = setup();
		await ask();
		await ask();
		expect(requests).toHaveLength(2);
		expect(storage.data).toEqual({});
	});

	it("stores a session grant on allow in storage.session under the session key", async () => {
		const { storage, ask } = setup();
		await ask({ tool: "dg_outlook_move", class: "session" });
		expect(storage.data).toEqual({
			"webmcpGrants:s1": [{ site: SITE, tool: "dg_outlook_move" }],
		});
	});

	it("does not ask again for the same session, site and tool", async () => {
		const { requests, ask } = setup();
		await ask({ tool: "dg_outlook_move", class: "session" });
		expect(await ask({ tool: "dg_outlook_move", class: "session" })).toBe("allow");
		expect(requests).toHaveLength(1);
	});

	it.each(["allow", "deny"] as const)("shows one popup when two calls of a session tool ask at the same time (%s)", async (answer) => {
		const { requests, ask } = setup(answer);
		const move = { tool: "dg_outlook_move", class: "session" } as const;
		expect(await Promise.all([ask(move), ask(move)])).toEqual([answer, answer]);
		expect(requests).toHaveLength(1);
	});

	it.each([
		["another session", { sessionId: "s2" }],
		["another tool", { tool: "dg_outlook_flag" }],
		["another site", { origin: "https://outlook.office.com" }],
	])("asks again for %s", async (_label, change) => {
		const { requests, ask } = setup();
		await ask({ tool: "dg_outlook_move", class: "session" });
		await ask({ tool: "dg_outlook_move", class: "session", ...change });
		expect(requests).toHaveLength(2);
	});

	it("stores no grant on deny or timeout", async () => {
		for (const answer of ["deny", "timeout", "closed", "unopened"] as const) {
			const { storage, ask } = setup(answer);
			await ask({ tool: "dg_outlook_move", class: "session" });
			expect(storage.data).toEqual({});
		}
	});

	it("never grants a tool of the each class even when a stored grant names it", async () => {
		const { requests, storage, ask } = setup();
		storage.data["webmcpGrants:s1"] = [{ site: SITE, tool: "dg_outlook_delete" }];
		await ask();
		expect(requests).toHaveLength(1);
	});

	it("runs a read tool without asking", async () => {
		const { requests, ask } = setup();
		expect(await ask({ tool: "dg_outlook_list", class: "read" })).toBe("allow");
		expect(requests).toEqual([]);
	});
});

describe("createWebMcpGrants", () => {
	it("keeps both grants when two are added at the same time", async () => {
		const { grants } = setup();
		await Promise.all([
			grants.add("s1", { site: SITE, tool: "dg_outlook_move" }),
			grants.add("s1", { site: SITE, tool: "dg_outlook_flag" }),
		]);
		expect(await grants.has("s1", { site: SITE, tool: "dg_outlook_move" })).toBe(true);
		expect(await grants.has("s1", { site: SITE, tool: "dg_outlook_flag" })).toBe(true);
	});

	it("ignores a malformed stored value", async () => {
		const { grants, storage } = setup();
		storage.data["webmcpGrants:s1"] = "bad";
		expect(await grants.has("s1", { site: SITE, tool: "dg_outlook_move" })).toBe(false);
	});

	it("forgets one session's grants after a pending add and keeps the others", async () => {
		const { grants, storage } = setup();
		storage.data["webmcpGrants:s2"] = [{ site: SITE, tool: "dg_outlook_move" }];
		const added = grants.add("s1", { site: SITE, tool: "dg_outlook_move" });
		await Promise.all([added, grants.forget("s1")]);
		expect(storage.data["webmcpGrants:s1"]).toBeUndefined();
		expect(storage.data["webmcpGrants:s2"]).toHaveLength(1);
	});
});

describe("Web MCP grant key", () => {
	it("keys a session grant by registrable domain, so another host of the same site needs no new ask", async () => {
		const { requests, ask } = setup();
		await ask({ tool: "dg_outlook_move", class: "session", origin: "https://outlook.live.com" });
		await ask({ tool: "dg_outlook_move", class: "session", origin: "https://mail.live.com" });
		expect(requests).toHaveLength(1);
	});

	it("stores no tab group in a grant", async () => {
		const { storage, ask } = setup();
		await ask({ tool: "dg_outlook_move", class: "session" });
		expect(Object.keys((storage.data["webmcpGrants:s1"] as object[])[0] ?? {}).sort()).toEqual(["site", "tool"]);
	});
});

describe("createWebMcpGrants list and revoke", () => {
	it("lists the grants of every session", async () => {
		const { grants } = setup();
		await grants.add("s1", { site: SITE, tool: "dg_outlook_move" });
		await grants.add("s2", { site: SITE, tool: "dg_outlook_flag" });
		expect(await grants.list()).toEqual([
			{ sessionId: "s1", site: SITE, tool: "dg_outlook_move" },
			{ sessionId: "s2", site: SITE, tool: "dg_outlook_flag" },
		]);
	});

	it("revokes one grant and keeps the others", async () => {
		const { grants } = setup();
		await grants.add("s1", { site: SITE, tool: "dg_outlook_move" });
		await grants.add("s1", { site: SITE, tool: "dg_outlook_flag" });
		await grants.revoke("s1", { site: SITE, tool: "dg_outlook_move" });
		expect(await grants.list()).toEqual([{ sessionId: "s1", site: SITE, tool: "dg_outlook_flag" }]);
	});

	it("forgets every session's grants and leaves other keys", async () => {
		const { grants, storage } = setup();
		storage.data["pwExtSites:s1"] = [SITE];
		await grants.add("s1", { site: SITE, tool: "dg_outlook_move" });
		await grants.add("s2", { site: SITE, tool: "dg_outlook_move" });
		await grants.forgetAll();
		expect(storage.data).toEqual({ "pwExtSites:s1": [SITE] });
	});
});

describe("remember for 30 days", () => {
	const move = { tool: "dg_outlook_move", class: "session" } as const;

	it("offers the remember choice for a session tool", async () => {
		const { requests, ask } = setup();
		await ask(move);
		expect(requests[0]?.remember).toContain(`${REMEMBER_DAYS} days`);
	});

	it("never offers or stores the remember choice for an each tool", async () => {
		const { requests, storage, ask } = setup("allow", { remember: true });
		await ask();
		await ask();
		expect(requests).toHaveLength(2);
		expect(requests[0]?.remember).toBeUndefined();
		expect(storage.localData).toEqual({});
	});

	it("keeps a remembered grant across sessions and a simulated restart", async () => {
		const factory = new IDBFactory();
		const first = { ...setup("allow", { remember: true, nonces: createIdbGrantNonces(factory) }), factory };
		await first.ask(move);
		const restarted = setup("deny", { key: first.key, nonces: createIdbGrantNonces(first.factory) });
		Object.assign(restarted.storage.localData, structuredClone(first.storage.localData));
		expect(await restarted.ask({ ...move, sessionId: "s9" })).toBe("allow");
		expect(restarted.requests).toEqual([]);
	});

	it("stores a session grant only, without the choice", async () => {
		const { storage, grants, ask } = setup();
		await ask(move);
		expect(storage.localData).toEqual({});
		await grants.forget("s1");
		await ask(move);
		expect(storage.data["webmcpGrants:s1"]).toHaveLength(1);
	});

	it("ends a remembered grant after 30 days and does not extend it on use", async () => {
		const { requests, ask, clock, remembered } = setup("allow", { remember: true });
		await ask(move);
		const [held] = await remembered.list();
		expect(held?.expiresAt).toBe(START + 30 * DAY);
		clock.now = START + 30 * DAY - 1;
		expect(await ask({ ...move, sessionId: "s2" })).toBe("allow");
		expect((await remembered.list())[0]?.expiresAt).toBe(START + 30 * DAY);
		clock.now = START + 30 * DAY;
		expect(await remembered.list()).toEqual([]);
		await ask({ ...move, sessionId: "s3" });
		expect(requests).toHaveLength(2);
	});

	it.each([
		["a changed expiry", (entry: Record<string, unknown>) => ({ ...entry, expiresAt: (entry.expiresAt as number) + DAY })],
		["a changed tool", (entry: Record<string, unknown>) => ({ ...entry, tool: "dg_outlook_flag" })],
		["a bad mac", (entry: Record<string, unknown>) => ({ ...entry, mac: "00".repeat(32) })],
		["no mac", ({ mac: _mac, ...entry }: Record<string, unknown>) => entry],
		["a changed nonce", (entry: Record<string, unknown>) => ({ ...entry, nonce: "00".repeat(16) })],
	])("refuses a record with %s", async (_label, tamper) => {
		const { storage, remembered, ask, requests } = setup("allow", { remember: true });
		await ask(move);
		const [entry] = storage.localData.webmcpRemembered as Record<string, unknown>[];
		storage.localData.webmcpRemembered = [tamper(entry as Record<string, unknown>)];
		expect(await remembered.list()).toEqual([]);
		await ask({ ...move, tool: "dg_outlook_flag", sessionId: "s2" });
		await ask({ ...move, sessionId: "s2" });
		expect(requests).toHaveLength(3);
	});

	it("refuses a revoked record that is written back", async () => {
		const { storage, remembered, ask, requests } = setup("allow", { remember: true });
		await ask(move);
		const saved = structuredClone(storage.localData.webmcpRemembered);
		await remembered.revoke({ site: SITE, tool: "dg_outlook_move" });
		storage.localData.webmcpRemembered = saved;
		expect(await remembered.has({ site: SITE, tool: "dg_outlook_move" })).toBe(false);
		await ask({ ...move, sessionId: "s2" });
		expect(requests).toHaveLength(2);
	});

	it("refuses a record hidden during Revoke and written back after", async () => {
		const { storage, remembered } = setup();
		await remembered.add({ site: SITE, tool: "dg_outlook_move" });
		const saved = structuredClone(storage.localData.webmcpRemembered);
		storage.localData.webmcpRemembered = [];
		await remembered.revoke({ site: SITE, tool: "dg_outlook_move" });
		storage.localData.webmcpRemembered = saved;
		expect(await remembered.list()).toEqual([]);
	});

	it("rejects a revoke whose nonce delete fails, and keeps working after", async () => {
		const nonces = createIdbGrantNonces(new IDBFactory());
		let broken = true;
		const flaky: GrantNonces = {
			...nonces,
			removeGrant: async (grant) => {
				if (broken) throw new Error("idb broke");
				await nonces.removeGrant(grant);
			},
			clear: async () => {
				if (broken) throw new Error("idb broke");
				await nonces.clear();
			},
		};
		const { remembered } = setup("allow", { nonces: flaky });
		await nonces.add("n1", { site: SITE, tool: "dg_outlook_flag" });
		await expect(remembered.revoke({ site: SITE, tool: "dg_outlook_move" })).rejects.toThrow("idb broke");
		await expect(remembered.forgetAll()).rejects.toThrow("idb broke");
		broken = false;
		await remembered.add({ site: SITE, tool: "dg_outlook_move" });
		await remembered.revoke({ site: SITE, tool: "dg_outlook_move" });
		expect(await remembered.list()).toEqual([]);
	});

	it("rejects a session revoke whose storage write fails", async () => {
		const { grants, storage } = setup();
		await grants.add("s1", { site: SITE, tool: "dg_outlook_move" });
		storage.session.remove = async () => {
			throw new Error("session broke");
		};
		await expect(grants.revoke("s1", { site: SITE, tool: "dg_outlook_move" })).rejects.toThrow("session broke");
		await expect(grants.forgetAll()).rejects.toThrow("session broke");
	});

	it("refuses every record written back after Revoke all", async () => {
		const { storage, remembered } = setup();
		await remembered.add({ site: SITE, tool: "dg_outlook_move" });
		const saved = structuredClone(storage.localData.webmcpRemembered);
		await remembered.forgetAll();
		storage.localData.webmcpRemembered = saved;
		expect(await remembered.list()).toEqual([]);
	});

	it("refuses a record signed with another key", async () => {
		const forger = setup("allow", { remember: true });
		await forger.ask(move);
		const victim = setup("allow");
		victim.storage.localData.webmcpRemembered = structuredClone(forger.storage.localData.webmcpRemembered);
		expect(await victim.remembered.list()).toEqual([]);
	});

	it("revokes one remembered grant and revokes all", async () => {
		const { remembered } = setup();
		await remembered.add({ site: SITE, tool: "dg_outlook_move" });
		await remembered.add({ site: SITE, tool: "dg_outlook_flag" });
		await remembered.revoke({ site: SITE, tool: "dg_outlook_move" });
		expect((await remembered.list()).map((grant) => grant.tool)).toEqual(["dg_outlook_flag"]);
		await remembered.forgetAll();
		expect(await remembered.list()).toEqual([]);
	});
});
