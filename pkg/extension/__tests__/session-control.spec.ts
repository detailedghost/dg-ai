import { describe, expect, it } from "bun:test";
import { createSessionControl, MAX_SESSION_SITES } from "@/lib/background/session-control";

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

describe("session control", () => {
	it("allows an origin for one session only, and forgets it with the session", async () => {
		const storage = memoryStorage();
		const control = createSessionControl({ storage });
		await control.allow("s1", "https://app.example.test");
		expect(await control.allowed("s1", "https://app.example.test")).toBe(true);
		expect(await control.allowed("s1", "https://other.example.test")).toBe(false);
		expect(await control.allowed("s2", "https://app.example.test")).toBe(false);
		await control.forget("s1");
		expect(await control.allowed("s1", "https://app.example.test")).toBe(false);
		expect(storage.data).toEqual({});
	});

	it("keeps both origins when two are allowed at the same time", async () => {
		const control = createSessionControl({ storage: memoryStorage() });
		await Promise.all([control.allow("s1", "https://a.test"), control.allow("s1", "https://b.test")]);
		expect(await control.allowed("s1", "https://a.test")).toBe(true);
		expect(await control.allowed("s1", "https://b.test")).toBe(true);
	});

	it("keeps at most the newest origins", async () => {
		const control = createSessionControl({ storage: memoryStorage() });
		for (let i = 0; i <= MAX_SESSION_SITES; i++) await control.allow("s1", `https://site${i}.test`);
		expect(await control.allowed("s1", "https://site0.test")).toBe(false);
		expect(await control.allowed("s1", `https://site${MAX_SESSION_SITES}.test`)).toBe(true);
	});

	it("stops a session, drops its sites, and keeps it stopped even after the session is forgotten", async () => {
		const storage = memoryStorage();
		const control = createSessionControl({ storage });
		await control.allow("s1", "https://a.test");
		await control.stop("s1");
		expect(await control.stopped("s1")).toBe(true);
		expect(await control.stopped("s2")).toBe(false);
		expect(await control.allowed("s1", "https://a.test")).toBe(false);
		await control.allow("s1", "https://a.test");
		expect(await control.allowed("s1", "https://a.test")).toBe(false);
		await control.forget("s1");
		expect(await control.stopped("s1")).toBe(true);
	});

	it("ignores a malformed stored value", async () => {
		const storage = memoryStorage();
		storage.data["pwExtSites:s1"] = "bad";
		expect(await createSessionControl({ storage }).allowed("s1", "https://a.test")).toBe(false);
	});
});
