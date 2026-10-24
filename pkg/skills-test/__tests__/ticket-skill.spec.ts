import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "../../..");
const ticketDir = join(repo, "plugins/dg/skills/ticket");

function filesUnder(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

const BANNED_SHAPES = [
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	/\d{6}:[0-9a-f]{8}-[0-9a-f-]{27}/i,
	/customfield_\d+/,
];

const BANNED_TOKEN_SHA256 = new Set([
	"508807abb8e320ca5406af61ec014d513a93078170ba0289be8be551eaf9641f",
	"e23511eed17e60b3a82eaafb9b7b324da62ecefeec0ecc571907fa90247ad6a3",
]);

function bannedTokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => BANNED_TOKEN_SHA256.has(new Bun.CryptoHasher("sha256").update(token).digest("hex")));
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

describe("the ticket skill carries no real Jira identifiers", () => {
	const files = filesUnder(ticketDir);

	test("the skill ships at least a SKILL.md", () => {
		expect(files.some((f) => f.endsWith("SKILL.md"))).toBe(true);
	});

	for (const file of files) {
		test(`${file.slice(repo.length + 1)} contains none of the banned literals`, () => {
			const text = readFileSync(file, "utf8");
			for (const shape of BANNED_SHAPES) expect(text).not.toMatch(shape);
			expect(bannedTokens(text)).toEqual([]);
		});

		test(`${file.slice(repo.length + 1)} contains no email address`, () => {
			const text = readFileSync(file, "utf8");
			expect(text).not.toMatch(EMAIL_RE);
		});
	}

	test("the skill documents registering ticket/jira metadata instead of baking in identifiers", () => {
		const skillMd = readFileSync(join(ticketDir, "SKILL.md"), "utf8");
		expect(skillMd).toContain("ticket/jira");
		expect(skillMd).toContain("credentials set ticket/jira");
		expect(skillMd).toContain("credentials list --meta");
	});

	test("the skill calls the CLI by its literal installed path, never $DG", () => {
		const skillMd = readFileSync(join(ticketDir, "SKILL.md"), "utf8");
		expect(skillMd).not.toContain("$DG");
		expect(skillMd).toContain("~/.dg/bin/dg-skills");
	});
});
