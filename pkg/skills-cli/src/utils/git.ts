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
	return result.stdout.toString().trim();
}

/** Return the shared ancestor of HEAD and the supplied ref; unresolved refs reject. */
export async function mergeBase(ref: string): Promise<string> {
	const result = await git`merge-base HEAD ${ref}`;
	return result.stdout.toString().trim();
}

/** Include both tracked changes and untracked files when checking working-tree status. */
export async function isDirty(): Promise<boolean> {
	const result = await git`status --porcelain`;
	return result.stdout.toString().trim().length > 0;
}

/** Prefer local main/master, then origin/HEAD, falling back to main when no default resolves. */
export async function baseBranch(): Promise<string> {
	const checkRef = async (ref: string): Promise<boolean> => {
		try {
			await git`show-ref --verify --quiet ${ref}`;
			return true;
		} catch {
			return false;
		}
	};

	if (await checkRef("refs/heads/main")) return "main";
	if (await checkRef("refs/heads/master")) return "master";

	try {
		const result = await git`symbolic-ref --short refs/remotes/origin/HEAD`;
		const remote = result.stdout.toString().trim();
		if (remote.startsWith("origin/")) return remote.slice("origin/".length);
	} catch {
		// no remote HEAD configured
	}

	return "main";
}

/** Resolve the base SHA for reshape operations.
 *
 * When overrideRef is given, resolve it via `git rev-parse` — but if the result is not an
 * ancestor of HEAD, fall back to its merge-base with HEAD. A base HEAD does not descend from is
 * never what a reshape wants: `apply` soft-resets to the base, so recommitting against a moved
 * branch tip silently reverts whatever landed on it in the meantime. This needs nothing unusual
 * to hit — pass `--base origin/main`, have someone push to main between gather and apply, and the
 * literal reading changes meaning underneath you. The file-set check catches it after the fact;
 * merge-basing stops it being a near-miss at all.
 *
 * Otherwise, compute merge-base with the remote-tracking default branch so a
 * stale local main never silently widens the reshape range.  Falls back to
 * the local branch merge-base only when no origin remote is present.
 *
 * Emits a one-line stderr warning if the local default branch and its
 * remote-tracking ref have diverged. */
export async function resolveBaseSha(overrideRef?: string): Promise<string> {
	if (overrideRef) {
		const result = await git`rev-parse ${overrideRef}`;
		const sha = result.stdout.toString().trim();
		try {
			await git`merge-base --is-ancestor ${sha} HEAD`;
			return sha;
		} catch {
			// Not an ancestor of HEAD -- the ref moved on, or never was a fork point.
		}
		const forkPoint = await mergeBase(sha);
		process.stderr.write(
			`meaningful: warning: --base ${overrideRef} (${sha.slice(0, 8)}) is not an ancestor of HEAD; ` +
				`using merge-base ${forkPoint.slice(0, 8)} instead\n`,
		);
		return forkPoint;
	}

	// Determine remote default branch name.
	let defaultBranch = "main";
	try {
		const r = await git`symbolic-ref --short refs/remotes/origin/HEAD`;
		const ref = r.stdout.toString().trim();
		if (ref.startsWith("origin/")) defaultBranch = ref.slice("origin/".length);
	} catch {
		// fall through — will try origin/main then origin/master
	}

	// Check whether origin remote exists at all.
	let hasOrigin = false;
	try {
		await git`ls-remote --exit-code --heads origin`;
		hasOrigin = true;
	} catch {
		// no origin remote
	}

	if (!hasOrigin) {
		// No remote — fall back to local merge-base.
		const local = await baseBranch();
		return mergeBase(local);
	}

	const remoteRef = `origin/${defaultBranch}`;

	// Warn if local branch lags remote.
	try {
		const localSha = (await git`rev-parse refs/heads/${defaultBranch}`).stdout.toString().trim();
		const remoteSha = (await git`rev-parse ${remoteRef}`).stdout.toString().trim();
		if (localSha !== remoteSha) {
			process.stderr.write(
				`meaningful: warning: local ${defaultBranch} differs from ${remoteRef}; using remote ref for base\n`,
			);
		}
	} catch {
		// local branch may not exist — that's fine, we use the remote ref
	}

	return mergeBase(remoteRef);
}
