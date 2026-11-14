import { describe, expect, it } from "bun:test";
import type { ApprovalAnswer, ApprovalRequest } from "@/lib/background/approval";
import { createWebMcpGrants, requestWebMcpApproval } from "@/lib/background/webmcp-approval";

function memoryStorage() {
	const data: Record<string, unknown> = {};
	return {
		data,
		session: {
			get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
			set: async (items: Record<string, unknown>) => void Object.assign(data, items),
			remove: async (key: string) => void delete data[key],
		},
	};
}

const ORIGIN = "https://outlook.live.com";

function setup(answer: ApprovalAnswer = "allow") {
	const requests: ApprovalRequest[] = [];
	const storage = memoryStorage();
	const grants = createWebMcpGrants({ storage });
	const approvals = {
		request: async (request: ApprovalRequest) => {
			requests.push(request);
			return answer;
		},
	};
	const ask = (overrides: Partial<Parameters<typeof requestWebMcpApproval>[0]> = {}) =>
		requestWebMcpApproval({
			approvals,
			grants,
			sessionId: "s1",
			agentIdentity: "claude-orchestrator",
			tool: "dg_outlook_delete",
			args: { ids: ["AAMkADQ1=", "AAMkADQ2="] },
			origin: ORIGIN,
			groupId: 10,
			class: "each",
			...overrides,
		});
	return { requests, storage, grants, ask };
}

describe("requestWebMcpApproval", () => {
	it("shows the tool, the origin, the agent and the ids in the prompt", async () => {
		const { requests, ask } = setup();
		expect(await ask()).toBe("allow");
		expect(requests).toEqual([
			{
				title: `Allow dg_outlook_delete on ${ORIGIN}?`,
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

	it.each([-1, Number.NaN])("stores no grant and asks every time for group %p", async (groupId) => {
		const { requests, storage, ask } = setup();
		await ask({ tool: "dg_outlook_move", class: "session", groupId });
		await ask({ tool: "dg_outlook_move", class: "session", groupId });
		expect(requests).toHaveLength(2);
		expect(storage.data).toEqual({});
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
			"webmcpGrants:s1": [{ origin: ORIGIN, tool: "dg_outlook_move", groupId: 10 }],
		});
	});

	it("does not ask again for the same session, origin, tool and group", async () => {
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

	it("asks again after a denied concurrent ask settles", async () => {
		const { requests, ask } = setup("deny");
		const move = { tool: "dg_outlook_move", class: "session" } as const;
		await Promise.all([ask(move), ask(move)]);
		expect(await ask(move)).toBe("deny");
		expect(requests).toHaveLength(2);
	});

	it.each([
		["another session", { sessionId: "s2" }],
		["another tool", { tool: "dg_outlook_flag" }],
		["another origin", { origin: "https://outlook.office.com" }],
		["another tab group", { groupId: 11 }],
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
		storage.data["webmcpGrants:s1"] = [{ origin: ORIGIN, tool: "dg_outlook_delete", groupId: 10 }];
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
			grants.add("s1", { origin: ORIGIN, tool: "dg_outlook_move", groupId: 10 }),
			grants.add("s1", { origin: ORIGIN, tool: "dg_outlook_flag", groupId: 10 }),
		]);
		expect(await grants.has("s1", { origin: ORIGIN, tool: "dg_outlook_move", groupId: 10 })).toBe(true);
		expect(await grants.has("s1", { origin: ORIGIN, tool: "dg_outlook_flag", groupId: 10 })).toBe(true);
	});

	it("ignores a malformed stored value", async () => {
		const { grants, storage } = setup();
		storage.data["webmcpGrants:s1"] = "bad";
		expect(await grants.has("s1", { origin: ORIGIN, tool: "dg_outlook_move", groupId: 10 })).toBe(false);
	});

	it("forgets one session's grants after a pending add and keeps the others", async () => {
		const { grants, storage } = setup();
		storage.data["webmcpGrants:s2"] = [{ origin: ORIGIN, tool: "dg_outlook_move", groupId: 11 }];
		const added = grants.add("s1", { origin: ORIGIN, tool: "dg_outlook_move", groupId: 10 });
		await Promise.all([added, grants.forget("s1")]);
		expect(storage.data["webmcpGrants:s1"]).toBeUndefined();
		expect(storage.data["webmcpGrants:s2"]).toHaveLength(1);
	});
});
