import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { COMPLETION_SHELLS, completionScript } from "@dg/common/completion";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { PROGRAM_NAMES } from "@dg/common/node/program";
import { completionChecks } from "../src/completion/doctor";
import {
	type CompletionSeams,
	completionFiles,
	completionState,
	removeCompletions,
	writeCompletions,
} from "../src/completion/files";
import { createContext } from "../src/doctor/runner";
import { makeArea } from "./dg-launcher-fixtures";
import { fenceEnv } from "./fence-env";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const posix = describe.skipIf(process.platform === "win32");
const FOREIGN = "#!/bin/sh\necho other tool\n";

type Seams = Required<Pick<CompletionSeams, "env" | "home" | "platform">> & {
	binDir: string;
};

let area: string;
let cleanup: () => void;
let seams: Seams;

beforeEach(() => {
	({ area, cleanup } = makeArea("completion-dg"));
	seams = {
		env: { PATH: "" },
		home: join(area, "home"),
		platform: "linux",
		binDir: join(area, "bin"),
	};
	mkdirSync(seams.binDir, { recursive: true });
});

afterEach(() => cleanup());

const linkDg = (bin: string, root: string): void => {
	mkdirSync(bin, { recursive: true });
	symlinkSync(join(root, "bin", "current", "dg"), join(bin, "dg"));
};

const RETIRED_TEXT = (program: string): string => `complete -F _old ${program} __complete\n`;

const dgFiles = (given: Seams = seams) =>
	completionFiles(given).filter((file) => file.program === "dg");

posix("completionFiles with a dg launcher in the bin folder", () => {
	test("gives only the dg file for each of the three shells", () => {
		const files = completionFiles(seams);

		expect(files).toHaveLength(3);
		expect([...new Set(files.map((file) => file.program))]).toEqual(["dg"]);
		expect(files.map((file) => file.shell)).toEqual([...COMPLETION_SHELLS]);
	});

	test("also gives dg when <bin>/dg is the link the installer writes", () => {
		linkDg(seams.binDir, resolveDgPaths().dataDir);

		expect(completionFiles(seams)).toHaveLength(3);
	});

	test("gives nothing when <bin>/dg is a file of a different tool", () => {
		writeFileSync(join(seams.binDir, "dg"), FOREIGN);

		expect(completionFiles(seams)).toEqual([]);
	});

	test("writeCompletions writes each dg file equal to completionScript for its shell", () => {
		writeCompletions(seams, () => undefined);

		for (const file of dgFiles())
			expect(readFileSync(file.path, "utf8")).toBe(
				completionScript(file.shell, "dg"),
			);
	});

	test("writeCompletions writes no file at all for a different tool named dg", () => {
		writeFileSync(join(seams.binDir, "dg"), FOREIGN);
		const withDg = completionFiles({
			...seams,
			binDir: join(area, "empty-bin"),
		});

		const written = writeCompletions(seams, () => undefined);

		expect(written).toEqual([]);
		for (const file of withDg) expect([file.path, existsSync(file.path)]).toEqual([file.path, false]);
	});

	test("writeCompletions writes no file for the retired program names", () => {
		writeCompletions(seams, () => undefined);

		for (const program of PROGRAM_NAMES)
			for (const shell of COMPLETION_SHELLS) {
				const path = completionFiles(seams).find((file) => file.shell === shell)?.path ?? "";
				expect(existsSync(path.replace(/dg(\.fish)?$/, `${program}$1`))).toBe(false);
			}
	});

	test("writeCompletions and removeCompletions leave an older dg completion file alone for a different tool", () => {
		const older = dgFiles({ ...seams, binDir: join(area, "empty-bin") });
		for (const file of older) {
			mkdirSync(join(file.path, ".."), { recursive: true });
			writeFileSync(file.path, "complete -F _old dg __complete\n");
		}
		writeFileSync(join(seams.binDir, "dg"), FOREIGN);

		writeCompletions(seams, () => undefined);
		removeCompletions(seams, () => undefined);

		for (const file of older)
			expect(readFileSync(file.path, "utf8")).toBe(
				"complete -F _old dg __complete\n",
			);
	});
});

posix("retired completion files", () => {
	const retired = (given: Seams = seams) =>
		PROGRAM_NAMES.flatMap((program) =>
			COMPLETION_SHELLS.map((shell) => {
				const dg = completionFiles({ ...given, binDir: join(area, "empty-bin") }).find((file) => file.shell === shell);
				return { program, path: (dg?.path ?? "").replace(/dg(\.fish)?$/, `${program}$1`) };
			}),
		);
	const seed = (): void => {
		for (const file of retired()) {
			mkdirSync(join(file.path, ".."), { recursive: true });
			writeFileSync(file.path, RETIRED_TEXT(file.program));
		}
	};

	test("writeCompletions removes retired files that call back into their program", () => {
		seed();
		const lines: string[] = [];

		writeCompletions(seams, (line) => void lines.push(line));

		for (const file of retired()) expect([file.path, existsSync(file.path)]).toEqual([file.path, false]);
		for (const file of retired()) expect(lines).toContain(`dg: removed ${file.path}`);
		for (const file of dgFiles()) expect(existsSync(file.path)).toBe(true);
	});

	test("removeCompletions removes the retired files and the dg files", () => {
		seed();
		writeCompletions(seams, () => undefined);
		seed();

		removeCompletions(seams, () => undefined);

		for (const file of [...retired(), ...dgFiles()]) expect([file.path, existsSync(file.path)]).toEqual([file.path, false]);
	});

	test("a retired-name file that does not call back stays", () => {
		const [first] = retired();
		mkdirSync(join(first?.path ?? "", ".."), { recursive: true });
		writeFileSync(first?.path ?? "", "# mine\n");

		writeCompletions(seams, () => undefined);
		removeCompletions(seams, () => undefined);

		expect(readFileSync(first?.path ?? "", "utf8")).toBe("# mine\n");
	});

	test("a second writeCompletions removes nothing more", () => {
		seed();
		writeCompletions(seams, () => undefined);
		const lines: string[] = [];

		writeCompletions(seams, (line) => void lines.push(line));

		expect(lines).toEqual([]);
	});
});

posix(
	"dg completion --install with a file of a different tool named dg",
	() => {
		test("writes no dg file and removes none", () => {
			const dgHome = join(area, "dg-home");
			mkdirSync(join(dgHome, "bin"), { recursive: true });
			writeFileSync(join(dgHome, "bin", "dg"), FOREIGN);
			const older = join(
				dgHome,
				"share",
				"bash-completion",
				"completions",
				"dg",
			);
			mkdirSync(join(older, ".."), { recursive: true });
			writeFileSync(older, "complete -F _old dg __complete\n");

			const run = Bun.spawnSync(
				[process.execPath, ENTRY, "completion", "--install"],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, ...fenceEnv(), DG_HOME: dgHome, PATH: "" },
				},
			);

			expect(run.exitCode, run.stderr.toString()).toBe(0);
			expect(readFileSync(older, "utf8")).toBe(
				"complete -F _old dg __complete\n",
			);
			expect(
				existsSync(
					join(dgHome, "share", "bash-completion", "completions", "dg-skills"),
				),
			).toBe(false);
			expect(
				existsSync(join(dgHome, "config", "fish", "completions", "dg.fish")),
			).toBe(false);
		});

		test("writes the dg files when the dg file is a dg launcher", () => {
			const dgHome = join(area, "dg-home");
			linkDg(join(dgHome, "bin"), join(dgHome, "data"));

			const run = Bun.spawnSync(
				[process.execPath, ENTRY, "completion", "--install"],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, ...fenceEnv(), DG_HOME: dgHome, PATH: "" },
				},
			);

			expect(run.exitCode, run.stderr.toString()).toBe(0);
			expect(
				existsSync(join(dgHome, "config", "fish", "completions", "dg.fish")),
			).toBe(true);
		});
	},
);

posix("doctor completion check files", () => {
	const [files] = completionChecks;

	function doctorContext() {
		const ctx = createContext({
			home: seams.home,
			env: { HOME: seams.home, PATH: "" },
		});
		return { ctx, bin: ctx.paths.binDir };
	}

	test("reports a dg completion file that is missing, like one of dg-skills, when <bin>/dg is the dg link", async () => {
		const { ctx, bin } = doctorContext();
		linkDg(bin, ctx.paths.dataDir);
		const all = { ...seams, binDir: bin };
		writeCompletions(all, () => undefined);
		for (const file of dgFiles(all)) rmSync(file.path);

		const result = await files?.run(ctx);

		expect(result?.status).toBe("warn");
		expect(result?.detail).toContain("3 completion file(s) missing");
		for (const file of dgFiles(all))
			expect(result?.detail).toContain(file.path);
		expect(result?.fix).toBe("dg completion --install");
	});

	test("reports a stale dg completion file when <bin>/dg is the dg link", async () => {
		const { ctx, bin } = doctorContext();
		linkDg(bin, ctx.paths.dataDir);
		const all = { ...seams, binDir: bin };
		writeCompletions(all, () => undefined);
		const [first] = dgFiles(all);
		writeFileSync(first?.path ?? "", "old");

		const result = await files?.run(ctx);

		expect(result?.status).toBe("warn");
		expect(result?.detail).toContain("1 completion file(s) out of date");
		expect(result?.detail).toContain(first?.path ?? "");
	});

	test("expects no dg file and reports nothing for it when <bin>/dg is a file of a different tool", async () => {
		const { ctx, bin } = doctorContext();
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), FOREIGN);
		writeCompletions({ ...seams, binDir: bin }, () => undefined);

		const result = await files?.run(ctx);

		expect(completionFiles({ ...seams, binDir: bin })).toEqual([]);
		expect(result?.status).toBe("ok");
	});

	test("reports the dg files and the launcher as two warnings before the first install of the new release, and one install repairs both", async () => {
		const { ctx, bin } = doctorContext();
		linkDg(bin, ctx.paths.dataDir);
		const all = { ...seams, binDir: bin };
		writeCompletions(all, () => undefined);
		for (const file of dgFiles(all)) rmSync(file.path);
		expect((await files?.run(ctx))?.status).toBe("warn");

		writeCompletions(all, () => undefined);

		expect((await files?.run(ctx))?.status).toBe("ok");
		expect(completionFiles(all).map(completionState)).toEqual(
			Array(3).fill("current"),
		);
	});
});
