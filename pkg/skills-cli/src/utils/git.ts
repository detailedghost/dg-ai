import { runCaptureBytes } from "@dg/common/node";
import { buildArgs } from "./shell-args";

/** Untrimmed process bytes with the successful exit status and a UTF-8 stdout convenience reader. */
export interface ShellOutput {
	exitCode: number;
	stdout: Buffer;
	stderr: Buffer;
	/** Decode stdout without trimming or changing the stored bytes. */
	text(): string;
}

// GH_DEBUG=api can leak tokens to stderr/stdout; redact before surfacing in messages.
const TOKEN_RE = new RegExp(
	["gh[a-z]_[A-Za-z0-9]{20,}", "github_pat_[A-Za-z0-9_]{20,}", "gl(?:pat|dt|rt|cbt|ptt|soat)-[A-Za-z0-9]{15,}"].join(
		"|",
	),
	"g",
);
/** Replace recognized GitHub/GitLab token patterns before surfacing diagnostics; not a general secret scrubber. */
export function redactTokens(s: string): string {
	return s.replace(TOKEN_RE, "<redacted-token>");
}

/** Preserve raw failure streams/status while redacting recognized tokens from the human-readable message. */
export class ShellError extends Error {
	constructor(
		public readonly bin: string,
		public readonly args: string[],
		public readonly exitCode: number,
		public readonly stdout: Buffer,
		public readonly stderr: Buffer,
	) {
		const stderrLine = redactTokens(stderr.toString().split("\n")[0] ?? "");
		const stdoutLine = redactTokens(stdout.toString().split("\n")[0] ?? "");
		const head = (stderrLine || stdoutLine).slice(0, 200);
		const argsStr = redactTokens(args.join(" "));
		super(`${bin} ${argsStr} exited ${exitCode}${head ? `: ${head}` : ""}`);
		this.name = "ShellError";
	}
}

/** Supply stdin explicitly; omitted input ignores stdin, while an empty string keeps a closed pipe. */
export interface RunShellOptions {
	input?: string;
}

/** Execute argv without a shell; preserve exact output bytes and throw ShellError on nonzero exit. */
export async function runShell(bin: string, args: string[], opts?: RunShellOptions): Promise<ShellOutput> {
	const { status: exitCode, stdout, stderr } = await runCaptureBytes(bin, args, {
		stdin: opts?.input ?? null,
	});
	if (exitCode !== 0) {
		throw new ShellError(bin, args, exitCode, stdout, stderr);
	}
	return {
		exitCode,
		stdout,
		stderr,
		text() {
			return stdout.toString();
		},
	};
}

/** Build argv from template values without shell expansion, with optional per-call stdin. */
export interface ShellTag {
	(strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellOutput>;
	/** Returns a new tagged-template function bound to `input` on stdin for one call. */
	withInput(input: string): (strings: TemplateStringsArray, ...values: unknown[]) => Promise<ShellOutput>;
}

/** Bind a binary to the literal/interpolated argv builder; no process starts until the tag is called. */
export function makeShellTag(bin: string): ShellTag {
	const tag = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellOutput> => {
		const args = buildArgs(strings, values);
		return runShell(bin, args);
	}) as ShellTag;

	tag.withInput = (input: string) => {
		return (strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellOutput> => {
			const args = buildArgs(strings, values);
			return runShell(bin, args, { input });
		};
	};

	return tag;
}

/** Run git through the argv-safe tag, throwing ShellError on command failure. */
export const git = makeShellTag("git");
/** Run gh through the argv-safe tag; provider adapters separately support executable overrides. */
export const gh = makeShellTag("gh");

/** Read the current branch name; a detached checkout retains Git's HEAD result. */
export async function currentBranch(): Promise<string> {
	const result = await git`rev-parse --abbrev-ref HEAD`;
	return result.text().trim();
}

/** Return the shared ancestor of HEAD and the supplied ref; unresolved refs reject. */
export async function mergeBase(ref: string): Promise<string> {
	const result = await git`merge-base HEAD ${ref}`;
	return result.text().trim();
}

/** Include both tracked changes and untracked files when checking working-tree status. */
export async function isDirty(): Promise<boolean> {
	const result = await git`status --porcelain`;
	return result.text().trim().length > 0;
}

/** Prefer local main/master, then origin/HEAD, falling back to main when no default resolves. */
export async function baseBranch(): Promise<string> {
	if (await refExists("refs/heads/main")) return "main";
	if (await refExists("refs/heads/master")) return "master";

	try {
		const result = await git`symbolic-ref --short refs/remotes/origin/HEAD`;
		const remote = result.text().trim();
		if (remote.startsWith("origin/")) return remote.slice("origin/".length);
	} catch {
		// no remote HEAD configured
	}

	return "main";
}

async function refExists(ref: string): Promise<boolean> {
	try {
		await git`show-ref --verify --quiet ${ref}`;
		return true;
	} catch {
		return false;
	}
}

export async function remoteDefaultBranch(): Promise<string> {
	try {
		const ref = (await git`symbolic-ref --short refs/remotes/origin/HEAD`).text().trim();
		if (ref.startsWith("origin/")) return ref.slice("origin/".length);
	} catch {}
	if (await refExists("refs/remotes/origin/main")) return "main";
	if (await refExists("refs/remotes/origin/master")) return "master";
	return "main";
}

async function hasOriginRemote(): Promise<boolean> {
	try {
		await git`remote get-url origin`;
		return true;
	} catch {
		return false;
	}
}

/** Resolve the reshape base: the override ref or the remote default branch, never a commit HEAD does not descend from. */
export async function resolveBaseSha(overrideRef?: string): Promise<string> {
	if (overrideRef) {
		const sha = (await git`rev-parse --verify --end-of-options ${overrideRef}^{commit}`).text().trim();
		try {
			await git`merge-base --is-ancestor ${sha} HEAD`;
			return sha;
		} catch {}
		const forkPoint = await mergeBase(sha);
		process.stderr.write(
			`warning: --base ${overrideRef} (${sha.slice(0, 8)}) is not an ancestor of HEAD; ` +
				`using merge-base ${forkPoint.slice(0, 8)} instead\n`,
		);
		return forkPoint;
	}

	if (!(await hasOriginRemote())) return mergeBase(await baseBranch());

	const defaultBranch = await remoteDefaultBranch();
	const remoteRef = `origin/${defaultBranch}`;

	try {
		const localSha = (await git`rev-parse refs/heads/${defaultBranch}`).text().trim();
		const remoteSha = (await git`rev-parse ${remoteRef}`).text().trim();
		if (localSha !== remoteSha) {
			process.stderr.write(`warning: local ${defaultBranch} differs from ${remoteRef}; using remote ref for base\n`);
		}
	} catch {}

	return mergeBase(remoteRef);
}
