import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createSessionControl, MAX_SESSION_SITES, STOP_TTL_MS } from "@/lib/background/session-control";

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

	it("keeps a network values grant for the session until it is forgotten", async () => {
		const storage = memoryStorage();
		const control = createSessionControl({ storage });
		await control.allowValues("s1", "https://a.test");
		expect(await control.valuesAllowed("s1", "https://a.test")).toBe(true);
		expect(await control.valuesAllowed("s1", "https://b.test")).toBe(false);
		expect(await control.valuesAllowed("s2", "https://a.test")).toBe(false);
		await control.forget("s1");
		expect(await control.valuesAllowed("s1", "https://a.test")).toBe(false);
		expect(storage.data).toEqual({});
	});

	it("drops values grants on Stop and gives none after it", async () => {
		const control = createSessionControl({ storage: memoryStorage() });
		await control.allowValues("s1", "https://a.test");
		await control.stop("s1");
		expect(await control.valuesAllowed("s1", "https://a.test")).toBe(false);
		await control.allowValues("s1", "https://a.test");
		expect(await control.valuesAllowed("s1", "https://a.test")).toBe(false);
	});

	it("ignores a malformed stored value", async () => {
		const storage = memoryStorage();
		storage.data["pwExtSites:s1"] = "bad";
		expect(await createSessionControl({ storage }).allowed("s1", "https://a.test")).toBe(false);
	});
});

describe("session control stop expiry", () => {
	const START = Date.UTC(2026, 0, 1);
	const stoppedKeys = (data: Record<string, unknown>) => Object.keys(data).filter((key) => key.startsWith("pwExtStopped:"));

	afterEach(() => setSystemTime());

	it("records the stop time and refuses the session until 24 hours pass", async () => {
		setSystemTime(new Date(START));
		const storage = memoryStorage();
		const control = createSessionControl({ storage });
		await control.stop("s1");
		expect(storage.data["pwExtStopped:s1"]).toBe(START);
		setSystemTime(new Date(START + STOP_TTL_MS));
		expect(await control.stopped("s1")).toBe(true);
	});

	it("drops the tombstone of an ended session 24 hours and 1 ms after the stop", async () => {
		setSystemTime(new Date(START));
		const storage = memoryStorage();
		const control = createSessionControl({ storage, isPaired: async () => false });
		await control.stop("s1");
		setSystemTime(new Date(START + STOP_TTL_MS + 1));
		expect(await control.stopped("s1")).toBe(false);
		expect(stoppedKeys(storage.data)).toEqual([]);
	});

	it("keeps a session refused past 24 hours while its pairing is live", async () => {
		setSystemTime(new Date(START));
		const storage = memoryStorage();
		const control = createSessionControl({ storage, isPaired: async (id) => id === "s1" });
		await control.stop("s1");
		setSystemTime(new Date(START + STOP_TTL_MS + 1));
		expect(await control.stopped("s1")).toBe(true);
		expect(stoppedKeys(storage.data)).toEqual(["pwExtStopped:s1"]);
	});

	it("sweeps every expired tombstone when another session stops", async () => {
		setSystemTime(new Date(START));
		const storage = memoryStorage();
		const control = createSessionControl({ storage, isPaired: async () => false });
		for (let i = 0; i < 50; i++) await control.stop(`old${i}`);
		expect(stoppedKeys(storage.data)).toHaveLength(50);
		setSystemTime(new Date(START + STOP_TTL_MS + 1));
		await control.stop("fresh");
		expect(stoppedKeys(storage.data)).toEqual(["pwExtStopped:fresh"]);
	});

	it("reads a tombstone from before timestamps as a stop that starts now", async () => {
		setSystemTime(new Date(START));
		const storage = memoryStorage();
		storage.data["pwExtStopped:s1"] = true;
		const control = createSessionControl({ storage, isPaired: async () => false });
		expect(await control.stopped("s1")).toBe(true);
		expect(storage.data["pwExtStopped:s1"]).toBe(START);
	});
});
