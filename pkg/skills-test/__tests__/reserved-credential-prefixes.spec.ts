import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

const FORMAT = ["pkg", "common", "src", "credentials-format.ts"];
const SOURCES = [
	{ constant: "CREDENTIAL_SEALED_PREFIX", file: FORMAT },
	{
		constant: "EXTENSION_CREDENTIAL_PREFIX",
		file: ["pkg", "dg-daemon", "src", "server", "credentials.ts"],
	},
	{
		constant: "GRANT_PREFIX",
		file: ["pkg", "dg-agent", "src", "phone", "keys.ts"],
	},
	{
		constant: "VAULT_GRANT_PREFIX",
		file: ["pkg", "dg-agent", "src", "phone", "vault.ts"],
	},
	{
		constant: "CREDENTIAL_PREFIX",
		file: ["pkg", "skills-cli", "src", "db", "credentials.ts"],
	},
	{
		constant: "PW_EXT_CREDENTIAL_PREFIX",
		file: ["pkg", "common", "src", "pw-ext-credential-format.ts"],
	},
];

function constantValue(source: string, constant: string): string | undefined {
	const line = new RegExp(
		`^\\s*(?:export\\s+)?const ${constant}\\s*=\\s*"([^"]+)"`,
		"m",
	).exec(source);
	return line?.[1]?.replace(/\/$/, "");
}

function reservedList(source: string): string[] {
	const body = /RESERVED_CREDENTIAL_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(source);
	return [...(body?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function missingFromList(
	list: string[],
	sources: { constant: string; text: string }[],
): string[] {
	return sources.flatMap(({ constant, text }) => {
		const value = constantValue(text, constant);
		return value !== undefined && list.includes(value) ? [] : [constant];
	});
}

const loaded = SOURCES.map((entry) => ({
	constant: entry.constant,
	text: readRepoFile(...entry.file),
}));
const LIST = reservedList(readRepoFile(...FORMAT));

describe("reserved credential prefixes", () => {
	test("the list is not empty", () => {
		expect(LIST.length).toBeGreaterThan(0);
	});

	for (const { constant, text } of loaded) {
		test(`the list holds the value of ${constant}`, () => {
			const value = constantValue(text, constant);
			expect(value).toBeDefined();
			expect(LIST).toContain(value as string);
		});
	}

	test("GRANT_PREFIX does not read the value of the VAULT_GRANT_PREFIX line", () => {
		const grant = loaded.find((e) => e.constant === "GRANT_PREFIX");
		const vault = loaded.find((e) => e.constant === "VAULT_GRANT_PREFIX");
		const value = constantValue(grant?.text ?? "", "GRANT_PREFIX");
		expect(value).toBeDefined();
		expect(value).not.toBe(constantValue(vault?.text ?? "", "VAULT_GRANT_PREFIX"));
	});

	test("a source constant that is missing from the list is reported", () => {
		const vault = loaded.find((e) => e.constant === "VAULT_GRANT_PREFIX");
		const vaultValue = constantValue(vault?.text ?? "", "VAULT_GRANT_PREFIX");
		const without = LIST.filter((prefix) => prefix !== vaultValue);
		expect(missingFromList(without, loaded)).toEqual(["VAULT_GRANT_PREFIX"]);
		expect(missingFromList(LIST, loaded)).toEqual([]);
	});
});
