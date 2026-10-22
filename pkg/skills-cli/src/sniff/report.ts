import { basename, resolve } from "node:path";
import {
	extractCompose,
	extractDockerfile,
	extractEnv,
	extractRegistries,
	extractTerraform,
	extractToolchain,
	extractWorkflows,
} from "./extract";
import type { Gap, Phase, ReqType, Requirement, SniffReport } from "./types";
import { walkFiles } from "./walk";

const RANGE_PIN = /[~^><*|]|\bx\b/;

function numericPrefix(value: string | undefined): string | undefined {
	return /^[0-9]+(?:\.[0-9]+)*/.exec(value ?? "")?.[0] ?? value;
}

const SOURCE_PRIORITY = [
	"secrets-mgr",
	"tfc-varset",
	"gh-secret",
	"gh-oidc",
	"terraform",
	"dockerfile",
	"compose",
	"mise",
	"global.json",
	"nvmrc",
	"package.json",
	"pyproject.toml",
	"nuget.config",
	"npmrc",
	"gh-workflow",
	".env",
	".env.sample",
];

const TYPE_ORDER: ReqType[] = [
	"SECRET",
	"CONFIG",
	"CLOUD_PERM",
	"SERVICE",
	"NETWORK",
	"TOOLCHAIN",
	"REGISTRY",
];

function sourceRank(source: string): number {
	const index = SOURCE_PRIORITY.indexOf(source);
	return index === -1 ? SOURCE_PRIORITY.length : index;
}

export function mergeRequirements(reqs: Requirement[]): Requirement[] {
	const groups = new Map<string, Requirement[]>();
	for (const r of reqs) {
		const key = `${r.type} ${r.name} ${r.type === "CLOUD_PERM" ? (r.value ?? "") : ""}`;
		const existing = groups.get(key);
		if (existing) existing.push(r);
		else groups.set(key, [r]);
	}

	const merged: Requirement[] = [];
	for (const group of groups.values()) {
		const primary = [...group].sort(
			(a, b) => sourceRank(a.source) - sourceRank(b.source),
		)[0] as Requirement;

		const phases = new Set<Phase>();
		for (const r of group) for (const p of r.phase) phases.add(p);

		const gaps: Gap[] = [];
		const seen = new Set<string>();
		for (const r of group) {
			for (const gap of r.gaps) {
				const key = `${gap.kind} ${gap.detail}`;
				if (seen.has(key)) continue;
				seen.add(key);
				gaps.push(gap);
			}
		}

		if (primary.type === "TOOLCHAIN") {
			const pins = [
				...new Map(
					group
						.filter((r) => r.value && !RANGE_PIN.test(r.value))
						.map(
							(r) =>
								[`${r.where.split(":")[0]} ${numericPrefix(r.value)}`, r] as const,
						),
				).values(),
			];
			if (pins.length > 1) {
				const versions = new Set(pins.map((p) => numericPrefix(p.value)));
				gaps.push({
					kind: "drifted",
					detail:
						versions.size > 1
							? `conflicting pins — ${pins.map((p) => `${p.value} (${p.where})`).join(", ")}`
							: `pinned in ${pins.length} places, keep in sync — ${pins.map((p) => p.where).join(" + ")}`,
				});
			}
		}

		merged.push({
			...primary,
			phase: (["dev", "build", "run"] as Phase[]).filter((p) => phases.has(p)),
			gaps,
		});
	}
	return merged;
}

export function sortRequirements(reqs: Requirement[]): Requirement[] {
	return [...reqs].sort((a, b) => {
		const aGap = a.gaps.length > 0 ? 0 : 1;
		const bGap = b.gaps.length > 0 ? 0 : 1;
		if (aGap !== bGap) return aGap - bGap;
		const aType = TYPE_ORDER.indexOf(a.type);
		const bType = TYPE_ORDER.indexOf(b.type);
		if (aType !== bType) return aType - bType;
		if (a.name === b.name) return 0;
		return a.name < b.name ? -1 : 1;
	});
}

export function sniff(root: string): Requirement[] {
	const files = walkFiles(root);
	return sortRequirements(
		mergeRequirements([
			...extractEnv(root, files),
			...extractWorkflows(root, files),
			...extractTerraform(root, files),
			...extractDockerfile(root, files),
			...extractCompose(root, files),
			...extractToolchain(root, files),
			...extractRegistries(root, files),
		]),
	);
}

export function buildReport(root: string): SniffReport {
	const requirements = sniff(root);
	const counts: Record<string, number> = {};
	for (const r of requirements) counts[r.type] = (counts[r.type] ?? 0) + 1;
	return {
		repo: basename(resolve(root)) || resolve(root),
		total: requirements.length,
		gaps: requirements.filter((r) => r.gaps.length > 0).length,
		counts,
		requirements,
	};
}
