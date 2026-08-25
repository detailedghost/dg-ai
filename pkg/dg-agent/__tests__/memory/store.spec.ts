import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import { CHAT_MAX_MESSAGE_BODY_BYTES } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { cleanupDgHome, freshDgHome } from "@dg/dg-daemon/test-harness";
import {
	MEMORY_DEFAULT_KIND,
	MEMORY_MAX_PAGE_SIZE,
	MEMORY_PAGE_SIZE,
	MemoryStore,
	toMatchExpression,
} from "../../src/memory/store";

let dgHome: string;
let paths: DgPaths;
let clock: Date;
let store: MemoryStore;

function open(): MemoryStore {
	return MemoryStore.open(paths, { now: () => clock });
}

function tick(days: number): void {
	clock = new Date(clock.getTime() + days * 86_400_000);
}

beforeEach(() => {
	dgHome = freshDgHome();
	paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	clock = new Date("2026-03-01T00:00:00.000Z");
	store = open();
});

afterEach(() => {
	store.close();
	cleanupDgHome(dgHome);
});

describe("MemoryStore.open", () => {
	it("puts the database in the agents tree, not the daemon tree", () => {
		expect(statSync(paths.memoryDbPath).isFile()).toBe(true);
		expect(paths.memoryDbPath.startsWith(paths.agentsDir)).toBe(true);
	});

	it("creates the agents directory private to the owner", () => {
		expect(statSync(paths.agentsDir).mode & 0o777).toBe(0o700);
	});

	it("leaves no pre-migration snapshot beside a database that had nothing to lose", () => {
		const snapshots = Array.from(
			new Bun.Glob("pre-migration-*.db").scanSync(paths.agentsDir),
		);
		expect(snapshots).toEqual([]);
	});
});

describe("write", () => {
	it("records the title, the body and both timestamps", () => {
		const record = store.write({
			agentIdentity: "alpha",
			title: "port bind race",
			body: "the harness raced itself for a port",
		});

		expect(record.title).toBe("port bind race");
		expect(record.body).toBe("the harness raced itself for a port");
		expect(record.kind).toBe(MEMORY_DEFAULT_KIND);
		expect(record.workset).toBeUndefined();
		expect(record.createdAt).toBe("2026-03-01T00:00:00.000Z");
		expect(record.updatedAt).toBe(record.createdAt);
	});

	it("updates a memory the agent already wrote under that title in place", () => {
		const first = store.write({
			agentIdentity: "alpha",
			title: "port bind race",
			body: "narrow buckets",
		});
		tick(2);
		const second = store.write({
			agentIdentity: "alpha",
			title: "port bind race",
			body: "widened the buckets",
		});

		expect(second.id).toBe(first.id);
		expect(second.body).toBe("widened the buckets");
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.updatedAt).toBe("2026-03-03T00:00:00.000Z");
		expect(store.search({ agentIdentity: "alpha" })).toHaveLength(1);
	});

	it("keeps a kind the caller set when a later write only changes the body", () => {
		store.write({
			agentIdentity: "alpha",
			title: "deploy steps",
			body: "old",
			kind: "decision",
		});
		const rewritten = store.write({
			agentIdentity: "alpha",
			title: "deploy steps",
			body: "new",
		});

		expect(rewritten.kind).toBe("decision");
		expect(rewritten.body).toBe("new");
	});

	it("replaces a kind the caller does set", () => {
		store.write({
			agentIdentity: "alpha",
			title: "deploy steps",
			body: "old",
			kind: "decision",
		});
		const rewritten = store.write({
			agentIdentity: "alpha",
			title: "deploy steps",
			body: "new",
			kind: "note",
		});

		expect(rewritten.kind).toBe("note");
	});

	it("treats a blank workset or kind as none at all", () => {
		const record = store.write({
			agentIdentity: "alpha",
			title: "one",
			body: "body",
			workset: "   ",
			kind: "  ",
		});

		expect(record.workset).toBeUndefined();
		expect(record.kind).toBe(MEMORY_DEFAULT_KIND);
	});

	it("keeps the same title in another workset apart", () => {
		const bare = store.write({
			agentIdentity: "alpha",
			title: "deploy steps",
			body: "no workset",
		});
		const scoped = store.write({
			agentIdentity: "alpha",
			workset: "dg",
			title: "deploy steps",
			body: "workset dg",
		});

		expect(scoped.id).not.toBe(bare.id);
		expect(store.search({ agentIdentity: "alpha" })).toHaveLength(2);
	});

	it("refuses a body past the message body cap the rest of the protocol uses", () => {
		expect(() =>
			store.write({
				agentIdentity: "alpha",
				title: "huge",
				body: "x".repeat(CHAT_MAX_MESSAGE_BODY_BYTES + 1),
			}),
		).toThrow("exceeds CHAT_MAX_MESSAGE_BODY_BYTES");
	});

	it("keeps one agent's memory out of another agent's", () => {
		store.write({ agentIdentity: "alpha", title: "shared", body: "mine" });
		store.write({ agentIdentity: "beta", title: "shared", body: "theirs" });

		expect(store.search({ agentIdentity: "alpha" }).map((m) => m.body)).toEqual(
			["mine"],
		);
	});
});

describe("search", () => {
	beforeEach(() => {
		store.write({
			agentIdentity: "alpha",
			title: "port bind race",
			body: "the harness raced itself",
		});
		tick(1);
		store.write({
			agentIdentity: "alpha",
			workset: "dg",
			title: "asset crypto",
			body: "base64 tax on every port",
		});
		tick(1);
		store.write({
			agentIdentity: "beta",
			title: "idle window",
			body: "the daemon stops after a day",
		});
	});

	it("ranks a title match above a body match", () => {
		expect(store.search({ query: "port" }).map((m) => m.title)).toEqual([
			"port bind race",
			"asset crypto",
		]);
	});

	it("keeps a title match above a body that only repeats the term", () => {
		store.write({
			agentIdentity: "alpha",
			title: "unrelated",
			body: "port port port port port port port port port",
		});

		expect(store.search({ query: "port" })[0].title).toBe("port bind race");
	});

	it("finds a term that only appears in the body", () => {
		expect(store.search({ query: "base64" }).map((m) => m.title)).toEqual([
			"asset crypto",
		]);
	});

	it("requires every term, so two words narrow the result", () => {
		expect(store.search({ query: "port harness" }).map((m) => m.title)).toEqual(
			["port bind race"],
		);
	});

	it("scopes a ranked search to one agent", () => {
		expect(
			store.search({ query: "daemon", agentIdentity: "alpha" }),
		).toHaveLength(0);
		expect(
			store.search({ query: "daemon", agentIdentity: "beta" }),
		).toHaveLength(1);
	});

	it("scopes a ranked search to one workset", () => {
		expect(
			store.search({ query: "port", workset: "dg" }).map((m) => m.title),
		).toEqual(["asset crypto"]);
	});

	it("lists the newest first when there is no query", () => {
		expect(store.search().map((m) => m.title)).toEqual([
			"idle window",
			"asset crypto",
			"port bind race",
		]);
	});

	it("scopes a query-less listing to one agent", () => {
		expect(store.search({ agentIdentity: "beta" }).map((m) => m.title)).toEqual(
			["idle window"],
		);
	});

	it("scopes a query-less listing to one workset", () => {
		expect(store.search({ workset: "dg" }).map((m) => m.title)).toEqual([
			"asset crypto",
		]);
	});

	it("treats whitespace as no query at all", () => {
		expect(store.search({ query: "   " })).toHaveLength(3);
	});

	it("finds nothing for a query with no searchable term in it", () => {
		expect(store.search({ query: "???" })).toEqual([]);
	});

	it("survives every FTS5 operator a user could type", () => {
		for (const query of [
			'"',
			'port"',
			"NEAR(port",
			"port*",
			"a OR",
			"^(",
			"-",
		]) {
			expect(() => store.search({ query })).not.toThrow();
		}
	});

	it("pages, so a large memory does not arrive all at once", () => {
		expect(store.search({ limit: 2 }).map((m) => m.title)).toEqual([
			"idle window",
			"asset crypto",
		]);
		expect(store.search({ limit: 2, offset: 2 }).map((m) => m.title)).toEqual([
			"port bind race",
		]);
	});

	it("caps the page, so no caller can ask for the whole table", () => {
		for (let index = 0; index < MEMORY_MAX_PAGE_SIZE + 5; index += 1) {
			tick(1);
			store.write({
				agentIdentity: "gamma",
				title: `note ${index}`,
				body: "filler",
			});
		}

		expect(store.search({ agentIdentity: "gamma" })).toHaveLength(
			MEMORY_PAGE_SIZE,
		);
		expect(
			store.search({
				agentIdentity: "gamma",
				limit: MEMORY_MAX_PAGE_SIZE * 10,
			}),
		).toHaveLength(MEMORY_MAX_PAGE_SIZE);
		expect(store.search({ agentIdentity: "gamma", limit: 0 })).toHaveLength(0);
	});

	it("stops matching the body an update replaced", () => {
		tick(1);
		store.write({
			agentIdentity: "alpha",
			title: "port bind race",
			body: "widened the buckets",
		});

		expect(store.search({ query: "harness" })).toEqual([]);
		expect(store.search({ query: "widened" }).map((m) => m.title)).toEqual([
			"port bind race",
		]);
	});
});

describe("read, forget and persistence", () => {
	it("reads one memory back by id and nothing for an unknown id", () => {
		const written = store.write({
			agentIdentity: "alpha",
			title: "one",
			body: "body",
		});

		expect(store.read(written.id)?.body).toBe("body");
		expect(store.read("no-such-id")).toBeUndefined();
	});

	it("forgets a memory, and says so only when there was one to forget", () => {
		const written = store.write({
			agentIdentity: "alpha",
			title: "one",
			body: "body",
		});

		expect(store.forget(written.id)).toBe(true);
		expect(store.forget(written.id)).toBe(false);
		expect(store.read(written.id)).toBeUndefined();
	});

	it("drops a forgotten memory out of search too", () => {
		const written = store.write({
			agentIdentity: "alpha",
			title: "port bind race",
			body: "the harness raced itself",
		});
		store.forget(written.id);

		expect(store.search({ query: "harness" })).toEqual([]);
	});

	it("does not hand a new memory the search terms of the one it replaced", () => {
		const first = store.write({
			agentIdentity: "alpha",
			title: "port bind race",
			body: "the harness raced itself",
		});
		store.forget(first.id);
		store.write({
			agentIdentity: "alpha",
			title: "idle window",
			body: "the daemon stops after a day",
		});

		expect(store.search({ query: "harness" })).toEqual([]);
	});

	it("keeps memories across a reopen, with no daemon involved", () => {
		store.write({
			agentIdentity: "alpha",
			title: "port bind race",
			body: "the harness raced itself",
		});
		store.close();
		store = open();

		expect(store.search({ query: "harness" }).map((m) => m.title)).toEqual([
			"port bind race",
		]);
	});
});

describe("toMatchExpression", () => {
	it("quotes each term and requires all of them", () => {
		expect(toMatchExpression("port bind race")).toBe(
			'"port" AND "bind" AND "race"',
		);
	});

	it("drops the punctuation an FTS5 parser would choke on", () => {
		expect(toMatchExpression('NEAR(port* OR "bind")')).toBe(
			'"NEAR" AND "port" AND "OR" AND "bind"',
		);
	});

	it("has nothing to match when the query carries no term", () => {
		expect(toMatchExpression("?!*")).toBeUndefined();
	});
});
