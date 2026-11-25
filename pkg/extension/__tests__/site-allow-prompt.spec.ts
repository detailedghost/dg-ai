import { describe, expect, it } from "bun:test";
import { createSessionControl } from "@/lib/background/session-control";
import {
	createSiteAllow,
	PhiCaptureRefusedError,
	registerSiteAllow,
	SITE_ALLOW_MSG,
	type SiteAllowWindows,
} from "@/lib/background/site-allow-prompt";

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

function setup({ timeoutMs = 60_000, open }: { timeoutMs?: number; open?: () => Promise<number | undefined> } = {}) {
	const storage = memoryStorage();
	const control = createSessionControl({ storage });
	const opened: string[] = [];
	const closed: number[] = [];
	const removed: ((windowId: number) => void)[] = [];
	const loaded: { sessionId: string; url: string }[] = [];
	let ids = 0;
	const windows: SiteAllowWindows = {
		open: open ?? (async (url) => (opened.push(url), 500 + opened.length)),
		close: async (windowId) => void closed.push(windowId),
		onRemoved: (listener) => void removed.push(listener),
	};
	const allow = createSiteAllow({
		control,
		storage,
		windows,
		pageUrl: (path) => `chrome-extension://dg${path}`,
		timeoutMs,
		newId: () => `id${++ids}`,
		navigate: async (sessionId, url) => void loaded.push({ sessionId, url }),
	});
	return { allow, control, storage, opened, closed, removed, loaded };
}

describe("requestSiteAllow", () => {
	it("opens the prompt page and resolves allow after an Allow click, storing it for the session", async () => {
		const { allow, control, opened } = setup();
		const pending = allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		await Promise.resolve();
		await Promise.resolve();
		expect(opened).toEqual(["chrome-extension://dg/site-allow.html?id=id1"]);
		expect(allow.show("id1")).toMatchObject({ siteKey: "https://example.com", sessionId: "s1" });
		allow.answer("id1", true);
		expect(await pending).toBe("allow");
		expect(await control.allowed("s1", "https://example.com")).toBe(true);
		expect(await control.allowed("s2", "https://example.com")).toBe(false);
	});

	it("resolves deny after a Deny click and stores nothing", async () => {
		const { allow, control } = setup();
		const pending = allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		allow.answer("id1", false);
		expect(await pending).toBe("deny");
		expect(await control.allowed("s1", "https://example.com")).toBe(false);
	});

	it.each([
		["timeout", async (s: ReturnType<typeof setup>) => void (await Bun.sleep(30))],
		["closed window", async (s: ReturnType<typeof setup>) => void (await Bun.sleep(5), s.removed[0]?.(501))],
	])("resolves deny on %s", async (_name, act) => {
		const s = setup({ timeoutMs: 20 });
		const pending = s.allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		await act(s);
		expect(await pending).toBe("deny");
	});

	it("resolves deny when the window cannot open", async () => {
		const { allow } = setup({ open: async () => undefined });
		expect(await allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" })).toBe("deny");
	});

	it("does not prompt again for a site already allowed in the session", async () => {
		const { allow, opened } = setup();
		const first = allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		allow.answer("id1", true);
		await first;
		expect(await allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" })).toBe("allow");
		expect(opened).toHaveLength(1);
	});

	it("shares one prompt between concurrent requests for the same site", async () => {
		const { allow, opened } = setup();
		const a = allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		const b = allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		allow.answer("id1", true);
		expect([await a, await b]).toEqual(["allow", "allow"]);
		expect(opened).toHaveLength(1);
	});

	it("denies a stopped session even after an Allow click", async () => {
		const { allow, control } = setup();
		await control.stop("s1");
		const pending = allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		allow.answer("id1", true);
		expect(await pending).toBe("deny");
	});

	it("answers nothing for an unknown or settled id", async () => {
		const { allow } = setup();
		expect(allow.show("nope")).toBeUndefined();
		const pending = allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		allow.answer("id1", true);
		await pending;
		expect(allow.show("id1")).toBeUndefined();
	});
});

describe("openSite", () => {
	it("keeps the page unloaded until the person allows", async () => {
		const { allow, loaded } = setup();
		const pending = allow.openSite({ sessionId: "s1", url: "https://www.example.com/a" });
		await Bun.sleep(5);
		expect(loaded).toEqual([]);
		expect(allow.show("id1")?.siteKey).toBe("https://example.com");
		allow.answer("id1", true);
		expect(await pending).toBe("allow");
		expect(loaded).toEqual([{ sessionId: "s1", url: "https://www.example.com/a" }]);
	});

	it("never loads the page after a deny", async () => {
		const { allow, loaded } = setup();
		const pending = allow.openSite({ sessionId: "s1", url: "https://example.com/" });
		allow.answer("id1", false);
		expect(await pending).toBe("deny");
		expect(loaded).toEqual([]);
	});

	it("loads an already allowed site without a prompt", async () => {
		const { allow, control, loaded, opened } = setup();
		await control.allow("s1", "https://example.com");
		expect(await allow.openSite({ sessionId: "s1", url: "https://example.com/b" })).toBe("allow");
		expect(opened).toEqual([]);
		expect(loaded).toHaveLength(1);
	});

	it.each(["chrome://settings", "file:///etc/passwd", "about:blank", "https://chromewebstore.google.com/"])(
		"refuses %s without a prompt",
		async (url) => {
			const { allow, loaded, opened } = setup();
			await expect(allow.openSite({ sessionId: "s1", url })).rejects.toThrow();
			expect(opened).toEqual([]);
			expect(loaded).toEqual([]);
		},
	);
});

describe("PHI sites", () => {
	async function allowWithPhi(s: ReturnType<typeof setup>, phi: boolean) {
		const pending = s.allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://ehr.example.com" });
		s.allow.answer("id1", true, phi);
		await pending;
	}

	it("refuses snapshot and screenshot on a site the person flagged as PHI", async () => {
		const s = setup();
		await allowWithPhi(s, true);
		await expect(s.allow.assertCaptureAllowed("s1", "https://app.ehr.example.com/chart")).rejects.toBeInstanceOf(
			PhiCaptureRefusedError,
		);
	});

	it("allows capture on an unflagged site and on other sessions", async () => {
		const s = setup();
		await allowWithPhi(s, true);
		await expect(s.allow.assertCaptureAllowed("s2", "https://ehr.example.com/")).resolves.toBeUndefined();
		await expect(s.allow.assertCaptureAllowed("s1", "https://other.example.org/")).resolves.toBeUndefined();
	});

	it("keeps the PHI flag off when the box stays unticked", async () => {
		const s = setup();
		await allowWithPhi(s, false);
		await expect(s.allow.assertCaptureAllowed("s1", "https://ehr.example.com/")).resolves.toBeUndefined();
	});

	it("drops the flag when the session is forgotten", async () => {
		const s = setup();
		await allowWithPhi(s, true);
		await s.allow.forget("s1");
		await expect(s.allow.assertCaptureAllowed("s1", "https://ehr.example.com/")).resolves.toBeUndefined();
	});

	it("does not store the flag on a deny", async () => {
		const s = setup();
		const pending = s.allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://ehr.example.com" });
		s.allow.answer("id1", false, true);
		await pending;
		await expect(s.allow.assertCaptureAllowed("s1", "https://ehr.example.com/")).resolves.toBeUndefined();
	});
});

describe("registerSiteAllow", () => {
	function register() {
		const s = setup();
		let listener: (m: unknown, sender: unknown, send: (r: unknown) => void) => unknown = () => undefined;
		registerSiteAllow({
			siteAllow: s.allow,
			runtime: {
				id: "dg",
				getURL: (path) => `chrome-extension://dg${path}`,
				onMessage: { addListener: (l) => void (listener = l) },
			},
		});
		const send = (message: unknown, sender: unknown) => {
			const replies: unknown[] = [];
			listener(message, sender, (r) => replies.push(r));
			return replies;
		};
		return { ...s, send };
	}
	const page = { id: "dg", url: "chrome-extension://dg/site-allow.html?id=id1" };

	it("answers a request only for the extension's own prompt page", async () => {
		const s = register();
		const pending = s.allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		expect(s.send({ type: SITE_ALLOW_MSG.answer, id: "id1", allow: true }, { id: "dg", url: "https://evil.example/" })).toEqual([
			undefined,
		]);
		expect(s.send({ type: SITE_ALLOW_MSG.answer, id: "id1", allow: true }, { id: "dg", tab: { id: 1 }, url: "https://evil.example/" })).toEqual([
			undefined,
		]);
		expect(s.allow.show("id1")).toBeDefined();
		expect(s.send({ type: SITE_ALLOW_MSG.answer, id: "id1", allow: true, phi: true }, page)).toEqual([true]);
		expect(await pending).toBe("allow");
		await expect(s.allow.assertCaptureAllowed("s1", "https://example.com/")).rejects.toBeInstanceOf(PhiCaptureRefusedError);
	});

	it("returns the request to the prompt page", () => {
		const s = register();
		void s.allow.requestSiteAllow({ sessionId: "s1", siteKey: "https://example.com" });
		expect(s.send({ type: SITE_ALLOW_MSG.get, id: "id1" }, page)).toEqual([
			{ sessionId: "s1", siteKey: "https://example.com" },
		]);
	});
});
