import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@dg/common/node";
import { TestLiveError } from "./shared";

const EXCLUDED_KEYWORDS = ["infra", "build", "blt", "codeql", "admin"];

function isExcluded(name: string): boolean {
	return EXCLUDED_KEYWORDS.some((keyword) => name.includes(keyword));
}

const YAML_EXTENSION_RE = /\.ya?ml$/;

function sortedYamlFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => YAML_EXTENSION_RE.test(name))
			.sort();
	} catch {
		return [];
	}
}

function firstExisting(dir: string, names: string[]): string | null {
	return names.find((name) => existsSync(join(dir, name))) ?? null;
}

function firstNonExcludedMatch(files: string[], needle: string): string | null {
	return files.find((name) => name.includes(needle) && !isExcluded(name)) ?? null;
}

/** `KEY=relative/path` lines in `.claude/test-live.conf`; blank lines and `#` comments are ignored. */
function readOverride(env: string): string | null {
	const root = repoRoot();
	if (!root) return null;
	const confPath = join(root, ".claude", "test-live.conf");
	if (!existsSync(confPath)) return null;
	for (const rawLine of readFileSync(confPath, "utf8").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		if (line.slice(0, eq).trim() !== env) continue;
		const overridePath = join(root, line.slice(eq + 1).trim());
		if (existsSync(overridePath)) {
			process.stderr.write(`>>> Using repo override: ${overridePath}\n`);
			return overridePath;
		}
	}
	return null;
}

const EXACT_CANDIDATE_BASENAMES: Record<string, string[]> = {
	dev: ["deploy_dev", "dev_deploy", "deploy-dev", "dev-deploy"],
	stage: ["deploy_staging", "deploy-staging", "deploy_stage", "deploy-stage"],
	staging: ["deploy_staging", "deploy-staging", "deploy_stage", "deploy-stage"],
	prod: ["deploy_prod", "deploy-prod", "prod"],
};

const EXACT_CANDIDATES: Record<string, string[]> = Object.fromEntries(
	Object.entries(EXACT_CANDIDATE_BASENAMES).map(([env, basenames]) => [
		env,
		basenames.flatMap((basename) => [`${basename}.yml`, `${basename}.yaml`]),
	]),
);

/** Two needles for stage/staging, tried in this order, matching the legacy script's two concatenated globs. */
const WILDCARD_NEEDLES: Record<string, string[]> = {
	dev: ["dev"],
	stage: ["staging", "stage"],
	staging: ["staging", "stage"],
	prod: ["prod"],
};

/** The repo-local override applies even to an env outside dev/stage/staging/prod; only the built-in search validates env. */
export function findWorkflow(env: string, workflowsDir: string): string {
	const override = readOverride(env);
	if (override) return override;

	const candidates = EXACT_CANDIDATES[env];
	if (!candidates) {
		throw new TestLiveError(`unknown env '${env}' — use 'dev', 'stage', 'staging', or 'prod'`);
	}

	const exact = firstExisting(workflowsDir, candidates);
	if (exact) return join(workflowsDir, exact);

	const files = sortedYamlFiles(workflowsDir);
	for (const needle of WILDCARD_NEEDLES[env] ?? []) {
		const matched = firstNonExcludedMatch(files, needle);
		if (matched) return join(workflowsDir, matched);
	}

	if (env === "dev") {
		const fallback = firstExisting(workflowsDir, ["deploy.yml", "deploy.yaml"]);
		if (fallback) return join(workflowsDir, fallback);
	}

	throw new TestLiveError(`no ${env} workflow file found in ${workflowsDir}`);
}
