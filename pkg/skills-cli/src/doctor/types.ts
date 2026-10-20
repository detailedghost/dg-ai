import type { DgPaths } from "@dg/common/node";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
	status: CheckStatus;
	detail: string;
	fix?: string;
}

export interface DoctorContext {
	home: string;
	env: NodeJS.ProcessEnv;
	paths: DgPaths;
	installedVersion: string;
	memo<T>(key: string, make: () => T): T;
}

export interface DoctorCheck {
	id: string;
	run(ctx: DoctorContext): CheckResult | Promise<CheckResult>;
}

export interface CheckReport {
	id: string;
	status: CheckStatus;
	detail: string;
	fix: string | null;
}

export interface ItemReport {
	item: string;
	checks: CheckReport[];
}

export interface DoctorReport {
	items: ItemReport[];
	ok: boolean;
}

export const ok = (detail: string): CheckResult => ({ status: "ok", detail });

export const warn = (detail: string, fix: string): CheckResult => ({
	status: "warn",
	detail,
	fix,
});

export const fail = (detail: string, fix: string): CheckResult => ({
	status: "fail",
	detail,
	fix,
});
