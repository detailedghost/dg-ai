import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKILLS = "plugins/dg/skills";
const SPEC = `${SKILLS}/spec`;

export const FLOWS: Record<string, string[]> = {
	"spec-plan": [
		`${SPEC}/SKILL.md`,
		`${SPEC}/references/plan.md`,
		`${SPEC}/references/grill.md`,
		`${SPEC}/references/decision-blob.md`,
		`${SPEC}/references/templates/plan-view.md`,
		`${SPEC}/references/templates/slice-review.md`,
		`${SPEC}/references/templates/structure-grill.md`,
		`${SPEC}/references/templates/synthesis.md`,
		`${SKILLS}/assign/SKILL.md`,
		`${SKILLS}/grill-me/SKILL.md`,
	],
	"spec-exec": [`${SPEC}/SKILL.md`, `${SPEC}/references/execute.md`, `${SKILLS}/sdlc/SKILL.md`],
	phone: [`${SKILLS}/phone/SKILL.md`],
	stat: [`${SKILLS}/stat/SKILL.md`],
	thrash: [`${SKILLS}/thrash/SKILL.md`],
	verify: [`${SKILLS}/verify/SKILL.md`],
	"review-loop": [`${SKILLS}/review-loop/SKILL.md`, `${SKILLS}/address/SKILL.md`],
	jot: [`${SKILLS}/jot/SKILL.md`],
};

export type Budgets = { perFlow: Record<string, number>; descriptions: number };
export type Measurement = Budgets;

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

const tokensOf = (bytes: number): number => Math.ceil(bytes / 4);

export function fileTokens(path: string): number {
	return tokensOf(readFileSync(path).byteLength);
}

export function descriptionTokens(skillFiles: string[]): number {
	let bytes = 0;
	for (const file of skillFiles) {
		const match = FRONTMATTER.exec(readFileSync(file, "utf8"));
		bytes += Buffer.byteLength(match?.[0] ?? "");
	}
	return tokensOf(bytes);
}

export function allSkillFiles(root: string): string[] {
	return readdirSync(join(root, SKILLS), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, SKILLS, entry.name, "SKILL.md"))
		.sort();
}

export function measure(root: string, flows: Record<string, string[]> = FLOWS): Measurement {
	const perFlow: Record<string, number> = {};
	for (const [flow, files] of Object.entries(flows)) {
		perFlow[flow] = tokensOf(files.reduce((sum, file) => sum + readFileSync(join(root, file)).byteLength, 0));
	}
	return { perFlow, descriptions: descriptionTokens(allSkillFiles(root)) };
}

export function checkBudgets(measured: Measurement, budgets: Budgets): string[] {
	const failures: string[] = [];
	for (const [flow, tokens] of Object.entries(measured.perFlow)) {
		const budget = budgets.perFlow[flow];
		if (budget === undefined) failures.push(`flow ${flow} has no budget in skill-token-budgets.json`);
		else if (tokens > budget) failures.push(`flow ${flow} is over budget: ${tokens} > ${budget} tokens`);
	}
	if (measured.descriptions > budgets.descriptions) {
		failures.push(`descriptions are over budget: ${measured.descriptions} > ${budgets.descriptions} tokens`);
	}
	return failures;
}

function main(): void {
	const args = process.argv.slice(2);
	const budgetsAt = args.indexOf("--budgets");
	const budgetsPath = budgetsAt >= 0 ? args[budgetsAt + 1] : join(import.meta.dir, "skill-token-budgets.json");
	const measured = measure(process.cwd());

	for (const [flow, tokens] of Object.entries(measured.perFlow)) console.log(`${flow.padEnd(12)} ${tokens}`);
	console.log(`${"descriptions".padEnd(12)} ${measured.descriptions}`);

	if (!args.includes("--gate")) return;
	const failures = checkBudgets(measured, JSON.parse(readFileSync(budgetsPath, "utf8")) as Budgets);
	for (const failure of failures) console.error(failure);
	if (failures.length > 0) process.exit(1);
}

if (import.meta.main) main();
