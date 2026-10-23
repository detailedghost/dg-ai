import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildCompiledBinary } from "./compiled-binary";

const COMPILED_PREFIX = "dg-skills-compiled-";
const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(COMPILED_PREFIX)));

Bun.spawnSync = (() => ({
	exitCode: 1,
	success: false,
	resourceUsage: {},
	pid: -1,
	stdout: Buffer.from(""),
	stderr: Buffer.from("forced failure"),
})) as unknown as typeof Bun.spawnSync;

let threw = false;
try {
	buildCompiledBinary();
} catch {
	threw = true;
}

const leaked = readdirSync(tmpdir())
	.filter((name) => name.startsWith(COMPILED_PREFIX))
	.filter((name) => !before.has(name));

const ok = threw && leaked.length === 0;
process.stdout.write(ok ? "OK\n" : `FAIL threw=${threw} leaked=${leaked.join(",")}\n`);
process.exit(ok ? 0 : 1);
