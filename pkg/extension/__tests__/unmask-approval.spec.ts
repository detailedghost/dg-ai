import { describe, expect, it } from "bun:test";
import { createApprovals } from "@/lib/background/approval";
import { createUnmaskGrants } from "@/lib/background/unmask-grants";

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

	it("denies when the window is closed", async () => {
		const w = fakeWindows();
		const approvals = createApprovals({ windows: w.windows, pageUrl: (p) => p, newId: () => "id1" });
		const answer = approvals.request(REQUEST);
		await Bun.sleep(0);
		w.removeWindow(41);
		expect(await answer).toBe("deny");
	});

	it("times out with no answer", async () => {
		const w = fakeWindows();
		const approvals = createApprovals({ windows: w.windows, pageUrl: (p) => p, timeoutMs: 5 });
		expect(await approvals.request(REQUEST)).toBe("timeout");
	});

	it("denies when the window cannot open", async () => {
		const approvals = createApprovals({
			windows: { ...fakeWindows().windows, open: async () => Promise.reject(new Error("no windows")) },
			pageUrl: (p) => p,
		});
		expect(await approvals.request(REQUEST)).toBe("deny");
	});
});
