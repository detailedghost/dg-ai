import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	bump,
	git,
	classify,
	highestLevel,
	listTags,
	previousTag,
	readCommits,
	type BumpLevel,
	type Commit,
} from "./release-version";

const FLOOR_PATH = "pkg/common/src/pw-ext-format.ts";
const EXTENSION_PACKAGE = "pkg/extension/package.json";
const FLOOR_PATTERN =
	/PW_EXT_MIN_EXTENSION_VERSION\s*=\s*\[\s*(\d+),\s*(\d+),\s*(\d+)\s*\]/;
const RANK: Record<BumpLevel, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export type FloorInput = {
	floor: string;
	baseFloor: string | null;
	released: string;
	title: string;
	body: string;
	commits: readonly Commit[];
};

export type FloorResult = { ok: boolean; message: string };

export function parseFloor(source: string): string | null {
	const match = FLOOR_PATTERN.exec(source);
	return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function segments(version: string): number[] {
	return version.split(".").map((segment) => {
		if (!/^\d+$/.test(segment)) {
			throw new Error(`version "${version}" has a segment that is not a non-negative integer: "${segment}"`);
		}
		return Number(segment);
	});
}

export function compareVersions(a: string, b: string): number {
	const left = segments(a);
	const right = segments(b);
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function predictedVersion(input: FloorInput): string {
	const fromPr = classify({ subject: input.title, body: input.body });
	const fromCommits = highestLevel(input.commits);
	const level = RANK[fromPr] >= RANK[fromCommits] ? fromPr : fromCommits;
	return bump(input.released, level) ?? input.released;
}

export function checkFloor(input: FloorInput): FloorResult {
	const predicted = predictedVersion(input);
	if (compareVersions(input.floor, predicted) > 0) {
		return {
			ok: false,
			message: `the floor ${input.floor} is above the version this PR would release, ${predicted}`,
		};
	}
	const changed = input.baseFloor !== input.floor;
	if (changed && compareVersions(input.floor, input.released) <= 0) {
		return {
			ok: false,
			message:
				`the floor ${input.floor} is not above the released extension ${input.released}; ` +
				"an old extension would pass",
		};
	}
	return {
		ok: true,
		message: `the floor ${input.floor} is consistent with release ${predicted}`,
	};
}

function baseFloorSource(root: string, baseRef: string): string | null {
	try {
		return git(root, ["show", `origin/${baseRef}:${FLOOR_PATH}`]);
	} catch {
		return null;
	}
}

function requireFloor(source: string, where: string): string {
	const floor = parseFloor(source);
	if (floor === null) throw new Error(`no PW_EXT_MIN_EXTENSION_VERSION in ${where}`);
	return floor;
}

export function main(env: NodeJS.ProcessEnv, root = process.cwd()): FloorResult {
	const baseRef = env.BASE_REF;
	if (!baseRef) throw new Error("BASE_REF is required");
	const released = String(
		JSON.parse(readFileSync(join(root, EXTENSION_PACKAGE), "utf8")).version,
	);
	const tag = previousTag(released, listTags(root));
	const baseSource = baseFloorSource(root, baseRef);
	return checkFloor({
		floor: requireFloor(readFileSync(join(root, FLOOR_PATH), "utf8"), FLOOR_PATH),
		baseFloor: baseSource === null ? null : parseFloor(baseSource),
		released,
		title: env.PR_TITLE ?? "",
		body: env.PR_BODY ?? "",
		commits: tag ? readCommits(root, `${tag}..HEAD`) : [],
	});
}

if (import.meta.main) {
	try {
		const result = main(process.env);
		console.log(result.message);
		process.exit(result.ok ? 0 : 1);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
