import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKETPLACE_PATH, type Marketplace, readMarketplace } from "./marketplace-support";
import { makeTempDir, REPO_ROOT } from "./test-support";

const SCRIPT = join(REPO_ROOT, "scripts", "bump-plugin-pin.ts");
export const NEW_SHA = "0123456789abcdef0123456789abcdef01234567";

export type Run = {
	raw: string;
	code: number;
	stdout: string;
	stderr: string;
	marketplace: Marketplace;
	gitArgs: string[];
};

export function run(args: string[], gitScript: string, { withMarketplace = true, withGit = true } = {}): Run {
	const dir = makeTempDir("dg-bump-pin-");
	mkdirSync(join(dir, ".claude-plugin"));
	const target = join(dir, ".claude-plugin", "marketplace.json");
	if (withMarketplace) writeFileSync(target, readFileSync(MARKETPLACE_PATH, "utf8"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const log = join(dir, "git-args.log");
	const fakeGit = join(bin, "git");
	if (withGit) {
		writeFileSync(fakeGit, `#!/bin/sh\necho "$@" >> "${log}"\n${gitScript}\n`);
		chmodSync(fakeGit, 0o755);
	}
	const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
		cwd: dir,
		env: { ...process.env, PATH: withGit ? `${bin}:${process.env.PATH}` : bin },
		stdout: "pipe",
		stderr: "pipe",
	});
	let gitArgs: string[] = [];
	try {
		gitArgs = readFileSync(log, "utf8").trim().split("\n");
	} catch {
		gitArgs = [];
	}
	return {
		raw: withMarketplace ? readFileSync(target, "utf8") : "",
		code: proc.exitCode ?? -1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		marketplace: withMarketplace ? readMarketplace(target) : { name: "", plugins: [] },
		gitArgs,
	};
}

export function sourceOf(marketplace: Marketplace, name: string) {
	const plugin = marketplace.plugins.find((p) => p.name === name);
	return plugin?.source as { repo: string; ref: string; sha: string };
}
