import { protectedPushReason } from "@dg/common";
import { runCapture } from "@dg/common/node";
import { runNative } from "./process";
import { verifyBuild } from "./verify";

class GitFailure extends Error {
	constructor(readonly status: number) {
		super(`Git exited ${status}`);
	}
}

async function resolveUpstream(
	capture: (args: string[]) => Promise<{ status: number; stdout: string }>,
	branch: string,
): Promise<{ remote: string; ref: string } | null> {
	const read = async (key: string) => {
		const result = await capture(["config", "--get", `branch.${branch}.${key}`]);
		return result.status === 0 ? result.stdout.trim() : "";
	};
	const remote = await read("remote");
	const ref = await read("merge");
	return remote && ref ? { remote, ref } : null;
}

/** Run the catchup workflow; imports and help never inspect the working tree. */
export async function main(argv: string[]): Promise<number> {
	let push = true;
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			console.log(
				"Usage: dg-skills catchup [--push | --no-push]\n\nRebase onto origin's default branch, verify build/tests, and push with --force-with-lease.\n\n  --push     Push after verification (default; compatibility option)\n  --no-push  Skip pushing\n  --help, -h Show this help",
			);
			return 0;
		}
		if (arg === "--push") push = true;
		else if (arg === "--no-push") push = false;
		else {
			process.stderr.write(`Unknown flag: ${arg}\n`);
			return 1;
		}
	}
	const cwd = process.cwd();
	const capture = (args: string[]) =>
		runCapture("git", args, { cwd, stdin: null }).catch((error: unknown) => {
			const code =
				error instanceof Error
					? (error as NodeJS.ErrnoException).code
					: undefined;
			if (code !== "ENOENT" && code !== "EACCES") throw error;
			process.stderr.write(`git: ${(error as Error).message}\n`);
			throw new GitFailure(code === "ENOENT" ? 127 : 126);
		});
	const query = async (args: string[]) => {
		const result = await capture(args);
		process.stderr.write(result.stderr);
		if (result.status !== 0) throw new GitFailure(result.status);
		return result.stdout.trimEnd();
	};
	const native = (args: string[]) => runNative("git", args, cwd);
	const checked = async (args: string[]) => {
		const status = await native(args);
		if (status !== 0) throw new GitFailure(status);
	};
	let stashed = false;
	const restore = async () => {
		console.log("==> Restoring stash...");
		const status = await native(["stash", "pop"]);
		if (status === 0) stashed = false;
		return status;
	};
	try {
		const before = await query(["rev-parse", "HEAD"]);
		const branch = await query(["branch", "--show-current"]);
		if (!branch) {
			process.stderr.write(
				"catchup: HEAD is detached; check out a branch first.\n",
			);
			return 1;
		}
		if ((await capture(["diff", "--quiet", "HEAD"])).status !== 0) {
			console.log("==> Stashing uncommitted changes...");
			await checked(["stash", "push", "-m", "catchup-auto-stash"]);
			stashed = true;
		}
		const symbolic = await capture([
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
		]);
		let base = symbolic.stdout
			.trimEnd()
			.replace(/^refs\/remotes\/origin\//, "");
		if (!base)
			base =
				(await capture(["rev-parse", "--verify", "origin/main"])).status === 0
					? "main"
					: "master";
		console.log(`==> Default branch: ${base}`);
		console.log(`==> Fetching origin/${base}...`);
		await checked(["fetch", "origin", base]);
		const remote = `refs/remotes/origin/${base}`;
		const count = await query(["rev-list", "--count", `HEAD..${remote}`]);
		if (Number(count) === 0) {
			console.log(`==> Already up to date with origin/${base}.`);
			return stashed ? await restore() : 0;
		}
		console.log(`==> ${count} new commit(s) from origin/${base}:`);
		await checked(["log", "--oneline", "-n", "20", `HEAD..${remote}`]);
		console.log(`==> Rebasing onto origin/${base}...`);
		const fork = await query(["merge-base", "HEAD", remote]);
		if (
			(await native([
				"rebase",
				"--onto",
				remote,
				fork,
				branch,
				"--no-reapply-cherry-picks",
			])) !== 0
		) {
			console.log(
				"==> CONFLICT detected during rebase!\n==> Conflicting files:",
			);
			const conflicts = await capture([
				"diff",
				"--name-only",
				"--diff-filter=U",
			]);
			process.stdout.write(conflicts.stdout);
			console.log("\n==> Aborting rebase to let you investigate.");
			await checked(["rebase", "--abort"]);
			if (stashed) await restore();
			return 1;
		}
		console.log("==> Rebase successful.");
		if (stashed && (await restore()) !== 0) {
			console.log("==> WARNING: stash pop had conflicts.");
			return 1;
		}
		console.log("==> Verifying build...");
		if ((await verifyBuild(cwd)) !== 0) {
			console.log("==> VERIFICATION FAILED after rebase.");
			return 1;
		}
		const after = await query(["rev-parse", "HEAD"]);
		let reason = "";
		let pushed = "NO";
		const upstream = await resolveUpstream(capture, branch);
		const blocked = protectedPushReason(
			upstream?.ref.replace(/^refs\/heads\//, "") ?? branch,
			base,
		);
		if (!push) reason = "--no-push flag set";
		else if (blocked) reason = blocked;
		else if (before === after)
			reason = "rebase did not rewrite history (HEAD unchanged)";
		else if (!upstream)
			reason = `no upstream configured for '${branch}'`;
		else {
			console.log(`==> Pushing '${branch}' with --force-with-lease...`);
			if (
				(await native([
					"push",
					"--force-with-lease",
					upstream.remote,
					`HEAD:${upstream.ref}`,
				])) !== 0
			) {
				console.log(
					"\n==> PUSH FAILED. The remote may have moved since you last fetched,\n    or --force-with-lease refused to overwrite unexpected commits.\n    Your local rebase succeeded; inspect 'git status' and\n    'git log @{upstream}..HEAD' before retrying manually.",
				);
				return 1;
			}
			pushed = "YES";
		}
		console.log(
			`\n==> Catchup complete!\n    Branch: ${branch}\n    Rebased onto origin/${base} (fork-point: ${fork.slice(0, 8)})\n    Pushed: ${pushed}`,
		);
		if (reason) console.log(`    Push skipped: ${reason}`);
		return 0;
	} catch (error) {
		if (error instanceof GitFailure) return error.status;
		throw error;
	} finally {
		if (stashed)
			process.stderr.write(
				"catchup: your uncommitted changes are in the stash 'catchup-auto-stash'; run 'git stash pop' to restore them.\n",
			);
	}
}
