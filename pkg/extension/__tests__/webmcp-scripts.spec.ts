import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
	WEBMCP_MAX_SCRIPTS,
	WEBMCP_SCRIPT_MAX_BYTES,
	type WebMcpScriptRecord,
} from "@dg/common";
import {
	createWebMcpScripts,
	registerWebMcpScripts,
	userScriptsAvailable,
	WEBMCP_RECONCILE_MESSAGE,
} from "@/lib/background/webmcp-scripts";

const sha = (code: string) => createHash("sha256").update(code).digest("hex");

function memoryStorage() {
	const data: Record<string, unknown> = {};
	return {
		data,
		local: {
			get: async (keys: string | string[] | null) => {
				if (keys === null) return { ...data };
				const wanted = Array.isArray(keys) ? keys : [keys];
				return Object.fromEntries(wanted.filter((key) => key in data).map((key) => [key, data[key]]));
			},
			set: async (items: Record<string, unknown>) => void Object.assign(data, items),
			remove: async (keys: string | string[]) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
			},
		},
	};
}

function setup({ userScripts = true, failIds = [] as string[], probeFails = false } = {}) {
	const storage = memoryStorage();
	const live = { content: new Set<string>(), user: new Set<string>() };
	const calls = {
		register: [] as { id: string; [key: string]: unknown }[],
		unregister: [] as string[],
		userRegister: [] as { id: string; [key: string]: unknown }[],
		userUnregister: [] as string[],
	};
	const scripting = {
		registerContentScripts: async (scripts: { id: string }[]) => {
			for (const script of scripts) {
				if (failIds.includes(script.id)) throw new Error(`cannot register ${script.id}`);
				calls.register.push(script);
				live.content.add(script.id);
			}
		},
		unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
			for (const id of ids) {
				calls.unregister.push(id);
				live.content.delete(id);
			}
		},
		getRegisteredContentScripts: async () => [...live.content].map((id) => ({ id })),
	};
	const userScriptsApi = {
		register: async (scripts: { id: string }[]) => {
			for (const script of scripts) {
				if (failIds.includes(script.id)) throw new Error(`cannot register ${script.id}`);
				calls.userRegister.push(script);
				live.user.add(script.id);
			}
		},
		unregister: async ({ ids }: { ids: string[] }) => {
			for (const id of ids) {
				calls.userUnregister.push(id);
				live.user.delete(id);
			}
		},
		getScripts: async () => {
			if (probeFails) throw new Error("toggle off");
			return [...live.user].map((id) => ({ id }));
		},
	};
	let counter = 0;
	const make = (registrars: boolean) =>
		createWebMcpScripts({
			storage,
			scripting: registrars ? scripting : null,
			userScripts: registrars && userScripts ? () => userScriptsApi : null,
			newId: () => `s${++counter}`,
			now: () => 1000,
		});
	const scripts = make(true);
	return { storage, calls, live, scripts, make };
}

const approveNow = async (scripts: ReturnType<typeof setup>["scripts"], id: string) =>
	scripts.approve(id, (await scripts.list()).find((record) => record.id === id)?.sha256 as string);

const draft = (overrides: Partial<Parameters<ReturnType<typeof setup>["scripts"]["addThirdParty"]>[0]> = {}) => ({
	name: "Flights",
	matches: ["https://flights.example.com/*"],
	code: "registerDgTool({});",
	...overrides,
});

async function stored(storage: ReturnType<typeof memoryStorage>): Promise<WebMcpScriptRecord[]> {
	return (storage.data.webmcpScripts ?? []) as WebMcpScriptRecord[];
}

describe("addThirdParty", () => {
	it("stores a disabled unapproved record with its code and registers nothing", async () => {
		const { scripts, storage, calls } = setup();

		const record = await scripts.addThirdParty(draft());

		expect(record).toMatchObject({ id: "s1", name: "Flights", source: "paste", enabled: false });
		expect(record.approvedAt).toBeUndefined();
		expect(record.sha256).toBe(sha("registerDgTool({});"));
		expect(storage.data["webmcpScriptCode:s1"]).toBe("registerDgTool({});");
		expect(calls.register).toEqual([]);
		expect(calls.userRegister).toEqual([]);
	});

	it("rejects code over the byte limit, naming it", async () => {
		const { scripts } = setup();

		await expect(
			scripts.addThirdParty(draft({ code: "a".repeat(WEBMCP_SCRIPT_MAX_BYTES + 1) })),
		).rejects.toThrow(String(WEBMCP_SCRIPT_MAX_BYTES));
	});

	it("accepts code exactly at the byte limit", async () => {
		const { scripts } = setup();

		await scripts.addThirdParty(draft({ code: "a".repeat(WEBMCP_SCRIPT_MAX_BYTES) }));
	});

	it("rejects the script past the script limit, naming it", async () => {
		const { scripts } = setup();
		for (let index = 0; index < WEBMCP_MAX_SCRIPTS; index++) await scripts.addThirdParty(draft());

		await expect(scripts.addThirdParty(draft())).rejects.toThrow(String(WEBMCP_MAX_SCRIPTS));
	});

	it("rejects <all_urls> and http match patterns", async () => {
		const { scripts, storage } = setup();

		await expect(scripts.addThirdParty(draft({ matches: ["<all_urls>"] }))).rejects.toThrow("match pattern");
		await expect(scripts.addThirdParty(draft({ matches: ["http://x/*"] }))).rejects.toThrow("match pattern");
		expect(await stored(storage)).toEqual([]);
	});
});

describe("approve", () => {
	it("stores the code hash and approval time, enables the script and registers it through userScripts", async () => {
		const { scripts, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());

		await approveNow(scripts, id);

		const record = (await scripts.list()).find((entry) => entry.id === id);
		expect(record).toMatchObject({ enabled: true, approvedAt: 1000, sha256: sha("registerDgTool({});") });
		expect(calls.userRegister).toEqual([
			{
				id: `dg-webmcp-user-${id}`,
				js: [{ file: "webmcp-shim.js" }, { code: "registerDgTool({});" }],
				matches: ["https://flights.example.com/*"],
				world: "MAIN",
				runAt: "document_idle",
			},
		]);
	});

	it("rejects an unknown id", async () => {
		const { scripts } = setup();

		await expect(scripts.approve("missing", sha("x"))).rejects.toThrow("missing");
	});
});

describe("replaceCode", () => {
	it("clears the approval, stores the new hash and unregisters the script", async () => {
		const { scripts, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);

		await scripts.replaceCode(id, "other();");

		const record = (await scripts.list()).find((entry) => entry.id === id);
		expect(record?.approvedAt).toBeUndefined();
		expect(record?.sha256).toBe(sha("other();"));
		expect(calls.userUnregister).toContain(`dg-webmcp-user-${id}`);
		expect(calls.userRegister).toHaveLength(1);
	});

	it("rejects code over the byte limit and keeps the old code", async () => {
		const { scripts, storage } = setup();
		const { id } = await scripts.addThirdParty(draft());

		await expect(scripts.replaceCode(id, "a".repeat(WEBMCP_SCRIPT_MAX_BYTES + 1))).rejects.toThrow(
			String(WEBMCP_SCRIPT_MAX_BYTES),
		);
		expect(storage.data[`webmcpScriptCode:${id}`]).toBe("registerDgTool({});");
	});
});

describe("setEnabled", () => {
	it("unregisters an approved script when disabled and registers it again when enabled", async () => {
		const { scripts, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);

		await scripts.setEnabled(id, false);
		expect(calls.userUnregister.at(-1)).toBe(`dg-webmcp-user-${id}`);
		const registered = calls.userRegister.length;

		await scripts.setEnabled(id, true);
		expect(calls.userRegister).toHaveLength(registered + 1);
	});

	it("never registers an unapproved script even when enabled", async () => {
		const { scripts, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());

		await scripts.setEnabled(id, true);

		expect(calls.userRegister).toEqual([]);
	});
});

describe("remove", () => {
	it("deletes the record and code and unregisters the script", async () => {
		const { scripts, storage, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);

		await scripts.remove(id);

		expect((await scripts.list()).some((entry) => entry.id === id)).toBe(false);
		expect(`webmcpScriptCode:${id}` in storage.data).toBe(false);
		expect(calls.userUnregister).toContain(`dg-webmcp-user-${id}`);
	});

	it("refuses to remove a built-in", async () => {
		const { scripts } = setup();

		await expect(scripts.remove("outlook")).rejects.toThrow("cannot be removed");
		expect((await scripts.list()).some((entry) => entry.id === "outlook")).toBe(true);
	});
});

describe("list", () => {
	it("returns the outlook built-in enabled by default ahead of third-party scripts", async () => {
		const { scripts } = setup();
		await scripts.addThirdParty(draft());

		const records = await scripts.list();

		expect(records.map((record) => [record.id, record.source, record.enabled])).toEqual([
			["outlook", "built-in", true],
			["s1", "paste", false],
		]);
	});

	it("drops stored records that fail validation", async () => {
		const { scripts, storage } = setup();
		storage.data.webmcpScripts = [{ id: "Bad Id" }];

		expect((await scripts.list()).map((record) => record.id)).toEqual(["outlook"]);
	});
});

describe("reconcile", () => {
	it("registers the enabled outlook built-in in the MAIN world at document_start", async () => {
		const { scripts, calls } = setup();

		await scripts.reconcile();

		expect(calls.register).toEqual([
			{
				id: "dg-webmcp-outlook",
				js: ["content-scripts/webmcp-outlook-main.js"],
				matches: ["https://outlook.office.com/*", "https://outlook.live.com/*"],
				world: "MAIN",
				runAt: "document_start",
			},
		]);
	});

	it("unregisters the outlook built-in when it is disabled", async () => {
		const { scripts, calls } = setup();
		await scripts.reconcile();

		await scripts.setEnabled("outlook", false);

		expect(calls.unregister).toContain("dg-webmcp-outlook");
		expect(calls.register).toHaveLength(1);
	});

	it("skips an approved script whose stored code no longer matches its hash and clears the approval", async () => {
		const { scripts, storage, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);
		calls.userRegister.length = 0;
		storage.data[`webmcpScriptCode:${id}`] = "tampered();";

		await scripts.reconcile();

		expect(calls.userRegister).toEqual([]);
		expect(calls.userUnregister).toContain(`dg-webmcp-user-${id}`);
		const record = (await stored(storage)).find((entry) => entry.id === id);
		expect(record?.approvedAt).toBeUndefined();
	});

	it("skips an approved script whose code is missing", async () => {
		const { scripts, storage, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);
		calls.userRegister.length = 0;
		delete storage.data[`webmcpScriptCode:${id}`];

		await scripts.reconcile();

		expect(calls.userRegister).toEqual([]);
	});

	it("registers built-ins and skips third-party scripts without throwing when userScripts is unavailable", async () => {
		const { scripts, calls } = setup({ userScripts: false });
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);

		await scripts.reconcile();

		expect(new Set(calls.register.map((script) => script.id))).toEqual(new Set(["dg-webmcp-outlook"]));
		expect(calls.userRegister).toEqual([]);
	});

	it("keeps registering the other scripts when one registration fails", async () => {
		const { scripts, calls } = setup({ failIds: ["dg-webmcp-outlook"] });
		const { id } = await scripts.addThirdParty(draft());

		await approveNow(scripts, id);
		await scripts.reconcile();

		expect(calls.userRegister.map((script) => script.id)).toContain(`dg-webmcp-user-${id}`);
	});

	it("stores the approval without registering anything when both registrars are null", async () => {
		const storage = memoryStorage();
		const scripts = createWebMcpScripts({ storage, scripting: null, userScripts: null, newId: () => "x" });

		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);
		await scripts.reconcile();

		expect((await scripts.list()).find((record) => record.id === id)?.approvedAt).toBeDefined();
	});
});

describe("approve guards", () => {
	it("refuses when the stored code no longer matches the hash the person reviewed", async () => {
		const { scripts, storage, calls } = setup();
		const { id, sha256 } = await scripts.addThirdParty(draft());
		storage.data[`webmcpScriptCode:${id}`] = "swapped();";

		await expect(scripts.approve(id, sha256)).rejects.toThrow("Script code changed; review it again.");
		expect(calls.userRegister).toEqual([]);
	});

	it("refuses when the reviewed hash differs from the stored one", async () => {
		const { scripts, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());

		await expect(scripts.approve(id, sha("something else"))).rejects.toThrow("Script code changed; review it again.");
		expect(calls.userRegister).toEqual([]);
	});

	it("rechecks the code size", async () => {
		const { scripts, storage } = setup();
		const { id } = await scripts.addThirdParty(draft());
		const big = "a".repeat(WEBMCP_SCRIPT_MAX_BYTES + 1);
		storage.data[`webmcpScriptCode:${id}`] = big;

		await expect(scripts.approve(id, sha(big))).rejects.toThrow(String(WEBMCP_SCRIPT_MAX_BYTES));
	});
});

describe("approval pinning", () => {
	it("stores a digest of the code and the sites under webmcpApproval:<id>", async () => {
		const { scripts, storage } = setup();
		const { id } = await scripts.addThirdParty(draft());

		await approveNow(scripts, id);

		expect(storage.data[`webmcpApproval:${id}`]).toBe(
			sha(`registerDgTool({});\n${JSON.stringify(["https://flights.example.com/*"])}`),
		);
	});

	it("stops the script and clears the approval when the sites are edited in storage", async () => {
		const { scripts, storage, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);
		calls.userRegister.length = 0;
		const records = storage.data.webmcpScripts as WebMcpScriptRecord[];
		storage.data.webmcpScripts = records.map((record) =>
			record.id === id ? { ...record, matches: ["https://bank.example.com/*"] } : record,
		);

		await scripts.reconcile();

		expect(calls.userRegister).toEqual([]);
		expect(calls.userUnregister).toContain(`dg-webmcp-user-${id}`);
		expect((await stored(storage)).find((record) => record.id === id)?.approvedAt).toBeUndefined();
	});

	it("stops the script when the approval digest is missing", async () => {
		const { scripts, storage, calls } = setup();
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);
		calls.userRegister.length = 0;
		delete storage.data[`webmcpApproval:${id}`];

		await scripts.reconcile();

		expect(calls.userRegister).toEqual([]);
	});

	it("deletes the digest on remove and on replaceCode", async () => {
		const { scripts, storage } = setup();
		const first = await scripts.addThirdParty(draft());
		const second = await scripts.addThirdParty(draft());
		await approveNow(scripts, first.id);
		await approveNow(scripts, second.id);

		await scripts.remove(first.id);
		await scripts.replaceCode(second.id, "next();");

		expect(`webmcpApproval:${first.id}` in storage.data).toBe(false);
		expect(`webmcpApproval:${second.id}` in storage.data).toBe(false);
	});
});

describe("orphan registrations", () => {
	it("lets a background reconcile unregister a script an options-style instance removed", async () => {
		const { make, calls, live } = setup();
		const background = make(true);
		const options = make(false);
		const { id } = await background.addThirdParty(draft());
		await approveNow(background, id);
		expect(live.user.has(`dg-webmcp-user-${id}`)).toBe(true);

		await options.remove(id);
		expect(live.user.has(`dg-webmcp-user-${id}`)).toBe(true);
		await background.reconcile();

		expect(calls.userUnregister).toContain(`dg-webmcp-user-${id}`);
		expect(live.user.size).toBe(0);
	});

	it("unregisters a live built-in id that is no longer wanted", async () => {
		const { scripts, live, calls } = setup();
		live.content.add("dg-webmcp-gone");

		await scripts.reconcile();

		expect(calls.unregister).toContain("dg-webmcp-gone");
		expect(live.content.has("dg-webmcp-outlook")).toBe(true);
	});

	it("leaves registrations from other owners alone", async () => {
		const { scripts, live } = setup();
		live.content.add("other-extension-script");
		live.user.add("someone-else");

		await scripts.reconcile();

		expect(live.content.has("other-extension-script")).toBe(true);
		expect(live.user.has("someone-else")).toBe(true);
	});
});

describe("built-in spoofing", () => {
	it("never registers or lists a stored record that claims built-in with an unknown id", async () => {
		const { scripts, storage, calls } = setup();
		storage.data.webmcpScripts = [
			{
				id: "foo",
				name: "Foo",
				matches: ["https://foo.example.com/*"],
				sha256: "0".repeat(64),
				source: "built-in",
				enabled: true,
			},
		];

		await scripts.reconcile();

		expect(calls.register.map((script) => script.id)).toEqual(["dg-webmcp-outlook"]);
		expect((await scripts.list()).map((record) => record.id)).toEqual(["outlook"]);
	});

	it("drops a stored record that uses the outlook id as a paste script", async () => {
		const { scripts, storage } = setup();
		storage.data.webmcpScripts = [
			{
				id: "outlook",
				name: "Fake",
				matches: ["https://evil.example.com/*"],
				sha256: "0".repeat(64),
				source: "paste",
				enabled: true,
			},
		];

		const [outlook, ...rest] = await scripts.list();

		expect(outlook?.matches).toContain("https://outlook.live.com/*");
		expect(rest).toEqual([]);
	});

	it("rejects adding a script with the built-in source", async () => {
		const { scripts } = setup();

		await expect(scripts.addThirdParty(draft({ source: "built-in" as never }))).rejects.toThrow("source");
	});
});

describe("reconcile writes", () => {
	it("writes nothing when no approval needs clearing", async () => {
		const { scripts, storage } = setup();
		const { id } = await scripts.addThirdParty(draft());
		await approveNow(scripts, id);
		let writes = 0;
		const set = storage.local.set;
		storage.local.set = async (items) => {
			writes++;
			return set(items);
		};

		await scripts.reconcile();

		expect(writes).toBe(0);
	});

	it("clears only approvedAt and keeps a concurrent change to another record", async () => {
		const { scripts, storage } = setup();
		const first = await scripts.addThirdParty(draft());
		const second = await scripts.addThirdParty(draft({ name: "Second" }));
		await approveNow(scripts, first.id);
		await approveNow(scripts, second.id);
		storage.data[`webmcpScriptCode:${first.id}`] = "tampered();";
		const get = storage.local.get;
		let raced = false;
		storage.local.get = async (keys) => {
			const result = await get(keys);
			if (!raced && keys === `webmcpScriptCode:${first.id}`) {
				raced = true;
				storage.data.webmcpScripts = (storage.data.webmcpScripts as WebMcpScriptRecord[]).map((record) =>
					record.id === second.id ? { ...record, enabled: false } : record,
				);
			}
			return result;
		};

		await scripts.reconcile();

		const records = await stored(storage);
		expect(records.find((record) => record.id === first.id)?.approvedAt).toBeUndefined();
		expect(records.find((record) => record.id === second.id)?.enabled).toBe(false);
		expect(records.find((record) => record.id === second.id)?.approvedAt).toBe(1000);
	});
});

describe("reconcile userScripts probe", () => {
	it("skips third-party scripts without throwing when getScripts throws", async () => {
		const { scripts, calls } = setup({ probeFails: true });
		const { id } = await scripts.addThirdParty(draft());

		await approveNow(scripts, id);
		await scripts.reconcile();

		expect(calls.userRegister).toEqual([]);
		expect(calls.register.map((script) => script.id)).toContain("dg-webmcp-outlook");
	});
});

describe("serialized mutations", () => {
	it("keeps both writes when two setEnabled calls overlap", async () => {
		const { scripts } = setup();
		const first = await scripts.addThirdParty(draft());
		const second = await scripts.addThirdParty(draft({ name: "Second" }));
		await approveNow(scripts, first.id);
		await approveNow(scripts, second.id);

		await Promise.all([scripts.setEnabled(first.id, false), scripts.setEnabled(second.id, false)]);

		const records = await scripts.list();
		expect(records.find((record) => record.id === first.id)?.enabled).toBe(false);
		expect(records.find((record) => record.id === second.id)?.enabled).toBe(false);
	});

	it("keeps both results when an add overlaps a remove", async () => {
		const { scripts } = setup();
		const first = await scripts.addThirdParty(draft());

		const [added] = await Promise.all([scripts.addThirdParty(draft({ name: "Second" })), scripts.remove(first.id)]);

		expect((await scripts.list()).map((record) => record.id)).toEqual(["outlook", added.id]);
	});

	it("keeps rejecting for the caller while later calls still run", async () => {
		const { scripts } = setup();

		const results = await Promise.allSettled([scripts.remove("outlook"), scripts.addThirdParty(draft())]);

		expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
	});
});

describe("lazy userScripts", () => {
	function lazy() {
		const registered: string[] = [];
		const api = {
			register: async (scripts: { id: string }[]) => void registered.push(...scripts.map((script) => script.id)),
			unregister: async () => undefined,
			getScripts: async () => [] as { id: string }[],
		};
		let available = false;
		const storage = memoryStorage();
		const scripts = createWebMcpScripts({
			storage,
			scripting: null,
			userScripts: () => (available ? api : undefined),
			newId: () => "s1",
			now: () => 1000,
		});
		return { scripts, registered, turnOn: () => void (available = true) };
	}

	it("registers an approved script on a later reconcile once the toggle is on", async () => {
		const { scripts, registered, turnOn } = lazy();
		const { id, sha256 } = await scripts.addThirdParty(draft());
		await scripts.approve(id, sha256);
		expect(registered).toEqual([]);

		turnOn();
		await scripts.reconcile();

		expect(registered).toEqual([`dg-webmcp-user-${id}`]);
	});

	it("warns once naming the toggle when approved scripts cannot be registered", async () => {
		const { scripts } = lazy();
		const { id, sha256 } = await scripts.addThirdParty(draft());
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await scripts.approve(id, sha256);
			warn.mockClear();
			await scripts.reconcile();

			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.join(" "))).toContain("Allow User Scripts");
		} finally {
			warn.mockRestore();
		}
	});

	it("does not warn when no third-party script is approved", async () => {
		const { scripts } = lazy();
		await scripts.addThirdParty(draft());
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await scripts.reconcile();

			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("userScriptsAvailable", () => {
	it("is false when reading chrome.userScripts throws", () => {
		const api = {
			get userScripts(): never {
				throw new Error("no toggle");
			},
		};

		expect(userScriptsAvailable({ isChromium: () => true, chromeApi: api })).toBe(false);
	});

	it("is false when the API is absent and true when getScripts answers", () => {
		expect(userScriptsAvailable({ isChromium: () => true, chromeApi: {} })).toBe(false);
		expect(
			userScriptsAvailable({ isChromium: () => true, chromeApi: { userScripts: { getScripts: () => [] } } }),
		).toBe(true);
	});

	it("is false when getScripts throws", () => {
		const api = {
			userScripts: {
				getScripts: () => {
					throw new Error("toggle off");
				},
			},
		};

		expect(userScriptsAvailable({ isChromium: () => true, chromeApi: api })).toBe(false);
	});

	it("never reads the API in a non-Chromium build", () => {
		let read = false;
		const api = {
			get userScripts() {
				read = true;
				return { getScripts: () => [] };
			},
		};

		expect(userScriptsAvailable({ isChromium: () => false, chromeApi: api })).toBe(false);
		expect(read).toBe(false);
	});
});

describe("registerWebMcpScripts", () => {
	const OPTIONS_URL = "chrome-extension://abc/options.html";

	function boot() {
		const listeners = {
			installed: [] as (() => void)[],
			startup: [] as (() => void)[],
			message: [] as ((message: unknown, sender: { id?: string; url?: string }, reply: (value?: unknown) => void) => unknown)[],
		};
		let reconciles = 0;
		registerWebMcpScripts({
			api: {
				runtime: {
					id: "abc",
					getURL: (path: string) => `chrome-extension://abc${path}`,
					onInstalled: { addListener: (listener) => void listeners.installed.push(listener) },
					onStartup: { addListener: (listener) => void listeners.startup.push(listener) },
					onMessage: { addListener: (listener) => void listeners.message.push(listener) },
				},
			},
			scripts: { reconcile: async () => void reconciles++ },
		});
		const send = (sender: { id?: string; url?: string }, message: unknown = { type: WEBMCP_RECONCILE_MESSAGE }) => {
			let reply: unknown = "unset";
			for (const listener of listeners.message) listener(message, sender, (value) => (reply = value));
			return reply;
		};
		return { listeners, send, reconciles: () => reconciles };
	}

	it("reconciles on install and on startup", () => {
		const { listeners, reconciles } = boot();

		listeners.installed[0]?.();
		listeners.startup[0]?.();

		expect(reconciles()).toBe(2);
	});

	it("reconciles on a message from the options page, ignoring any query or hash", () => {
		const { send, reconciles } = boot();

		send({ id: "abc", url: `${OPTIONS_URL}?x=1#top` });

		expect(reconciles()).toBe(1);
	});

	it("ignores the message from a content script that shares the extension id", () => {
		const { send, reconciles } = boot();

		send({ id: "abc", url: "https://evil.example.com/page" });

		expect(reconciles()).toBe(0);
	});

	it("ignores the message from another extension and from a sender without a url", () => {
		const { send, reconciles } = boot();

		send({ id: "other", url: OPTIONS_URL });
		send({ id: "abc" });

		expect(reconciles()).toBe(0);
	});

	it("ignores unrelated messages", () => {
		const { send, reconciles } = boot();

		send({ id: "abc", url: OPTIONS_URL }, { type: "dg-approval:get" });
		send({ id: "abc", url: OPTIONS_URL }, null);

		expect(reconciles()).toBe(0);
	});
});
