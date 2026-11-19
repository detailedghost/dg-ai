import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { COMPLETION_SHELLS, completionScript } from "@dg/common/completion";
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
import { writeShims } from "../src/install/shims";
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

const dgFiles = (given: Seams = seams) =>
	completionFiles(given).filter((file) => file.program === "dg");

posix("completionFiles with a dg launcher in the bin folder", () => {
	test("gives 12 files for dg and the three names of PROGRAM_NAMES in each of the three shells", () => {
		const files = completionFiles(seams);

		expect(files).toHaveLength(12);
		expect([...new Set(files.map((file) => file.program))]).toEqual([
			"dg",
			...PROGRAM_NAMES,
		]);
		expect(
			files.filter((file) => file.program === "dg").map((file) => file.shell),
		).toEqual([...COMPLETION_SHELLS]);
	});

	test("also gives dg when <bin>/dg is a dg launcher", () => {
		writeShims(seams.binDir, join(area, "root"), "linux", () => {});

		expect(completionFiles(seams)).toHaveLength(12);
	});

	test("leaves dg out when <bin>/dg is a file of a different tool", () => {
		writeFileSync(join(seams.binDir, "dg"), FOREIGN);

		const files = completionFiles(seams);

		expect(files).toHaveLength(9);
		expect(files.some((file) => file.program === "dg")).toBe(false);
	});

	test("writeCompletions writes each dg file equal to completionScript for its shell", () => {
		writeCompletions(seams, () => undefined);

		for (const file of dgFiles())
			expect(readFileSync(file.path, "utf8")).toBe(
				completionScript(file.shell, "dg"),
			);
	});

	test("writeCompletions writes the files of the three other programs and no dg file for a different tool", () => {
		writeFileSync(join(seams.binDir, "dg"), FOREIGN);
		const withDg = completionFiles({
			...seams,
			binDir: join(area, "empty-bin"),
		});

		const written = writeCompletions(seams, () => undefined);

		expect(written).toHaveLength(9);
		for (const file of withDg) {
			expect([file.path, existsSync(file.path)]).toEqual([
				file.path,
				file.program !== "dg",
			]);
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

posix(
	"dg-skills completion --install with a file of a different tool named dg",
	() => {
		test("writes the three other programs, writes no dg file and removes none", () => {
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
			).toBe(true);
			expect(
				existsSync(join(dgHome, "config", "fish", "completions", "dg.fish")),
			).toBe(false);
		});

		test("writes the dg files when the dg file is a dg launcher", () => {
			const dgHome = join(area, "dg-home");
			writeShims(join(dgHome, "bin"), join(dgHome, "data"), "linux", () => {});

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

	test("reports a dg completion file that is missing, like one of dg-skills, when <bin>/dg is a dg launcher", async () => {
		const { ctx, bin } = doctorContext();
		writeShims(bin, join(area, "root"), "linux", () => {});
		const all = { ...seams, binDir: bin };
		writeCompletions(all, () => undefined);
		for (const file of dgFiles(all)) rmSync(file.path);

		const result = await files?.run(ctx);

		expect(result?.status).toBe("warn");
		expect(result?.detail).toContain("3 completion file(s) missing");
		for (const file of dgFiles(all))
			expect(result?.detail).toContain(file.path);
		expect(result?.fix).toBe("dg-skills completion --install");
	});

	test("reports a stale dg completion file when <bin>/dg is a dg launcher", async () => {
		const { ctx, bin } = doctorContext();
		writeShims(bin, join(area, "root"), "linux", () => {});
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

		expect(result?.status).toBe("ok");
		expect(result?.detail).toContain(
			`for ${completionFiles({ ...seams, binDir: bin }).length / 3} programs`,
		);
	});

	test("reports the dg files and the launcher as two warnings before the first install of the new release, and one install repairs both", async () => {
		const { ctx, bin } = doctorContext();
		writeShims(bin, join(area, "root"), "linux", () => {});
		const all = { ...seams, binDir: bin };
		writeCompletions(all, () => undefined);
		for (const file of dgFiles(all)) rmSync(file.path);
		expect((await files?.run(ctx))?.status).toBe("warn");

		writeCompletions(all, () => undefined);

		expect((await files?.run(ctx))?.status).toBe("ok");
		expect(completionFiles(all).map(completionState)).toEqual(
			Array(12).fill("current"),
		);
	});
});
