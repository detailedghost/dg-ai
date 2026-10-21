import { existsSync } from "node:fs";
import { fail, git, lastSegment, listWorktrees } from "./shared";

export const LIST_HELP = `worktree list [flags]

  List linked worktrees (excludes the main repo).
  STATUS is one of: clean, dirty, ahead N, no-upstream, MISSING.

Flags:
  -p, --porcelain   KEY=value blocks separated by blank lines (machine-readable).
  -h, --help        This help.
`;

async function statusOf(path: string): Promise<string> {
	if (!existsSync(path)) return "MISSING";
	const status = await git(path, ["status", "--porcelain"]);
	if (status.ok && status.stdout.trim()) return "dirty";
	const ahead = await git(path, ["rev-list", "--count", "@{u}..HEAD"]);
	if (!ahead.ok) return "no-upstream";
	const count = Number.parseInt(ahead.stdout, 10);
	return count > 0 ? `ahead ${count}` : "clean";
}

export async function list(args: string[]): Promise<number> {
	let porcelain = false;
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(LIST_HELP);
			return 0;
		}
		if (arg === "-p" || arg === "--porcelain") porcelain = true;
		else fail(`unknown arg for list: ${arg}`);
	}
	const [, ...linked] = await listWorktrees(process.cwd());
	const entries = linked.filter(
		(entry): entry is { path: string; branch: string } => entry.branch !== null,
	);
	if (porcelain) {
		process.stdout.write(
			entries
				.map(
					(entry) =>
						`SLUG=${lastSegment(entry.branch)}\nBRANCH=${entry.branch}\nPATH=${entry.path}\n\n`,
				)
				.join(""),
		);
		return 0;
	}
	const row = (slug: string, branch: string, status: string, path: string) =>
		`${slug.padEnd(24)} ${branch.padEnd(30)} ${status.padEnd(10)} ${path}\n`;
	process.stderr.write(row("SLUG", "BRANCH", "STATUS", "PATH"));
	for (const entry of entries)
		process.stdout.write(
			row(
				lastSegment(entry.branch),
				entry.branch,
				await statusOf(entry.path),
				entry.path,
			),
		);
	return 0;
}
