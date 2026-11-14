import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheckResult, DoctorCheck } from "../doctor/types";
import { ok, warn } from "../doctor/types";
import { completionFiles, completionState, zshHint } from "./files";

const FIX = "dg-skills completion --install";

function readOr(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

export const completionChecks: DoctorCheck[] = [
	{
		id: "files",
		run(ctx): CheckResult {
			const files = completionFiles({ env: ctx.env, home: ctx.home });
			if (files.length === 0) return ok("shell completion is not used on Windows");
			const missing = files.filter((file) => completionState(file) === "missing");
			const stale = files.filter((file) => completionState(file) === "stale");
			if (missing.length > 0) return warn(`${missing.length} completion file(s) missing: ${missing.map((file) => file.path).join(", ")}`, FIX);
			if (stale.length > 0) return warn(`${stale.length} completion file(s) out of date: ${stale.map((file) => file.path).join(", ")}`, FIX);
			return ok(`bash, zsh and fish completion current for ${files.length / 3} programs`);
		},
	},
	{
		id: "zsh-fpath",
		run(ctx): CheckResult {
			const zsh = completionFiles({ env: ctx.env, home: ctx.home }).find((file) => file.shell === "zsh");
			const dir = zsh && dirname(zsh.path);
			const hint = dir && zshHint(dir, ctx.env);
			const rc = join(ctx.env.ZDOTDIR || ctx.home, ".zshrc");
			if (!dir || !hint || readOr(rc).includes(dir)) return ok("zsh finds the dg completion folder, or zsh is not installed");
			return { status: "info", detail: `${rc} does not name ${dir}; zsh loads dg completion only when that folder is on fpath`, fix: `add  fpath=(${dir} $fpath)  to ${rc} before compinit` };
		},
	},
];
