import type { CheckReport, CheckStatus, DoctorReport } from "./types";

export type FixAction = { kind: "run"; argv: string[] } | { kind: "allow-rule"; rules: string[] };

export type GroupMember = { item: string; check: CheckReport };

export type Group = {
	key: string;
	status: CheckStatus;
	title: string;
	members: GroupMember[];
	fix: string | null;
	action: FixAction | null;
};

const RUNNABLE = /^(dg-skills|dg-agent) [\w ./:=@-]+$/;
const STATUS_ORDER: CheckStatus[] = ["fail", "warn", "info", "ok"];

/** The argv of a fix that runs one of dg's own CLIs with plain words; null for any other fix. */
export function runnableFix(fix: string | null): string[] | null {
	return fix !== null && RUNNABLE.test(fix) ? fix.split(/\s+/) : null;
}

function keyOf(member: GroupMember): string {
	const { item, check } = member;
	if (check.id === "allow-rule" && check.fix) return "allow-rule";
	return check.fix ? `fix:${check.fix}` : `check:${item}:${check.id}`;
}

function titleOf(key: string, members: GroupMember[]): string {
	const first = members[0] as GroupMember;
	if (key === "allow-rule") return `allow rules (${members.length})`;
	if (members.length === 1) return `${first.item}: ${first.check.detail}`;
	return `${first.check.id} (${members.length})`;
}

function actionOf(key: string, members: GroupMember[], fix: string | null): FixAction | null {
	if (key === "allow-rule")
		return { kind: "allow-rule", rules: [...new Set(members.flatMap((m) => (m.check.fix ? [m.check.fix] : [])))] };
	const argv = runnableFix(fix);
	return argv ? { kind: "run", argv } : null;
}

function summaryGroup(status: "info" | "ok", members: GroupMember[]): Group {
	const label = status === "ok" ? "passed" : "info";
	return { key: status, status, title: `${members.length} ${label}`, members, fix: null, action: null };
}

/** Folds a report into rows: failures, then warnings, merged by shared fix; info and ok as one row each. */
export function groupReport(report: DoctorReport): Group[] {
	const buckets = new Map<string, GroupMember[]>();
	const passed: Record<"info" | "ok", GroupMember[]> = { info: [], ok: [] };
	for (const entry of report.items) {
		for (const check of entry.checks) {
			const member = { item: entry.item, check };
			if (check.status === "info" || check.status === "ok") {
				passed[check.status].push(member);
				continue;
			}
			const key = `${check.status}:${keyOf(member)}`;
			buckets.set(key, [...(buckets.get(key) ?? []), member]);
		}
	}
	const groups: Group[] = [...buckets].map(([key, members]) => {
		const first = members[0] as GroupMember;
		const bare = key.slice(key.indexOf(":") + 1);
		return {
			key,
			status: first.check.status,
			title: titleOf(bare, members),
			members,
			fix: first.check.fix,
			action: actionOf(bare, members, first.check.fix),
		};
	});
	for (const status of ["info", "ok"] as const)
		if (passed[status].length > 0) groups.push(summaryGroup(status, passed[status]));
	return groups.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
}
