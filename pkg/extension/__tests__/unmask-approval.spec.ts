import { describe, expect, it } from "bun:test";
import { createApprovals } from "@/lib/background/approval";
import { createUnmaskGrants, MAX_FILLED_SECRETS } from "@/lib/background/unmask-grants";

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

describe("unmask grants", () => {
	const TAB = { url: "https://app.example.test/users", groupId: 10 };

	it("holds a grant for its origin and tab group only", async () => {
		const clock = { now: 1_000 };
		const grants = createUnmaskGrants({ storage: memoryStorage(), now: () => clock.now });
		await grants.grant("s1", { origin: "https://app.example.test", groupId: 10, until: 61_000 });
		expect(await grants.active("s1", TAB)).toBeDefined();
		expect(await grants.active("s1", { ...TAB, groupId: 12 })).toBeUndefined();
		expect(await grants.active("s1", { ...TAB, url: "https://other.example.test/" })).toBeUndefined();
		expect(await grants.active("s2", TAB)).toBeUndefined();
		clock.now = 61_000;
		expect(await grants.active("s1", TAB)).toBeUndefined();
	});

	it("revokes and reports whether a grant was active", async () => {
		const storage = memoryStorage();
		const grants = createUnmaskGrants({ storage, now: () => 0 });
		await grants.grant("s1", { origin: "https://app.example.test", groupId: 10, until: 5_000 });
		expect(await grants.revoke("s1", "https://app.example.test")).toBe(true);
		expect(await grants.revoke("s1", "https://app.example.test")).toBe(false);
		expect(storage.data).toEqual({});
	});

	it("does not bring back a revoked grant when a grant for another site runs at the same time", async () => {
		const grants = createUnmaskGrants({ storage: memoryStorage(), now: () => 0 });
		await grants.grant("s1", { origin: "https://app.example.test", groupId: 10, until: 5_000 });
		await Promise.all([
			grants.revoke("s1", "https://app.example.test"),
			grants.grant("s1", { origin: "https://other.example.test", groupId: 10, until: 5_000 }),
		]);
		expect(await grants.active("s1", TAB)).toBeUndefined();
		expect(await grants.active("s1", { ...TAB, url: "https://other.example.test/" })).toBeDefined();
	});

	it("keeps secret fill values in session storage and refuses more past the cap", async () => {
		const storage = memoryStorage();
		const grants = createUnmaskGrants({ storage, now: () => 0 });
		for (let i = 0; i < MAX_FILLED_SECRETS; i++) expect(await grants.remember("s1", `v${i}`)).toBe(true);
		expect(await grants.remember("s1", "v0")).toBe(true);
		expect(await grants.remember("s1", "one-more")).toBe(false);
		const restarted = createUnmaskGrants({ storage, now: () => 0 });
		expect(await restarted.secrets("s1")).toHaveLength(MAX_FILLED_SECRETS);
		expect(await restarted.secrets("s2")).toEqual([]);
	});

	it("forgets every grant and secret of an ended session", async () => {
		const storage = memoryStorage();
		const grants = createUnmaskGrants({ storage, now: () => 0 });
		await grants.grant("s1", { origin: "https://app.example.test", groupId: 10, until: 5_000 });
		await grants.remember("s1", "hunter2");
		await grants.remember("s2", "kept");
		await grants.forget("s1");
		expect(await grants.active("s1", TAB)).toBeUndefined();
		expect(await grants.secrets("s1")).toEqual([]);
		expect(await grants.secrets("s2")).toEqual(["kept"]);
	});
});

function fakeWindows() {
	const opened: string[] = [];
	const closed: number[] = [];
	let removed: (id: number) => void = () => undefined;
	return {
		opened,
		closed,
		removeWindow: (id: number) => removed(id),
		windows: {
			open: async (url: string) => (opened.push(url), 40 + opened.length),
			close: async (id: number) => void closed.push(id),
			onRemoved: (listener: (id: number) => void) => {
				removed = listener;
			},
		},
	};
}

const REQUEST = { title: "Let the agent see personal data?", origin: "https://app.example.test", lines: ["a"] };

describe("approvals", () => {
	it("opens the approval page, shows the request, and allows on a click", async () => {
		const w = fakeWindows();
		const approvals = createApprovals({ windows: w.windows, pageUrl: (p) => `ext:${p}`, newId: () => "id1" });
		const answer = approvals.request(REQUEST);
		await Bun.sleep(0);
		expect(w.opened).toEqual(["ext:/approve.html?id=id1"]);
		expect(approvals.show("id1")).toEqual(REQUEST);
		approvals.answer("id1", true);
		expect(await answer).toBe("allow");
		expect(approvals.show("id1")).toBeUndefined();
		expect(w.closed).toEqual([41]);
	});

	it("answers closed, not deny, when its own window is closed", async () => {
		const w = fakeWindows();
		const approvals = createApprovals({ windows: w.windows, pageUrl: (p) => p, newId: () => "id1" });
		const answer = approvals.request(REQUEST);
		await Bun.sleep(0);
		w.removeWindow(41);
		expect(await answer).toBe("closed");
	});

	it("ignores the close of another window", async () => {
		const w = fakeWindows();
		const approvals = createApprovals({ windows: w.windows, pageUrl: (p) => p, newId: () => "id1" });
		const answer = approvals.request(REQUEST);
		await Bun.sleep(0);
		w.removeWindow(7);
		expect(approvals.show("id1")).toEqual(REQUEST);
		approvals.answer("id1", true);
		expect(await answer).toBe("allow");
	});

	it("is not settled by the late close of the window of an earlier denied request", async () => {
		const w = fakeWindows();
		let next = 0;
		const approvals = createApprovals({ windows: w.windows, pageUrl: (p) => p, newId: () => `id${++next}` });
		const first = approvals.request(REQUEST);
		await Bun.sleep(0);
		approvals.answer("id1", false);
		expect(await first).toBe("deny");
		const second = approvals.request(REQUEST);
		await Bun.sleep(0);
		w.removeWindow(41);
		approvals.answer("id1", false);
		expect(approvals.show("id2")).toEqual(REQUEST);
		approvals.answer("id2", true);
		expect(await second).toBe("allow");
	});

	it("times out with no answer", async () => {
		const w = fakeWindows();
		const approvals = createApprovals({ windows: w.windows, pageUrl: (p) => p, timeoutMs: 5 });
		expect(await approvals.request(REQUEST)).toBe("timeout");
	});

	it.each([
		["rejects", async () => Promise.reject(new Error("no windows"))],
		["gives no window id", async () => undefined],
	])("answers unopened, not deny, when the window open %s", async (_name, open) => {
		const approvals = createApprovals({
			windows: { ...fakeWindows().windows, open },
			pageUrl: (p) => p,
		});
		expect(await approvals.request(REQUEST)).toBe("unopened");
	});
});
