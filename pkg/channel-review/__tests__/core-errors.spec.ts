import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ERROR_CATALOG, ownerName, replyText } from "../src/errors";
import type { CrCode } from "../src/errors";

const CODES: CrCode[] = [
	"CR-101",
	"CR-102",
	"CR-103",
	"CR-104",
	"CR-105",
	"CR-106",
	"CR-107",
	"CR-108",
	"CR-109",
	"CR-201",
	"CR-202",
	"CR-203",
	"CR-204",
	"CR-205",
	"CR-206",
	"CR-207",
	"CR-301",
	"CR-302",
	"CR-303",
	"CR-304",
	"CR-305",
	"CR-306",
	"CR-401",
	"CR-402",
	"CR-403",
	"CR-404",
	"CR-405",
];

describe("ERROR_CATALOG", () => {
	test("holds exactly the documented codes", () => {
		expect(Object.keys(ERROR_CATALOG).sort()).toEqual([...CODES].sort());
	});

	test.each(CODES)("%s has one non-empty template", (code) => {
		const template = ERROR_CATALOG[code] as unknown;
		expect(typeof template).toBe("string");
		expect((template as string).trim().length).toBeGreaterThan(0);
	});

	test.each(["CR-201", "CR-202", "CR-203", "CR-206"] as CrCode[])(
		"%s template carries the {agent} placeholder",
		(code) => {
			expect(ERROR_CATALOG[code]).toContain("{agent}");
		},
	);

	test("CR-204 template carries the {minutes} placeholder", () => {
		expect(ERROR_CATALOG["CR-204"]).toContain("{minutes}");
	});

	test("errors.ts imports nothing so a test can load it as pure data", () => {
		const source = readFileSync(
			new URL("../src/errors.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toMatch(/^\s*import\s/m);
		expect(source).not.toMatch(/\brequire\(/);
	});
});

describe("ownerName", () => {
	test.each([
		["!owner", "Owner"],
		["!ryan", "Ryan"],
		["@Owner", "Owner"],
		["!", "the owner"],
	])("%s gives %s", (token, name) => {
		expect(ownerName(token)).toBe(name);
	});
});

test("no template names a specific person", () => {
	for (const template of Object.values(ERROR_CATALOG)) expect(template).not.toContain("Owner");
});

describe("replyText", () => {
	test.each(CODES)("%s renders '<code>: <sentence>' with no placeholder left", (code) => {
		const text = replyText(code, { agent: "codex", minutes: 30 });
		expect(text.startsWith(`${code}: `)).toBe(true);
		expect(text.length).toBeGreaterThan(code.length + 2);
		expect(text).not.toMatch(/[{}]/);
	});

	test("substitutes the agent name", () => {
		expect(replyText("CR-201", { agent: "codex" })).toContain("codex");
	});

	test("substitutes every {owner} with the owner name", () => {
		const text = replyText("CR-202", { agent: "codex", owner: "Ryan" });
		expect(text).toContain("Ryan's computer");
		expect(text).toContain("Ask Ryan");
		expect(text).not.toContain("Owner");
	});

	test("falls back to 'the owner' without an owner", () => {
		expect(replyText("CR-302")).toContain("the owner can see it");
	});

	test("substitutes the minutes", () => {
		expect(replyText("CR-204", { minutes: 45 })).toContain("45");
	});

	test("renders a code that has no placeholders without vars", () => {
		expect(replyText("CR-101")).toStartWith("CR-101: ");
	});
});
