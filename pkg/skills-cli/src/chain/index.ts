// Renders and wires stacked PR/MR chains for the chain skill.
// Real dependencies (one layer per merge step) get the arrow-chain "Stack" block;
// independent siblings (no dependency at all) get a separate flat "Related PRs"
// list — arrows are never overloaded to mean "any order".

import { spawnSync } from "node:child_process";
import { getProvider } from "../provider/index";
import {
	notSupportedMessage,
	type Provider,
	ProviderError,
	type PrRef,
	parseRepoRef,
} from "../provider/types";
import { EXIT } from "../utils/legacy-command";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Mutually independent refs at one position in a dependency chain. */
export type Layer = string[];

/** Presentation and target options shared by rendering and provider updates. */
export interface RenderOptions {
	target?: string; // what the tip of the chain merges into, default "main"
	mark?: string; // ref to bold as "this PR"
	independent?: string[]; // bystander refs with no dependency relationship at all
	repo?: string; // "owner/repo" — prefixes bare numeric refs for cross-repo autolinking
}

/** A proposed retarget or a documented reason the base must stay unchanged. */
export interface BaseAction {
	ref: string;
	action: "retarget" | "skip";
	newBase?: string;
	reason?: string;
}

type GhExec = (
	args: string[],
	input?: string,
) => { status: number; stdout: string; stderr: string };

const NATIVE_STACK_UNSUPPORTED = "NATIVE_STACK_UNSUPPORTED";

// ── Ref parsing / formatting ─────────────────────────────────────────────────

/** Split a comma-separated layer, trimming whitespace and dropping empty refs. */
export function parseLayerArg(arg: string): Layer {
	return arg
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Qualify bare numbers for provider autolinking while preserving branch and explicit refs. */
export function formatRef(ref: string, repo?: string): string {
	if (ref.startsWith("#") || ref.includes("#")) return ref;
	if (/^\d+$/.test(ref)) return repo ? `${repo}#${ref}` : `#${ref}`;
	return ref;
}

function parseRefNumber(value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new ProviderError(
			"UNRESOLVED_BRANCH_REF",
			`"${value}" is a branch-name ref — plan/render-only; apply requires an existing PR/MR number`,
		);
	}
	return Number(value);
}

function toPrRef(ref: string): PrRef {
	if (!ref.includes("#")) return { number: parseRefNumber(ref) };
	const hashIndex = ref.lastIndexOf("#");
	const slug = ref.slice(0, hashIndex);
	const numeric = ref.slice(hashIndex + 1);
	if (slug.length === 0) return { number: parseRefNumber(numeric) };
	return { repo: parseRepoRef(slug), number: parseRefNumber(numeric) };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Render layers base-first as a single arrow-separated dependency line. */
export function renderChainLine(
	layers: Layer[],
	target = "main",
	repo?: string,
): string {
	const parts = layers.map((layer) =>
		layer.map((ref) => formatRef(ref, repo)).join(", "),
	);
	return [...parts, target].join(" → ");
}

function legendForLayer(
	layer: Layer,
	index: number,
	layers: Layer[],
	mark?: string,
	repo?: string,
): string[] {
	const isFirst = index === 0;
	const prevLayer = isFirst ? [] : layers[index - 1];
	const prevRefs = prevLayer.map((ref) => formatRef(ref, repo));

	return layer.map((rawRef) => {
		const ref = formatRef(rawRef, repo);
		const isMark = mark !== undefined && mark === rawRef;
		const note =
			isFirst && layers.length > 1
				? "merge first"
				: prevRefs.length > 0
					? `depends on ${prevRefs.join(", ")}`
					: "";
		const label = isMark ? `**${ref} — this PR**` : ref;
		return note ? `- ${label} — ${note}` : `- ${label}`;
	});
}

/** Render dependent layers and independent refs separately; a lone layer is independent. */
export function renderStack(layers: Layer[], opts: RenderOptions = {}): string {
	const { target = "main", mark, repo, independent = [] } = opts;
	let chainLayers = layers;
	let allIndependent = independent;
	if (layers.length <= 1) {
		allIndependent = [...(layers[0] ?? []), ...independent];
		chainLayers = [];
	}

	const sections: string[] = [];

	if (chainLayers.length > 0) {
		const chainLine = renderChainLine(chainLayers, target, repo);
		const legend = chainLayers.flatMap((layer, i) =>
			legendForLayer(layer, i, chainLayers, mark, repo),
		);
		sections.push(
			["## Stack (merge order)", "", chainLine, "", ...legend].join("\n"),
		);
	}

	if (allIndependent.length > 0) {
		const bullets = allIndependent.map((ref) => `- ${formatRef(ref, repo)}`);
		sections.push(
			[
				"## Related PRs (independent — mergeable in any order)",
				"",
				...bullets,
			].join("\n"),
		);
	}

	return sections.join("\n\n");
}

// ── Idempotent PR-body merge ──────────────────────────────────────────────────

const MARK_START = "<!-- /chain:start -->";
const MARK_END = "<!-- /chain:end -->";

/** Wrap generated Markdown in stable markers used by subsequent updates. */
export function wrapManaged(text: string): string {
	return `${MARK_START}\n${text}\n${MARK_END}`;
}

/** Replace the marked block or append it, preserving all surrounding body text. */
export function upsertManagedBlock(body: string, managedText: string): string {
	const start = body.indexOf(MARK_START);
	const end = body.indexOf(MARK_END);
	if (start !== -1 && end !== -1 && end > start) {
		const before = body.slice(0, start);
		const after = body.slice(end + MARK_END.length);
		return `${before}${managedText}${after}`;
	}
	const sep = body.trim().length > 0 ? "\n\n" : "";
	return `${body}${sep}${managedText}\n`;
}

// ── Base-retarget planning ────────────────────────────────────────────────────

/** Retarget only adjacent singleton layers; document wider dependencies without mutation. */
export function planBaseActions(layers: Layer[]): BaseAction[] {
	const actions: BaseAction[] = [];
	for (let i = 1; i < layers.length; i++) {
		const prev = layers[i - 1];
		const curr = layers[i];
		for (const ref of curr) {
			if (curr.length === 1 && prev.length === 1) {
				actions.push({ ref, action: "retarget", newBase: prev[0] });
			} else {
				const reason =
					prev.length > 1
						? `previous layer has ${prev.length} independent members — git branches take one base; base left as-is, dependency documented in body only`
						: `this layer has ${curr.length} members sharing a base — base left as-is, dependency documented in body only`;
				actions.push({ ref, action: "skip", reason });
			}
		}
	}
	return actions;
}

/** Render the body draft and proposed actions; native plans must already be resolved. */
export function renderPlan(
	layers: Layer[],
	opts: RenderOptions = {},
	native = false,
	nativePlan?: NativeStackPlan,
): string {
	const stackText = renderStack(layers, opts);
	const actions = layers.length > 1 ? planBaseActions(layers) : [];
	const actionLines = actions.length
		? actions.map((a) =>
				a.action === "retarget"
					? `  retarget ${a.ref} → base = head branch of ${a.newBase}`
					: `  skip ${a.ref} (${a.reason})`,
			)
		: ["  (no base retargets — fewer than two single-ref layers in a row)"];
	const lines = [
		stackText,
		"",
		"## Base-retarget plan (dry run — no gh calls made)",
		...actionLines,
	];
	if (native) {
		if (!nativePlan)
			throw new Error(
				"renderPlan: native=true requires a pre-resolved nativePlan",
			);
		lines.push(
			"",
			"## Native GitHub stack (--native, dry run — no gh calls made)",
		);
		lines.push(
			nativePlan.eligible
				? `  would run: gh ${(nativePlan.args as string[]).join(" ")}`
				: `  skip (${nativePlan.reason})`,
		);
	}
	return lines.join("\n");
}

// ── Native GitHub stack linking (gh stack link) ──────────────────────────────

/** Native-link eligibility and argv, with an explicit unsupported-provider signal. */
export interface NativeStackPlan {
	eligible: boolean;
	reason?: string; // set when eligible is false
	args?: string[]; // the `gh <args>` argv for `gh stack link`, set when eligible is true
	unsupported?: boolean;
}

/**
 * A native GitHub stack is strictly single-repo and strictly linear — one base
 * per PR, same shape planBaseActions already retargets for. Anything wider (a
 * fan-out layer, an explicit owner/repo#N ref, or a --repo override implying the
 * refs live outside the current repo) stays markdown-only: there's no single git
 * base to register it under, and `gh stack link` has no cross-repo flag.
 */
export function planNativeStack(
	layers: Layer[],
	opts: RenderOptions = {},
): NativeStackPlan {
	if (layers.length < 2) {
		return {
			eligible: false,
			reason: "need at least two layers to form a stack",
		};
	}
	if (layers.some((l) => l.length !== 1)) {
		return {
			eligible: false,
			reason:
				"a fan-out layer (multiple refs sharing a base) has no single git base — native stacks are strictly linear",
		};
	}
	if (opts.repo) {
		return {
			eligible: false,
			reason:
				"--repo implies refs outside the current repo — native stacks are single-repo only; re-run from within that repo, without --repo",
		};
	}
	const refs = layers.flat();
	if (refs.some((ref) => ref.includes("#"))) {
		return {
			eligible: false,
			reason:
				"an explicit owner/repo#N ref signals a cross-repo chain — native stacks are single-repo only",
		};
	}
	return {
		eligible: true,
		args: ["stack", "link", "--base", opts.target ?? "main", ...refs],
	};
}

/** Check provider capability before assessing whether the chain can be linked natively. */
export async function resolveNativeStackPlan(
	layers: Layer[],
	opts: RenderOptions = {},
): Promise<NativeStackPlan> {
	const provider = await getProvider();
	if (!provider.capabilities.nativeStacking) {
		return {
			eligible: false,
			reason: notSupportedMessage("--native stack linking"),
			unsupported: true,
		};
	}
	return planNativeStack(layers, opts);
}

/**
 * Requires an external extension providing `gh stack link` (historically installed
 * with `gh extension install github/gh-stack`) — a missing extension surfaces
 * as a nonzero exit with gh's own "unknown command" stderr, which we pass through
 * as-is rather than guessing at a nicer message.
 */
export function applyNativeStack(
	plan: NativeStackPlan,
	layers: Layer[],
	opts: RenderOptions = {},
): void {
	if (!plan.eligible) {
		process.stderr.write(`chain: skip native stack link — ${plan.reason}\n`);
		return;
	}
	const res = realGhExec(plan.args as string[]);
	if (res.status !== 0) {
		process.stderr.write(`chain: gh stack link failed: ${res.stderr}\n`);
	} else {
		process.stderr.write(
			`chain: linked native GitHub stack (${layers.flat().join(" → ")} → ${opts.target ?? "main"})\n`,
		);
	}
}

// ── gh execution (injectable for tests) ───────────────────────────────────────

const realGhExec: GhExec = (args, input) => {
	const proc = spawnSync(process.env.GH_BIN ?? "gh", args, {
		encoding: "utf8",
		input,
	});
	return {
		status: proc.status ?? 1,
		stdout: proc.stdout ?? "",
		stderr: proc.stderr ?? "",
	};
};

/** Layers carry PR/MR refs, but a base is a branch — resolve a numeric predecessor to its head branch. */
async function resolveBaseBranch(
	provider: Provider,
	ref: string,
): Promise<string> {
	if (!/^\d+$/.test(ref) && !ref.includes("#")) return ref;
	const pr = await provider.viewPullRequest(toPrRef(ref));
	return pr.headRefName;
}

/** Apply retargets sequentially, logging individual failures and continuing the batch. */
export async function applyBaseActions(actions: BaseAction[]): Promise<void> {
	const provider = await getProvider();
	for (const a of actions) {
		if (a.action === "skip") {
			process.stderr.write(`chain: skip ${a.ref} — ${a.reason}\n`);
			continue;
		}
		try {
			const newBase = await resolveBaseBranch(provider, a.newBase as string);
			await provider.retargetPullRequest(toPrRef(a.ref), newBase);
			process.stderr.write(`chain: retargeted ${a.ref} → base ${newBase}\n`);
		} catch (err) {
			process.stderr.write(
				`chain: failed to retarget ${a.ref} → ${a.newBase}: ${(err as Error).message}\n`,
			);
		}
	}
}

/** Fetch an existing numeric PR/MR ref body through its detected provider. */
export async function fetchPrBody(ref: string): Promise<string> {
	const provider = await getProvider();
	return provider.getPullRequestBody(toPrRef(ref));
}

/** Replace a PR/MR body through its provider, preserving the body as literal stdin. */
export async function setPrBody(ref: string, body: string): Promise<void> {
	const provider = await getProvider();
	await provider.setPullRequestBody(toPrRef(ref), body);
}

/** Retarget then update bodies in order; reject unsupported native linking before mutation. */
export async function applyChain(
	layers: Layer[],
	opts: RenderOptions = {},
	native = false,
): Promise<void> {
	const nativePlan = native
		? await resolveNativeStackPlan(layers, opts)
		: undefined;
	if (nativePlan?.unsupported) {
		throw new ProviderError(
			NATIVE_STACK_UNSUPPORTED,
			nativePlan.reason as string,
		);
	}

	await applyBaseActions(planBaseActions(layers));
	if (nativePlan) applyNativeStack(nativePlan, layers, opts);

	const allRefs = [...layers.flat(), ...(opts.independent ?? [])];
	for (const ref of allRefs) {
		const managed = wrapManaged(renderStack(layers, { ...opts, mark: ref }));
		const body = await fetchPrBody(ref);
		const updated = upsertManagedBlock(body, managed);
		await setPrBody(ref, updated);
		process.stderr.write(`chain: updated PR body for ${ref}\n`);
	}
}

// ── CLI entry point ────────────────────────────────────────────────────────────

function printHelp() {
	process.stderr.write(
		[
			"Usage: dg-skills chain render <layer1> <layer2> ... [--target main] [--mark <ref>] [--repo owner/repo] [--independent ref1,ref2]",
			"       dg-skills chain plan   <layer1> <layer2> ... [same flags] [--native]  — dry run, no provider calls",
			"       dg-skills chain base   <layer1> <layer2> ...                         — base retargets only",
			"       dg-skills chain apply  <layer1> <layer2> ... [same flags] [--native] — base retargets + PR/MR body upsert",
			"",
			"A layer is one ref, or a comma-separated set of mutually-independent refs",
			'(e.g. "101,102"). Multiple positional layers form a dependency chain,',
			"base-first: layer1 → layer2 → ... → --target.",
			"",
			"--native additionally attempts to link the chain through",
			"`gh stack link` (requires an external extension providing that command).",
			"Only linear, single-repo chains qualify — fan-out layers and",
			"owner/repo#N refs are skipped with a reason, same PR/MR body update either way.",
			"Not supported on GitLab — refuses with a clear message instead of failing obscurely.",
			"",
			"Run `dg-skills chain plan` first and show its full output before apply.",
			"Honor host approvals and existing grants before `dg-skills chain apply`.",
			"",
		].join("\n"),
	);
}

function parseArgs(argv: string[]): {
	layers: Layer[];
	independent: string[];
	repo?: string;
	mark?: string;
	target: string;
	native: boolean;
} {
	const layers: Layer[] = [];
	const independent: string[] = [];
	let repo: string | undefined;
	let mark: string | undefined;
	let target = "main";
	let native = false;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--repo") {
			repo = argv[++i];
		} else if (a === "--mark") {
			mark = argv[++i];
		} else if (a === "--target") {
			target = argv[++i] ?? target;
		} else if (a === "--independent") {
			independent.push(...parseLayerArg(argv[++i] ?? ""));
		} else if (a === "--native") {
			native = true;
		} else if (a.startsWith("--")) {
			throw new Error(`Unknown flag: ${a}`);
		} else {
			layers.push(parseLayerArg(a));
		}
	}
	return { layers, independent, repo, mark, target, native };
}

async function run(argv: string[]): Promise<void> {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		printHelp();
		process.exit(argv.length === 0 ? 1 : 0);
	}

	const [sub, ...rest] = argv;
	const { layers, independent, repo, mark, target, native } = parseArgs(rest);

	if (layers.length === 0 && independent.length === 0) {
		process.stderr.write(
			"Error: provide at least one layer (branch/PR ref) or --independent refs.\n",
		);
		process.exit(1);
	}

	const opts: RenderOptions = { target, mark, repo, independent };

	switch (sub) {
		case "render":
			process.stdout.write(`${renderStack(layers, opts)}\n`);
			break;
		case "plan": {
			const nativePlan = native
				? await resolveNativeStackPlan(layers, opts)
				: undefined;
			process.stdout.write(`${renderPlan(layers, opts, native, nativePlan)}\n`);
			break;
		}
		case "base":
			await applyBaseActions(planBaseActions(layers));
			break;
		case "apply":
			await applyChain(layers, opts, native);
			break;
		default:
			process.stderr.write(`Unknown subcommand: ${sub}\n`);
			printHelp();
			process.exit(1);
	}
}

/** Run the chain parser explicitly; importing the domain performs no work. */
export async function main(argv: string[]): Promise<number | void> {
	try {
		await run(argv);
	} catch (err) {
		if (err instanceof ProviderError && err.code === NATIVE_STACK_UNSUPPORTED) {
			process.stderr.write(`chain: ${err.message}\n`);
			process.exit(EXIT.UNSUPPORTED);
		}
		process.stderr.write(`Error: ${(err as Error).message}\n`);
		process.exit(EXIT.ERR);
	}
}
