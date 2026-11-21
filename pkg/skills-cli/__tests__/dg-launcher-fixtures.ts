import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compiledProgramPath } from "@dg/common/node/program";

export type Outcome = "kept" | "replaced";

export type LauncherFixture = {
	name: string;
	outcome: Outcome;
	skip?: boolean;
	setup: (dest: string, area: string) => string[];
};

export type Snapshot = {
	type: string;
	mode: number;
	bytes: string | undefined;
	link: string | undefined;
};

export const KEPT_SENTENCE = (path: string): string =>
	`dg: kept ${path}; it is not a dg launcher. Remove it or rename it, then run dg install again`;

export const launcherMarker = (
	platform: NodeJS.Platform = process.platform,
): string =>
	platform === "win32" ? "lib\\current\\dg.js" : "lib/current/dg.js";

export function makeArea(prefix: string): {
	area: string;
	cleanup: () => void;
} {
	const area = mkdtempSync(join(tmpdir(), `dg-${prefix}-`));
	return {
		area,
		cleanup: () => rmSync(area, { recursive: true, force: true }),
	};
}

export function generatedLauncher(
	area: string,
	name: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const other = join(area, "other-root");
	if (platform === "win32")
		return `@echo off\r\n"${other}\\runtime\\current\\bun.exe" "${other}\\lib\\current\\dg.js" ${name} %*\r\n`;
	return `#!/bin/sh\nroot='${other}'\nexec "$root/runtime/current/bun" "$root/lib/current/dg.js" ${name} "$@"\n`;
}

export function writeOldShims(
	bin: string,
	area: string,
	names: readonly string[],
	platform: NodeJS.Platform = process.platform,
): void {
	for (const name of names)
		put(join(bin, platform === "win32" ? `${name}.cmd` : name), generatedLauncher(area, name, platform));
}

const put = (path: string, text: string | Uint8Array, mode = 0o755): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	chmodSync(path, mode);
};

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

export function launcherFixtures(platform: NodeJS.Platform = process.platform): readonly LauncherFixture[] {
	const gen = (area: string, name: string): string => generatedLauncher(area, name, platform);
	return [
	{
		name: "a link to a file that is not a dg launcher",
		outcome: "kept",
		setup(dest, area) {
			const target = join(area, "foreign", "tool");
			put(target, "#!/bin/sh\necho other tool\n");
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(target, dest);
			return [target];
		},
	},
	{
		name: "a directory",
		outcome: "kept",
		setup(dest) {
			mkdirSync(dest, { recursive: true });
			return [];
		},
	},
	{
		name: "an empty file",
		outcome: "kept",
		setup(dest) {
			put(dest, "");
			return [];
		},
	},
	{
		name: "a file that cannot be read",
		outcome: "kept",
		skip: isRoot,
		setup(dest, area) {
			put(dest, gen(area, "dg"), 0o000);
			return [];
		},
	},
	{
		name: 'a script that runs exec dg-skills "$@"',
		outcome: "kept",
		setup(dest) {
			put(dest, '#!/bin/sh\nexec dg-skills "$@"\n');
			return [];
		},
	},
	{
		name: "a file with a NUL byte that holds the launcher text",
		outcome: "kept",
		setup(dest, area) {
			put(
				dest,
				Buffer.concat([
					Buffer.from([0]),
					Buffer.from(gen(area, "dg")),
				]),
			);
			return [];
		},
	},
	{
		name: "a FIFO",
		outcome: "kept",
		skip: process.platform === "win32",
		setup(dest) {
			mkdirSync(dirname(dest), { recursive: true });
			const made = Bun.spawnSync(["mkfifo", dest]);
			if (made.exitCode !== 0)
				throw new Error(`mkfifo: ${made.stderr.toString()}`);
			return [];
		},
	},
	{
		name: "a link with no target",
		outcome: "replaced",
		setup(dest, area) {
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(join(area, "nowhere"), dest);
			return [];
		},
	},
	{
		name: "a dg launcher with an added line",
		outcome: "replaced",
		setup(dest, area) {
			put(dest, `${gen(area, "dg")}# local tweak\n`);
			return [];
		},
	},
	{
		name: "a dg launcher of another root",
		outcome: "replaced",
		setup(dest, area) {
			put(dest, gen(area, "dg"));
			return [];
		},
	},
	{
		name: "a copy of the dg-skills launcher named dg",
		outcome: "replaced",
		setup(dest, area) {
			put(dest, gen(area, "dg-skills"));
			return [];
		},
	},
	{
		name: "a link to a dg launcher",
		outcome: "replaced",
		setup(dest, area) {
			const target = join(area, "real", "dg");
			put(target, gen(area, "dg"));
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(target, dest);
			return [target];
		},
	},
	{
		name: "a link to a link to a dg launcher",
		outcome: "replaced",
		setup(dest, area) {
			const target = join(area, "real", "dg");
			const middle = join(area, "real", "middle");
			put(target, gen(area, "dg"));
			symlinkSync(target, middle);
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(middle, dest);
			return [target];
		},
	},
	];
}

export const LAUNCHER_FIXTURES = launcherFixtures();

export function snapshot(path: string): Snapshot {
	const stat = lstatSync(path);
	const type = stat.isSymbolicLink()
		? "link"
		: stat.isDirectory()
			? "directory"
			: stat.isFIFO()
				? "fifo"
				: "file";
	let bytes: string | undefined;
	if (type === "file") {
		try {
			bytes = readFileSync(path).toString("base64");
		} catch {
			bytes = undefined;
		}
	}
	return {
		type,
		mode: stat.mode,
		bytes,
		link: type === "link" ? readlinkSync(path) : undefined,
	};
}

export function isReplacedLauncher(
	dest: string,
	root: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return lstatSync(dest).isSymbolicLink() && readlinkSync(dest) === compiledProgramPath(root, platform);
}
