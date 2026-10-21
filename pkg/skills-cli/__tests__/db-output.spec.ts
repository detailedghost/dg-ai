import { describe, expect, test } from "bun:test";
import {
	formatConnections,
	formatQueryResult,
	sanitizeError,
} from "../src/db/output";

const result = {
	columns: ["name", "age"],
	rows: [
		["Alice", 30],
		["Bob", 25],
	],
	totalRows: 8,
};

describe("database output formatters", () => {
	test("formats TSV with the shown and total row counts", () => {
		expect(formatQueryResult(result, "tsv", 200, 1)).toBe(
			"ROWS: 1/8\nname\tage\nAlice\t30",
		);
	});

	test("formats newline-delimited JSON", () => {
		expect(formatQueryResult(result, "json", 200, 2)).toBe(
			'ROWS: 2/8\n{"name":"Alice","age":"30"}\n{"name":"Bob","age":"25"}',
		);
	});

	test("formats a Markdown table", () => {
		expect(formatQueryResult(result, "markdown", 200, 1)).toBe(
			"ROWS: 1/8\n| name | age |\n| --- | --- |\n| Alice | 30 |",
		);
	});

	test("truncates individual cells", () => {
		expect(
			formatQueryResult(
				{ columns: ["value"], rows: [["abcdefgh"]], totalRows: 1 },
				"tsv",
				4,
				1,
			),
		).toBe("ROWS: 1/1\nvalue\nabcd...");
	});

	test("keeps the complete output at or below the 64 KB ceiling", () => {
		const output = formatQueryResult(
			{
				columns: ["value"],
				rows: Array.from({ length: 100 }, () => ["x".repeat(1_000)]),
				totalRows: 100,
			},
			"tsv",
			2_000,
			100,
		);
		expect(output.startsWith("TRUNCATED: output exceeded 64KB limit")).toBe(true);
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(64 * 1024);
	});

	test("redacts passwords, passphrases, tokens, URLs and private keys", () => {
		const message = [
			"password=fixture-password",
			"privateKeyPass:'fixture passphrase'",
			"token = fixture-token",
			"postgresql://readonly:fixture-password@example.test/db",
			"-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----",
		].join(" ");
		const sanitized = sanitizeError(message);
		for (const secret of [
			"fixture-password",
			"fixture passphrase",
			"fixture-token",
			"fixture-key",
		])
			expect(sanitized).not.toContain(secret);
	});

	test("formats an empty connection list without reading values", () => {
		expect(formatConnections([])).toBe("CONNECTIONS: 0\n(none configured)");
	});
});
