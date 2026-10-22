/** The four verbs every sync target supports, matching the ported legacy tools. */
export type SyncMode = "probe" | "dry-run" | "apply" | "verify";

export const SYNC_MODES: readonly SyncMode[] = ["probe", "dry-run", "apply", "verify"];

export type SyncTargetId = "copilot" | "opencode" | "codex" | "claude" | "pi" | "grok";

export const SYNC_TARGET_IDS: readonly SyncTargetId[] = [
	"copilot",
	"opencode",
	"codex",
	"claude",
	"pi",
	"grok",
];

/** Resolved filesystem/process context a target runs against; every field is overridable for tests. */
export interface SyncContext {
	home: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Accumulated human-readable output; `ok` drives the dispatcher's exit status. */
export class SyncReport {
	readonly lines: string[] = [];
	readonly warnings: string[] = [];
	ok = true;

	info(line: string): void {
		this.lines.push(line);
	}

	warn(line: string): void {
		this.warnings.push(line);
		this.lines.push(`WARN: ${line}`);
	}

	fail(line: string): void {
		this.ok = false;
		this.warn(line);
	}

	merge(other: SyncReport): void {
		this.lines.push(...other.lines);
		this.warnings.push(...other.warnings);
		if (!other.ok) this.ok = false;
	}

	render(): string {
		return this.lines.join("\n");
	}
}

/** A parsed flag set for one target invocation; `error` short-circuits to a usage failure. */
export interface ParsedFlags<F> {
	flags?: F;
	error?: string;
}

/** One sync target's full verb set. Each target owns its own flags and destination layout. */
export interface SyncTarget<F = Record<string, never>> {
	readonly id: SyncTargetId;
	readonly usage: string;
	parseFlags(argv: string[]): ParsedFlags<F>;
	probe(ctx: SyncContext, flags: F): Promise<SyncReport>;
	dryRun(ctx: SyncContext, flags: F): Promise<SyncReport>;
	apply(ctx: SyncContext, flags: F): Promise<SyncReport>;
	verify(ctx: SyncContext, flags: F): Promise<SyncReport>;
}
