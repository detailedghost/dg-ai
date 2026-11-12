import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "@dg/common";
import { ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import {
	parsePlanMarkdown,
	type TourScript,
	toPlanMarkdown,
	validate,
} from "../utils/plan-format";
import { demosDir, demosWriteDir, legacyDemosDir, planFileName } from "./paths";

export function savePlan(
	script: TourScript,
	dir = join(demosWriteDir(), slugify(script.title ?? "demo")),
): string {
	ensurePrivateDir(dir);
	const path = join(dir, planFileName(slugify(script.title ?? "demo")));
	writeFileAtomic(path, toPlanMarkdown(script), 0o600);
	return path;
}

/** `.md` is the human-authored plan form; anything else is raw script JSON. */
export function loadScript(path: string): TourScript {
	const raw = readFileSync(path, "utf8");
	const parsed = path.endsWith(".md")
		? parsePlanMarkdown(raw)
		: JSON.parse(raw);
	return validate(parsed);
}

function subdirs(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name));
	} catch {
		return [];
	}
}

/** An existing path wins; a bare name is looked up under the demos dir, then the legacy one. */
export function findPlan(name: string): string {
	if (existsSync(name)) return name;
	if (name.includes("/") || name.includes("\\")) return name;
	const bare = name.endsWith(".md") ? name : planFileName(name);
	for (const root of [demosDir(), legacyDemosDir()]) {
		const slugDir = join(root, name, bare);
		if (existsSync(slugDir)) return slugDir;
		for (const dir of subdirs(root)) {
			const candidate = join(dir, bare);
			if (existsSync(candidate)) return candidate;
		}
	}
	return name;
}
