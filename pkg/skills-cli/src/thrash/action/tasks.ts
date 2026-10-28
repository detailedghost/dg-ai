import { selfCommand } from "@dg/common/node";

export interface Chunk {
	id: number;
	label: string;
	annotatedPath: string;
	findingsPath: string;
}

export interface DiffPlan {
	diffPath: string;
	contextPath: string;
	chunks: Chunk[];
}

export interface ChunkTaskInput {
	chunk: Chunk;
	chunkCount: number;
	contextPath: string;
	spice: number;
	target: string;
	rulesPath: string | null;
	improvements: boolean;
	extraPrompt: string | null;
}

/** The /dg:thrash chunk template, plus the repo's review rules and any extra instructions. */
export function renderChunkTask(input: ChunkTaskInput): string {
	const lines = [
		"You are running inside /dg:thrash.",
		"",
		`ANNOTATED_DIFF: ${input.chunk.annotatedPath}`,
		`FINDINGS_PATH: ${input.chunk.findingsPath}`,
		`CONTEXT: ${input.contextPath}`,
		`CHUNK: ${input.chunk.id} of ${input.chunkCount}`,
		`SPICE: ${input.spice}`,
		"MIN_TIER: none",
		`IMPROVEMENTS: ${input.improvements ? "on" : "off"}`,
		`TARGET: ${input.target}`,
		...(input.rulesPath ? [`REVIEW_RULES: ${input.rulesPath}`] : []),
		`Open only ${input.rulesPath ? "ANNOTATED_DIFF, CONTEXT and REVIEW_RULES" : "ANNOTATED_DIFF and CONTEXT"}. Phrase any claim that needs other code as a question.`,
		"",
		"Read ANNOTATED_DIFF, then CONTEXT. Run the checklists for SPICE per your system prompt. Classify each",
		"finding's tier before you write it. Cite only the labeled `old:`/`new:` values from ANNOTATED_DIFF; never a line",
		"number from your own file-reading tool.",
	];
	if (input.rulesPath) {
		lines.push(
			"Follow REVIEW_RULES for what to check, how to tier a finding and how to word a comment. Ignore its verdict",
			"and round rules: the verdict is computed after you finish.",
		);
	}
	lines.push(
		'Write exactly one fenced json block with "changed", "strengths", "opportunities" and "findings" to FINDINGS_PATH.',
		"Reply with only: WROTE <path> <count> findings",
	);
	if (input.extraPrompt) lines.push("", input.extraPrompt.trim());
	return `${lines.join("\n")}\n`;
}

export interface CompileInput {
	target: string;
	diffPath: string;
	spice: number;
	heading: string;
	round: number;
	policyPath: string | null;
	maxComments?: number;
	verdict: string;
	reviewer: string;
	sass: boolean;
	improvements: boolean;
}

export function compileArgs(input: CompileInput): string[] {
	const args = [
		"thrash",
		"compile",
		input.target,
		"--json",
		"--diff",
		input.diffPath,
		"--spice",
		String(input.spice),
		"--heading",
		input.heading,
		"--round",
		String(input.round),
		"--max-event",
		input.verdict,
		"--reviewer",
		input.reviewer,
	];
	if (input.policyPath) args.push("--policy", input.policyPath);
	if (input.maxComments !== undefined)
		args.push("--max-comments", String(input.maxComments));
	if (input.sass) args.push("--sass");
	if (input.improvements) args.push("--improvements");
	return args;
}

export async function dgSkills(args: string[], env?: Record<string, string>): Promise<string> {
	const proc = Bun.spawn(selfCommand(args), {
		stdout: "pipe",
		stderr: "inherit",
		env: env ? { ...process.env, ...env } : process.env,
	});
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) throw new Error(`dg-skills ${args.slice(0, 2).join(" ")} exited ${code}: ${stdout.trim().slice(-2000)}`);
	return stdout;
}

/** The last JSON object a command printed; dg-skills logs progress lines before it. */
export function lastJson<T>(stdout: string): T {
	const lines = stdout.trim().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const text = lines.slice(i).join("\n");
		try {
			return JSON.parse(text) as T;
		} catch {}
	}
	throw new Error(`no JSON in output: ${stdout.slice(-500)}`);
}
