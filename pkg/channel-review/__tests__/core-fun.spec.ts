import { describe, expect, test } from "bun:test";
import {
	FUN_VERDICTS,
	type FunEntry,
	decorateReply,
	filterVerifiedFun,
	funVerdictFor,
	loadFunPool,
	pickFun,
} from "../src/fun";
import {
	completeFunPool,
	createRecordedLog,
	emojiEntry,
	gifEntry,
} from "./support/fakes";

const kindsOf = (pool: FunEntry[], verdict: string): string[] =>
	pool.filter((entry) => entry.verdict === verdict).map((entry) => entry.kind);

describe("loadFunPool shipped file", () => {
	const shipped = loadFunPool();

	test("returns exactly 50 entries", () => {
		expect(shipped).toHaveLength(50);
	});

	test.each([...FUN_VERDICTS])("has at least one gif and one emoji entry for %s", (verdict) => {
		expect(kindsOf(shipped, verdict)).toContain("gif");
		expect(kindsOf(shipped, verdict)).toContain("emoji");
	});

	test("uses unique https gif urls", () => {
		const urls = shipped.flatMap((entry) =>
			entry.kind === "gif" ? [entry.url] : [],
		);
		expect(new Set(urls).size).toBe(urls.length);
		for (const url of urls) expect(url.startsWith("https://")).toBe(true);
	});

	test("gives every emoji entry a reaction id and non-empty text", () => {
		for (const entry of shipped) {
			if (entry.kind === "emoji") {
				expect(entry.reactionId.length).toBeGreaterThan(0);
				expect(entry.text.trim().length).toBeGreaterThan(0);
			}
		}
	});
});

describe("loadFunPool override", () => {
	test("returns a valid override as given and skips the 50-entry rule", () => {
		const pool = completeFunPool();
		expect(loadFunPool(pool)).toEqual(pool);
		expect(pool).not.toHaveLength(50);
	});

	test("rejects a non-https gif url", () => {
		const pool = [
			...completeFunPool().filter((e) => !(e.verdict === "approved" && e.kind === "gif")),
			{ ...gifEntry("approved"), url: "http://img.example.com/a.gif" },
		];
		expect(() => loadFunPool(pool)).toThrow();
	});

	test("rejects a duplicate gif url", () => {
		const existing = gifEntry("approved") as Extract<FunEntry, { kind: "gif" }>;
		const pool = [...completeFunPool(), { ...gifEntry("failed", 2), url: existing.url }];
		expect(() => loadFunPool(pool)).toThrow();
	});

	test.each([...FUN_VERDICTS])("rejects a pool with no entry for %s", (verdict) => {
		const pool = completeFunPool().filter((entry) => entry.verdict !== verdict);
		expect(() => loadFunPool(pool)).toThrow();
	});

	test.each(["gif", "emoji"] as const)(
		"rejects a verdict that has no %s entry",
		(kind) => {
			const pool = completeFunPool().filter(
				(entry) => !(entry.verdict === "comment" && entry.kind === kind),
			);
			expect(() => loadFunPool(pool)).toThrow();
		},
	);

	test("rejects an emoji entry with empty text", () => {
		const pool = [
			...completeFunPool().filter((e) => !(e.verdict === "approved" && e.kind === "emoji")),
			{ ...emojiEntry("approved"), text: "" },
		];
		expect(() => loadFunPool(pool)).toThrow();
	});
});

describe("filterVerifiedFun", () => {
	test("drops an emoji entry whose reaction id is unknown and keeps the rest", () => {
		const pool = [...completeFunPool(), emojiEntry("approved", 2)];
		const known = pool.flatMap((e) =>
			e.kind === "emoji" && e.reactionId !== "approved2_reaction"
				? [e.reactionId]
				: [],
		);
		const log = createRecordedLog();
		const filtered = filterVerifiedFun(pool, known, log);
		expect(filtered).toHaveLength(pool.length - 1);
		expect(
			filtered.some(
				(e) => e.kind === "emoji" && e.reactionId === "approved2_reaction",
			),
		).toBe(false);
	});

	test("never drops a gif entry", () => {
		const pool = completeFunPool();
		const filtered = filterVerifiedFun(pool, [], createRecordedLog());
		expect(filtered.filter((e) => e.kind === "gif")).toHaveLength(
			pool.filter((e) => e.kind === "gif").length,
		);
		expect(filtered.some((e) => e.kind === "emoji")).toBe(false);
	});

	test("logs each drop with the reaction id", () => {
		const log = createRecordedLog();
		filterVerifiedFun(
			[...completeFunPool(), emojiEntry("approved", 2)],
			["approved1_reaction", "changes1_reaction", "comment1_reaction", "failed1_reaction"],
			log,
		);
		expect(log.lines.some((l) => l.message.includes("approved2_reaction"))).toBe(
			true,
		);
	});

	test("logs a warning when a verdict loses its last emoji entry", () => {
		const log = createRecordedLog();
		filterVerifiedFun(
			completeFunPool(),
			["changes1_reaction", "comment1_reaction", "failed1_reaction"],
			log,
		);
		expect(log.lines.some((l) => l.level === "warn")).toBe(true);
	});

	test("logs no warning when every verdict keeps an emoji entry", () => {
		const log = createRecordedLog();
		const pool = completeFunPool();
		filterVerifiedFun(
			pool,
			pool.flatMap((e) => (e.kind === "emoji" ? [e.reactionId] : [])),
			log,
		);
		expect(log.lines.filter((l) => l.level === "warn")).toEqual([]);
	});
});

describe("pickFun", () => {
	const pool = [
		gifEntry("approved", 1),
		gifEntry("failed", 1),
		emojiEntry("approved", 1),
		emojiEntry("approved", 2),
	];
	const approved = pool.filter((entry) => entry.verdict === "approved");

	test("returns the first matching entry when random is 0", () => {
		expect(pickFun(pool, "approved", () => 0)).toEqual(approved[0]);
	});

	test("returns the last matching entry when random is just below 1", () => {
		expect(pickFun(pool, "approved", () => 0.999)).toEqual(approved.at(-1));
	});

	test("takes index floor(random * count) among the verdict entries in pool order", () => {
		const wide = [
			gifEntry("approved", 1),
			gifEntry("failed", 1),
			gifEntry("approved", 2),
			emojiEntry("approved", 1),
			gifEntry("approved", 3),
		];
		const matching = wide.filter((entry) => entry.verdict === "approved");
		for (const [random, index] of [
			[0, 0],
			[0.24, 0],
			[0.25, 1],
			[0.5, 2],
			[0.74, 2],
			[0.75, 3],
			[0.999, 3],
		] as const) {
			expect(pickFun(wide, "approved", () => random)).toEqual(matching[index]);
		}
	});

	test("only returns entries of the requested verdict", () => {
		for (const r of [0, 0.3, 0.6, 0.999]) {
			expect(pickFun(pool, "failed", () => r)?.verdict).toBe("failed");
		}
	});

	test("returns undefined for a verdict with no entries", () => {
		expect(pickFun(pool, "comment", () => 0)).toBeUndefined();
	});

	test("returns undefined for an empty pool", () => {
		expect(pickFun([], "approved", () => 0)).toBeUndefined();
	});
});

describe("decorateReply", () => {
	test("appends an emoji entry's text as a new line and attaches no card", () => {
		const entry = emojiEntry("approved");
		const decorated = decorateReply({ text: "base", entry });
		expect(decorated.text).toBe(`base\n${(entry as { text: string }).text}`);
		expect(decorated.card).toBeUndefined();
	});

	test("attaches a one-Image AdaptiveCard for a gif entry and keeps the text", () => {
		const entry = gifEntry("approved");
		const decorated = decorateReply({ text: "base", entry });
		expect(decorated.text).toBe("base");
		expect(decorated.card).toEqual({
			type: "AdaptiveCard",
			version: "1.4",
			body: [
				{
					type: "Image",
					url: (entry as { url: string }).url,
					altText: (entry as { alt: string }).alt,
				},
			],
		});
	});
});

describe("funVerdictFor", () => {
	test.each([
		["approved", "approved"],
		["changesRequested", "changes"],
		["comment", "comment"],
		["failure", "failed"],
	] as const)("maps %s to %s", (outcome, verdict) => {
		expect(funVerdictFor(outcome)).toBe(verdict);
	});
});
