import { readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { type DgPaths } from "./dg-paths";
import { writeFileAtomic } from "./fs";
import {
	blockedText,
	destOf,
	DETACHED_PREFIX,
	type LayoutEntry,
	type LayoutHooks,
	type LayoutResult,
	type LayoutSeams,
	legacyNames,
	LAYOUT_TABLE,
	isMoveEntry,
	type MoveEntry,
	type Outcome,
	type StopKey,
	type StopResult,
	PENDING_FILE,
	placeOf,
	resolveSeams,
	sourcesOf,
} from "./layout";
import { pidAlive } from "./plugin-cache";
import { folderUnused } from "./sqlite-unused";
import { moveVerified, removeSource, removeTree, setAsideUnusedRoot, treeContained } from "./tree-copy";

type Pending = { name: string; from: string; to: string };

type Facts = {
	present: boolean;
	from: string;
	sources: readonly string[];
	dest: string;
	to: string;
	live: boolean;
	targetPresent: boolean;
	targetUnused: boolean;
	records: readonly Pending[];
};

export type Snapshot = {
	legacyHome: string;
	facts: Readonly<Record<string, Facts>>;
	detached: readonly string[];
	pending: readonly Pending[];
};

type Action =
	| { kind: "absent" }
	| { kind: "skip" }
	| { kind: "keepUsed" }
	| { kind: "retryPending" }
	| { kind: "block"; reason: "live-writer" | "no-hook" }
	| { kind: "move"; stop?: StopKey }
	| { kind: "setAside"; stop?: StopKey };

type Step = {
	name: string;
	rel: string;
	from: string;
	sources: readonly string[];
	listed: boolean;
	dest: string;
	to: string;
	liveDir?: string;
	verify?: "phone.verify";
	asideMark?: string;
	records: readonly Pending[];
	action: Action;
};

export type LayoutPlan = {
	legacyHome: string;
	steps: readonly Step[];
	sweep: readonly string[];
	pending: readonly Pending[];
};

const printed = new Set<string>();

const MUTATING: ReadonlySet<Action["kind"]> = new Set(["move", "setAside", "retryPending"]);
const UNMOVED_ACTIONS: ReadonlySet<Action["kind"]> = new Set(["block", "keepUsed", "skip"]);
const UNMOVED_OUTCOMES: ReadonlySet<Outcome["kind"]> = new Set(["kept", "failed", "blocked", "scheduled"]);

const exists = (seams: LayoutSeams, path: string): boolean => {
	try {
		seams.lstat(path);
		return true;
	} catch {
		return false;
	}
};

function pidFileLive(file: string): boolean {
	try {
		const text = readFileSync(file, "utf8").trim();
		return pidAlive(Number(text.startsWith("{") ? (JSON.parse(text) as { pid?: unknown }).pid : text));
	} catch {
		return false;
	}
}

function expandPattern(dir: string, segments: readonly string[], readdir: LayoutSeams["readdir"]): string[] {
	const [head, ...rest] = segments;
	if (head === undefined) return [dir];
	if (!head.includes("*")) return expandPattern(join(dir, head), rest, readdir);
	const [prefix = "", suffix = ""] = head.split("*");
	return legacyNames(dir, readdir)
		.filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
		.flatMap((name) => expandPattern(join(dir, name), rest, readdir));
}

/** True when a pid file under the legacy home, named by a path whose segments may hold one star each, names a running process. */
export function isLive(
	legacyHome: string,
	pattern: string,
	readdir: LayoutSeams["readdir"] = (path) => readdirSync(path),
): boolean {
	return expandPattern(legacyHome, pattern.split("/"), readdir).some(pidFileLive);
}

function entryNamed(record: { from: string; to: string }, paths: DgPaths, hooks: LayoutHooks): string | undefined {
	return LAYOUT_TABLE.filter(isMoveEntry).find((entry) => {
		const dest = destOf(entry, paths, hooks);
		return (
			sourcesOf(entry, paths.legacyHome).includes(record.from) &&
			(record.to === dest || record.to === join(dest, basename(record.from)))
		);
	})?.name;
}

function readPending(paths: DgPaths, hooks: LayoutHooks): Pending[] {
	try {
		const records: unknown = JSON.parse(readFileSync(join(paths.legacyHome, PENDING_FILE), "utf8"));
		if (!Array.isArray(records)) return [];
		return records.flatMap((record): Pending[] => {
			if (typeof record?.from !== "string" || typeof record?.to !== "string") return [];
			const ends = { from: record.from, to: record.to };
			const name = typeof record.name === "string" ? record.name : entryNamed(ends, paths, hooks);
			return name === undefined ? [] : [{ ...ends, name }];
		});
	} catch {
		return [];
	}
}

function writePending(legacyHome: string, records: readonly Pending[]): void {
	const file = join(legacyHome, PENDING_FILE);
	if (records.length === 0) rmSync(file, { force: true });
	else writeFileAtomic(file, JSON.stringify(records), 0o600);
}

function targetUnused(entry: MoveEntry, dest: string): boolean {
	if (entry.unused === undefined) return false;
	return entry.unused === "folder" ? folderUnused(dest) : folderUnused(dest, entry.unused.sqlite);
}

function factsOf(
	entry: MoveEntry,
	{ paths, hooks, seams, pending }: { paths: DgPaths; hooks: LayoutHooks; seams: LayoutSeams; pending: readonly Pending[] },
): Facts {
	const all = sourcesOf(entry, paths.legacyHome);
	const dest = destOf(entry, paths, hooks);
	const to = placeOf(entry, dest);
	const from = all[0] ?? "";
	const present = exists(seams, from);
	const named = pending.filter((record) => record.name === entry.name);
	const records = present ? named : named.filter((record) => exists(seams, record.from));
	const base = { present: present || records.length > 0, from, sources: present ? all.filter((source) => exists(seams, source)) : [], dest, to };
	const live = (present || records.length > 0) && entry.live !== undefined && isLive(paths.legacyHome, entry.live, seams.readdir);
	if (!present) return { ...base, live, targetPresent: false, targetUnused: false, records };
	const ready = entry.needsKey === undefined || hooks[entry.needsKey] !== undefined;
	const targetPresent = ready && exists(seams, to);
	return {
		...base,
		live,
		targetPresent,
		targetUnused: targetPresent && targetUnused(entry, dest),
		records,
	};
}

/** Reads the legacy tree and the targets once; the plan is pure over what this returns. */
export function snapshot(paths: DgPaths, hooks: LayoutHooks): Snapshot {
	const seams = resolveSeams(hooks);
	const pending = readPending(paths, hooks);
	return {
		legacyHome: paths.legacyHome,
		facts: Object.fromEntries(
			LAYOUT_TABLE.filter(isMoveEntry).map((entry) => [entry.name, factsOf(entry, { paths, hooks, seams, pending })]),
		),
		detached: legacyNames(paths.legacyHome, seams.readdir)
			.filter((name) => name.startsWith(DETACHED_PREFIX))
			.map((name) => join(paths.legacyHome, name)),
		pending,
	};
}

const missingKey = (entry: MoveEntry, hooks: LayoutHooks): boolean =>
	[entry.verify, entry.needsKey].some((key) => key !== undefined && hooks[key] === undefined) ||
	(entry.launcherBound === true && hooks.launchers === undefined);

function decide(entry: MoveEntry, facts: Facts, hooks: LayoutHooks): Action {
	if (!facts.present) return { kind: "absent" };
	if (facts.records.length > 0) return facts.live ? { kind: "block", reason: "live-writer" } : { kind: "retryPending" };
	if (facts.targetPresent && !facts.targetUnused) return { kind: "keepUsed" };
	const stop = entry.stop !== undefined && hooks[entry.stop] !== undefined ? entry.stop : undefined;
	if (facts.live && stop === undefined) return { kind: "block", reason: "live-writer" };
	if (missingKey(entry, hooks)) return { kind: "block", reason: "no-hook" };
	return { kind: facts.targetPresent ? "setAside" : "move", stop: facts.live ? stop : undefined };
}

const nestedUnder = (rel: string, parent: string): boolean => rel.startsWith(`${parent}/`);

function planEntry(
	entry: MoveEntry,
	{ facts, hooks, done, legacyHome }: { facts: Facts; hooks: LayoutHooks; done: readonly Step[]; legacyHome: string },
): Step {
	const rel = [entry.from].flat()[0] ?? "";
	const decided = decide(entry, facts, hooks);
	const childKept = done.some((step) => nestedUnder(step.rel, rel) && UNMOVED_ACTIONS.has(step.action.kind));
	return {
		name: entry.name,
		rel,
		from: facts.from,
		sources: facts.sources,
		listed: typeof entry.from !== "string",
		dest: facts.dest,
		to: facts.to,
		liveDir: entry.live === undefined ? undefined : join(legacyHome, dirname(entry.live)),
		verify: entry.verify,
		asideMark: entry.asideMark,
		records: facts.records,
		action: childKept && (decided.kind === "move" || decided.kind === "setAside") ? { kind: "skip" } : decided,
	};
}

/** Decides one action per entry from a snapshot; it calls no side-effect seam. */
export function planLayout(table: readonly LayoutEntry[], snap: Snapshot, hooks: LayoutHooks): LayoutPlan {
	const steps = table.filter(isMoveEntry).reduce<readonly Step[]>((done, entry) => {
		const facts = snap.facts[entry.name];
		return facts ? [...done, planEntry(entry, { facts, hooks, done, legacyHome: snap.legacyHome })] : done;
	}, []);
	return { legacyHome: snap.legacyHome, steps, sweep: snap.detached, pending: snap.pending };
}

const orphaned = (plan: LayoutPlan): boolean =>
	plan.pending.some((record) => !plan.steps.some((step) => step.records.includes(record)));

/** True when the plan moves, sets aside or retries something, or drops a pending record, so it needs the lock. */
export const mutates = (plan: LayoutPlan): boolean =>
	plan.steps.some((step) => MUTATING.has(step.action.kind)) || orphaned(plan);

type Applied = { outcome: Outcome; pending: readonly Pending[] };

type Detail = Outcome extends infer Each ? (Each extends Outcome ? Omit<Each, "from" | "to"> : never) : never;

type BlockedOutcome = Extract<Outcome, { kind: "blocked" }>;

type Context = {
	hooks: LayoutHooks;
	seams: LayoutSeams;
	say: (line: string) => void;
	stop: (key: StopKey, legacyDir: string) => Promise<StopResult>;
	done: Readonly<Record<string, Outcome>>;
	steps: readonly Step[];
};

const ends = (step: Step) => ({ from: step.from, to: step.to });

const settled = (step: Step, detail: Detail): Applied => ({
	outcome: { ...ends(step), ...detail } as Outcome,
	pending: [],
});

function blockedOutcome(step: Step, reason: BlockedOutcome["reason"], refused = false): BlockedOutcome {
	const facts = { ...ends(step), reason, ...(refused ? { refused: true as const } : {}) };
	return { ...facts, kind: "blocked", fix: blockedText(facts) };
}

const holdsFile = (root: string, file: string): boolean => {
	const rel = relative(root, file);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

const runningInside = (seams: LayoutSeams, root: string): boolean => {
	const files = [seams.entryFile(), seams.execPath()].filter((file) => file !== undefined);
	return files.some((file) => holdsFile(resolve(root), resolve(file)) || holdsFile(realOr(root), realOr(file)));
};

function retryRecord(record: Pending, { seams, say }: Context): "removed" | "incomplete" | "held" {
	if (!exists(seams, record.from)) return "removed";
	if (!exists(seams, record.to) || !treeContained(record.from, record.to)) {
		say(`dg: kept ${record.from}; its copy at ${record.to} no longer holds every file`);
		return "incomplete";
	}
	if (runningInside(seams, record.from) || !removeSource(record.from)) return "held";
	say(`dg: removed ${record.from}; its copy at ${record.to} was complete`);
	return "removed";
}

function retry(step: Step, context: Context): Applied {
	const states = step.records.map((record) => ({ record, state: retryRecord(record, context) }));
	const held = states.filter(({ state }) => state === "held").map(({ record }) => record);
	if (states.some(({ state }) => state === "incomplete")) return { ...settled(step, { kind: "kept", reason: "copy-incomplete" }), pending: held };
	if (held.length > 0) return { ...settled(step, { kind: "scheduled" }), pending: held };
	return settled(step, { kind: "moved", stopped: false });
}

function scheduledRecords(step: Step, seams: LayoutSeams): Pending[] {
	return step.sources
		.filter((source) => exists(seams, source))
		.map((source) => ({ name: step.name, from: source, to: step.listed ? join(step.dest, basename(source)) : step.dest }));
}

function setAside(step: Step, { seams, say }: Context): { asideTo: string } | { error: string } {
	try {
		const asideTo = setAsideUnusedRoot(step.dest, seams.now());
		say(`dg: set aside unused ${step.dest} as ${asideTo}; dg-skills clean removes it`);
		return { asideTo };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const line = `dg: kept ${step.from}; setting aside ${step.dest} failed: ${reason}`;
		say(line);
		return { error: line };
	}
}

function markAside(dest: string, mark: string, say: Context["say"]): void {
	try {
		writeFileSync(join(dest, mark), "", { mode: 0o600 });
	} catch (error) {
		say(`dg: could not write ${join(dest, mark)}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function copyAcross(step: Step, { hooks, seams, say }: Context, placed: { stopped: boolean; asideTo?: string }): Applied {
	const reported: string[] = [];
	const result = moveVerified(step.listed ? step.sources : step.from, step.dest, {
		log: (line) => {
			reported.push(line);
			say(line);
		},
		verify: step.verify ? hooks[step.verify] : undefined,
		inUse: (source) => runningInside(seams, source),
	});
	if (result === "failed") return settled(step, { kind: "failed", error: reported.at(-1) ?? "" });
	if (result === "kept") return settled(step, { kind: "kept", reason: "target-used" });
	if (placed.asideTo !== undefined && step.asideMark !== undefined) markAside(step.dest, step.asideMark, say);
	if (result === "scheduled") return { ...settled(step, { kind: "scheduled" }), pending: scheduledRecords(step, seams) };
	return settled(
		step,
		placed.asideTo === undefined
			? { kind: "moved", stopped: placed.stopped }
			: { kind: "setAside", asideTo: placed.asideTo, stopped: placed.stopped },
	);
}

async function move(step: Step, action: Extract<Action, { kind: "move" | "setAside" }>, context: Context): Promise<Applied> {
	const stopResult = action.stop && step.liveDir ? await context.stop(action.stop, step.liveDir) : undefined;
	if (stopResult === "still-running" || stopResult === "refused") {
		const outcome = blockedOutcome(step, "live-writer", stopResult === "refused");
		if (stopResult === "still-running") context.say(outcome.fix);
		return { outcome, pending: step.records };
	}
	const stopped = stopResult === "stopped";
	if (action.kind === "move") return copyAcross(step, context, { stopped });
	const aside = setAside(step, context);
	return "error" in aside ? settled(step, { kind: "failed", error: aside.error }) : copyAcross(step, context, { stopped, ...aside });
}

async function applyStep(step: Step, context: Context): Promise<Applied> {
	const { action } = step;
	switch (action.kind) {
		case "absent":
			return settled(step, { kind: "absent" });
		case "skip":
			return settled(step, { kind: "kept", reason: "child-kept" });
		case "keepUsed":
			context.say(`dg: kept ${step.from}; ${step.to} already exists and holds data. dg-skills doctor reports both copies`);
			return settled(step, { kind: "kept", reason: "target-used" });
		case "block": {
			const outcome = blockedOutcome(step, action.reason);
			if (action.reason === "live-writer") context.say(outcome.fix);
			return { outcome, pending: step.records };
		}
		case "retryPending":
			return retry(step, context);
		case "move":
		case "setAside": {
			const childUnmoved = context.steps.some(
				(earlier) =>
					nestedUnder(earlier.rel, step.rel) && UNMOVED_OUTCOMES.has(context.done[earlier.name]?.kind ?? "absent"),
			);
			return childUnmoved ? settled(step, { kind: "kept", reason: "child-kept" }) : move(step, action, context);
		}
	}
}

function makeContext(plan: LayoutPlan, hooks: LayoutHooks): Context {
	const seams = resolveSeams(hooks);
	const stops = new Map<StopKey, Promise<StopResult>>();
	return {
		hooks,
		seams,
		say: (line) => {
			if (printed.has(line)) return;
			printed.add(line);
			seams.log(line);
		},
		stop: (key, legacyDir) => {
			const running = stops.get(key) ?? Promise.resolve(hooks[key]?.(legacyDir)).then((result) => result ?? "refused");
			stops.set(key, running);
			return running;
		},
		done: {},
		steps: plan.steps,
	};
}

/** Performs the plan in table order and returns the outcome of every entry; the pending file lists copies still to remove. */
export async function applyLayout(plan: LayoutPlan, hooks: LayoutHooks): Promise<LayoutResult> {
	const base = makeContext(plan, hooks);
	plan.sweep.forEach((path) => removeTree(path));
	const initial = { outcomes: {} as Record<string, Outcome>, pending: [] as readonly Pending[] };
	const { outcomes, pending } = await plan.steps.reduce(async (previous, step) => {
		const accumulated = await previous;
		const applied = await applyStep(step, { ...base, done: accumulated.outcomes });
		return {
			outcomes: { ...accumulated.outcomes, [step.name]: applied.outcome },
			pending: [...accumulated.pending, ...applied.pending],
		};
	}, Promise.resolve(initial));
	if (mutates(plan)) writePending(plan.legacyHome, pending);
	return outcomes as LayoutResult;
}
