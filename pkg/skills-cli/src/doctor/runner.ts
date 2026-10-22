import { homedir } from "node:os";
import { resolveDgPaths } from "@dg/common/node";
import pkg from "../../package.json" with { type: "json" };
import { CLI_PATH } from "./probes";
import { SHARED_ITEM } from "./shared";
import type {
	CheckReport,
	DoctorCheck,
	DoctorContext,
	DoctorReport,
	ItemReport,
} from "./types";

export type DoctorRegistry = Record<string, DoctorCheck[]>;

const STATUS_ICON = { ok: "✅", warn: "⚠️", fail: "❌" } as const;

export function createContext(
	overrides: Partial<Omit<DoctorContext, "memo">> = {},
): DoctorContext {
	const cache = new Map<string, unknown>();
	const env = overrides.env ?? process.env;
	const home = overrides.home ?? env.HOME ?? homedir();
	return {
		home,
		env,
		paths: overrides.paths ?? resolveDgPaths({ homeDir: home, env }),
		installedVersion: overrides.installedVersion ?? pkg.version,
		memo<T>(key: string, make: () => T): T {
			if (!cache.has(key)) cache.set(key, make());
			return cache.get(key) as T;
		},
	};
}

export function unknownItems(
	requested: readonly string[],
	registry: DoctorRegistry,
): string[] {
	return requested.filter((item) => !Object.hasOwn(registry, item));
}

async function runCheck(
	item: string,
	check: DoctorCheck,
	ctx: DoctorContext,
): Promise<CheckReport> {
	try {
		const result = await check.run(ctx);
		return {
			id: check.id,
			status: result.status,
			detail: result.detail,
			fix: result.fix ?? null,
		};
	} catch (error) {
		return {
			id: check.id,
			status: "fail",
			detail: `check ${check.id} threw: ${error instanceof Error ? error.message : String(error)}; file an issue with the output of the fix command`,
			fix: `${CLI_PATH} doctor ${item} --json`,
		};
	}
}

export async function runDoctor(
	requested: readonly string[],
	registry: DoctorRegistry,
	ctx: DoctorContext = createContext(),
): Promise<DoctorReport> {
	const names =
		requested.length > 0 ? requested : Object.keys(registry);
	const selected = [
		...new Set([SHARED_ITEM, ...names.filter((name) => name !== SHARED_ITEM)]),
	];
	const items: ItemReport[] = [];
	for (const item of selected) {
		const checks = Object.hasOwn(registry, item) ? registry[item] : [];
		const reports: CheckReport[] = [];
		for (const check of checks) reports.push(await runCheck(item, check, ctx));
		items.push({ item, checks: reports });
	}
	const failed = items.some((entry) =>
		entry.checks.some((check) => check.status === "fail"),
	);
	return { items, ok: !failed };
}

export function formatReport(report: DoctorReport): string {
	const lines: string[] = [];
	const counts = { ok: 0, warn: 0, fail: 0 };
	for (const entry of report.items) {
		lines.push(entry.item);
		for (const check of entry.checks) {
			counts[check.status]++;
			lines.push(`  ${STATUS_ICON[check.status]} ${check.id}: ${check.detail}`);
			if (check.fix) lines.push(`      Fix: ${check.fix}`);
		}
	}
	lines.push(
		"",
		`${counts.ok} passed, ${counts.warn} to review, ${counts.fail} failed`,
	);
	return `${lines.join("\n")}\n`;
}

export const doctorExitCode = (report: DoctorReport): number =>
	report.ok ? 0 : 1;
