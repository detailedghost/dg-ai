import { redactPublicValue } from "../privacy/redact";
import type { CliFlags } from "./args";

export type OutputOptions = {
	ai: boolean;
	aiSummary: boolean;
	aiFields?: string[];
	aiLimit?: number;
	aiRedacted: boolean;
};

export function outputOptionsFromFlags(flags: CliFlags): OutputOptions {
	const aiFields =
		typeof flags["ai-fields"] === "string"
			? flags["ai-fields"]
					.split(",")
					.map((field) => field.trim())
					.filter(Boolean)
			: undefined;
	const aiLimit =
		typeof flags["ai-limit"] === "string"
			? Number(flags["ai-limit"])
			: undefined;

	return {
		ai: flags.ai === true || flags.ai === "true",
		aiSummary: flags["ai-summary"] === true || flags["ai-summary"] === "true",
		aiFields,
		aiLimit: Number.isFinite(aiLimit) ? aiLimit : undefined,
		aiRedacted: flags["ai-redacted"] !== "false",
	};
}

export function projectFields<T extends Record<string, unknown>>(
	row: T,
	fields?: string[],
): Partial<T> {
	if (!fields || fields.length === 0) {
		return row;
	}
	return Object.fromEntries(
		fields
			.map((field) => [field, row[field]])
			.filter(([, value]) => value !== undefined),
	) as Partial<T>;
}

export function limitRows<T>(rows: T[], limit?: number): T[] {
	return typeof limit === "number" ? rows.slice(0, limit) : rows;
}

export function printJson(value: unknown): void {
	console.log(JSON.stringify(redactPublicValue(value)));
}

export function printJsonLines(values: unknown[]): void {
	for (const value of values) {
		printJson(value);
	}
}

export function printTable(rows: Record<string, unknown>[]): void {
	if (rows.length === 0) {
		console.log("No rows.");
		return;
	}

	const columns = Object.keys(rows[0]);
	console.log(String(redactPublicValue(columns.join("\t"))));
	for (const row of rows) {
		console.log(
			String(
				redactPublicValue(
					columns.map((column) => String(row[column] ?? "")).join("\t"),
				),
			),
		);
	}
}
