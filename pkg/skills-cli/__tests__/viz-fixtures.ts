import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dependencyHash } from "../src/viz/server";
import { makeTempDir } from "./git-repo-fixtures";
import { mergeEnv } from "./module-call";
import { collectRun, SOURCE_SKILLS, type SpecRun } from "./spec-fixtures";

export const SESSION_ID = "abcd1234";

const FAKE_SERVER = `import { appendFileSync } from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
appendFileSync(process.env.FAKE_STARTS, process.pid + "\\n");
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/api/_meta")
      return Response.json({ vizDir: process.env.VIZ_DIR, port, pid: process.pid });
    return new Response("ok");
  },
});
`;

const FAKE_BUN = `#!/bin/sh
echo "$PWD|$*" >> "$FAKE_BUN_LOG"
case "$1" in
  install) /bin/sleep 1; /bin/mkdir -p node_modules; exit 0 ;;
  run) shift; shift; exec "$REAL_BUN" "$FAKE_SERVER" "$@" ;;
esac
exec "$REAL_BUN" "$@"
`;

const FAILING_BUN = `#!/bin/sh
if [ "$1" = install ]; then echo "fake registry unreachable" >&2; exit 1; fi
exec "$REAL_BUN" "$@"
`;

const FLAKY_BUN = `#!/bin/sh
echo "$PWD|$*" >> "$FAKE_BUN_LOG"
if [ "$1" = install ] && [ ! -f "$FAKE_BUN_LOG.failed" ]; then
  : > "$FAKE_BUN_LOG.failed"; /bin/mkdir -p node_modules; echo "interrupted" >&2; exit 1
fi
case "$1" in
  install) /bin/sleep 1; /bin/mkdir -p node_modules; exit 0 ;;
  run) shift; shift; exec "$REAL_BUN" "$FAKE_SERVER" "$@" ;;
esac
exec "$REAL_BUN" "$@"
`;

export interface VizWorld {
	base: string;
	home: string;
	vizDir: string;
	skills: string;
	shimBin: string;
	failingBin: string;
	flakyBin: string;
	emptyBin: string;
	elsewhere: string;
	serverScript: string;
	starts: string;
	bunLog: string;
}

export function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = probe.port as number;
	probe.stop(true);
	return port;
}

function writeExecutable(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

export function newVizWorld(): VizWorld {
	const base = makeTempDir("dg-viz-");
	const world: VizWorld = {
		base,
		home: join(base, "home"),
		vizDir: join(base, "viz dir"),
		skills: join(base, "relocated plugin", "skills"),
		shimBin: join(base, "shim bin"),
		failingBin: join(base, "failing bin"),
		flakyBin: join(base, "flaky bin"),
		emptyBin: join(base, "empty bin"),
		elsewhere: join(base, "elsewhere"),
		serverScript: join(base, "fake-server.ts"),
		starts: join(base, "starts.log"),
		bunLog: join(base, "bun.log"),
	};
	for (const dir of [world.home, world.emptyBin, world.elsewhere])
		mkdirSync(dir, { recursive: true });
	writeFileSync(world.serverScript, FAKE_SERVER);
	writeExecutable(join(world.shimBin, "bun"), FAKE_BUN);
	writeExecutable(join(world.failingBin, "bun"), FAILING_BUN);
	writeExecutable(join(world.flakyBin, "bun"), FLAKY_BUN);
	return world;
}

export function installRealVizSkill(world: VizWorld): string {
	const target = join(world.skills, "viz");
	cpSync(join(SOURCE_SKILLS, "viz"), target, { recursive: true });
	return join(target, "astro-viewer");
}

export function installFakeViewer(
	world: VizWorld,
	withModules: boolean,
): string {
	const viewer = join(world.skills, "viz", "astro-viewer");
	mkdirSync(viewer, { recursive: true });
	writeFileSync(
		join(viewer, "package.json"),
		JSON.stringify({ name: "fake-viewer", scripts: { dev: "bun fake" } }),
	);
	if (withModules) {
		mkdirSync(join(viewer, "node_modules"), { recursive: true });
		writeFileSync(
			join(viewer, "node_modules", ".dg-install-ok"),
			dependencyHash(viewer),
		);
	}
	return viewer;
}

export function vizEnv(
	world: VizWorld,
	port: number,
	extra: Record<string, string | undefined> = {},
): Record<string, string> {
	return mergeEnv({
		HOME: world.home,
		PATH: world.shimBin,
		VIZ_PORT: String(port),
		VIZ_DIR: world.vizDir,
		VIZ_SKILL_DIR: join(world.skills, "viz"),
		VIZ_NO_BROWSER: undefined,
		DG_HOME: undefined,
		DG_SKILLS: undefined,
		DG_SKILLS_DIR: undefined,
		DG_SKILLS_DEST: undefined,
		CLAUDE_PLUGIN_ROOT: undefined,
		CODEX_PLUGIN_ROOT: undefined,
		DG_PLUGIN_ROOT: undefined,
		CLAUDE_CODE_SESSION_ID: SESSION_ID,
		CLAUDE_SESSION_ID: undefined,
		AI_SCRATCH_DIR: join(world.base, "scratch"),
		AI_STATE_DIR: join(world.base, "state"),
		FAKE_STARTS: world.starts,
		FAKE_BUN_LOG: world.bunLog,
		FAKE_SERVER: world.serverScript,
		REAL_BUN: process.execPath,
		...extra,
	});
}

export function writePayload(world: VizWorld, name = "payload.json"): string {
	const path = join(world.base, name);
	writeFileSync(
		path,
		JSON.stringify({
			slug: "demo",
			template: "plan",
			decisions: [],
			open_questions: [],
		}),
	);
	return path;
}

export function sessionPayloadPath(world: VizWorld, slug = "demo"): string {
	return join(world.vizDir, `${slug}-${SESSION_ID}`, "payload.json");
}

export function readStarts(world: VizWorld): number[] {
	if (!existsSync(world.starts)) return [];
	return readFileSync(world.starts, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(Number);
}

export function runVizBinary(
	binary: string,
	world: VizWorld,
	args: string[],
	env: Record<string, string>,
): Promise<SpecRun> {
	return collectRun(
		Bun.spawn([binary, "viz", ...args], {
			cwd: world.elsewhere,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
}

function killQuietly(pid: number): boolean {
	try {
		process.kill(pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
}

export async function stopStartedServers(
	binary: string,
	world: VizWorld,
	env: Record<string, string>,
): Promise<void> {
	await runVizBinary(binary, world, ["stop"], env).catch(() => undefined);
	for (const pid of readStarts(world)) {
		killQuietly(pid);
	}
	rmSync(world.starts, { force: true });
	rmSync(world.bunLog, { force: true });
	rmSync(world.vizDir, { recursive: true, force: true });
}
