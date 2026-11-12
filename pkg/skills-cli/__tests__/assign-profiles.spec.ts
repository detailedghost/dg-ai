import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PlanSpec,
	resolveArgs,
	runAssign,
	type SliceSpec,
	writePlan,
} from "./assign-plan-builder";

const FIXTURES = join(import.meta.dir, "fixtures", "assign");
const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");
const fixture = (name: string) => join(FIXTURES, name);

const priorSkillsDir = process.env.DG_SKILLS_DIR;
beforeAll(() => {
	process.env.DG_SKILLS_DIR = SKILLS;
});
afterAll(() => {
	if (priorSkillsDir === undefined) delete process.env.DG_SKILLS_DIR;
	else process.env.DG_SKILLS_DIR = priorSkillsDir;
});

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "assign-profiles-"));
	temps.push(dir);
	return dir;
}

async function resolvePlan(spec: PlanSpec, extra: string[] = ["--layer", "0"]) {
	return resolveArgs([writePlan(scratch(), spec), ...extra]);
}

const slice = (overrides: Partial<SliceSpec> = {}): SliceSpec => ({
	id: 1,
	primary: "dg:js",
	...overrides,
});

describe("assign resolve with no execution block", () => {
	test("resolves as balance with two correction rounds", async () => {
		const baseline = await resolveArgs([fixture("plan-high.md"), "--layer", "0"]);
		expect(baseline.profile).toBe("balance");
		expect(baseline.maxCorrectionRounds).toBe(2);
		expect(baseline.slices[0]?.primary).toMatchObject({
			model: "sonnet",
			effort: "medium",
		});
		expect(baseline.roles["qa-writer"]).toMatchObject({ effort: "medium" });
	});

	test("an explicit balance profile resolves exactly like an absent one", async () => {
		const slices = [
			slice({ id: 1, qa: ["dg:qa-code"] }),
			slice({ id: 2, primary: "dba", qa: ["security"] }),
		];
		const absent = await resolvePlan({ slices });
		const explicit = await resolvePlan({ profile: "balance", slices });
		expect(explicit.profile).toBe("balance");
		expect(explicit.slices).toEqual(absent.slices);
		expect(explicit.roles).toEqual(absent.roles);
		expect(explicit.maxCorrectionRounds).toBe(absent.maxCorrectionRounds);
	});
});

describe("assign resolve under the cheap profile", () => {
	test("lowers the primary, qa-writer and qa[] efforts one ladder step and keeps wave and security", async () => {
		const args = await resolveArgs([fixture("plan-profile-cheap.md"), "--layer", "0"]);
		expect(args.profile).toBe("cheap");
		expect(args.maxCorrectionRounds).toBe(1);
		const [plain] = args.slices;
		expect(plain?.primary).toMatchObject({ model: "sonnet", effort: "low" });
		expect(plain?.qa.map((stage) => stage.effort)).toEqual(["low", "medium", "xhigh"]);
		expect(plain?.qa.map((stage) => stage.model)).toEqual(["sonnet", "opus", "opus"]);
		expect(args.roles["qa-writer"]).toMatchObject({ model: "sonnet", effort: "low" });
		expect(args.roles.wave).toMatchObject({ model: "haiku", effort: "low" });
		expect(args.roles.security).toMatchObject({ model: "opus", effort: "xhigh" });
	});

	test("moves a dba primary from xhigh to medium and never lowers the tier", async () => {
		const args = await resolveArgs([fixture("plan-profile-cheap.md"), "--layer", "0"]);
		expect(args.slices[1]?.primary).toMatchObject({ model: "opus", effort: "medium" });
	});

	test("never shifts an effort the slice sets itself", async () => {
		const args = await resolveArgs([fixture("plan-profile-cheap.md"), "--layer", "0"]);
		expect(args.slices[2]?.primary).toMatchObject({ model: "sonnet", effort: "medium" });
	});

	test("agents.model opus under cheap resolves to opus at medium", async () => {
		const args = await resolveArgs([fixture("plan-profile-cheap.md"), "--layer", "0"]);
		expect(args.slices[3]?.primary).toMatchObject({ model: "opus", effort: "medium" });
	});

	test("honors a human agents.model haiku and clamps the effort at low", async () => {
		const args = await resolveArgs([fixture("plan-profile-cheap.md"), "--layer", "0"]);
		expect(args.slices[4]?.primary).toMatchObject({ model: "haiku", effort: "low" });
	});

	test("qa: [dg:security] keeps opus at xhigh", async () => {
		const args = await resolveArgs([fixture("plan-profile-cheap.md"), "--layer", "0"]);
		expect(args.slices[5]?.qa[0]).toMatchObject({
			agentType: "dg:security",
			model: "opus",
			effort: "xhigh",
		});
	});

	test("on grok a dba primary and an opus qa[] stage resolve to medium", async () => {
		const args = await resolveArgs([
			fixture("plan-profile-cheap.md"),
			"--layer",
			"0",
			"--runtime",
			"grok",
		]);
		expect(args.slices[1]?.primary).toMatchObject({ model: "grok-4.7", effort: "medium" });
		expect(args.slices[0]?.qa[1]).toMatchObject({
			agentType: "dg:dba",
			model: "grok-4.7",
			effort: "medium",
		});
		expect(args.slices[0]?.qa[2]).toMatchObject({
			agentType: "dg:security",
			effort: "high",
		});
	});

	test("hands a proxied primary the lowered effort as a proxy flag", async () => {
		const args = await resolvePlan({
			profile: "cheap",
			slices: [slice({ proxy: "codex" })],
		});
		expect(args.slices[0]?.proxyFlags).toBe("--effort low");
	});
});

describe("assign resolve under the expensive profile", () => {
	test("raises effort for medium, the tier for high, and leaves low alone", async () => {
		const args = await resolveArgs([fixture("plan-profile-expensive.md"), "--layer", "0"]);
		expect(args.profile).toBe("expensive");
		expect(args.maxCorrectionRounds).toBe(2);
		expect(args.slices[0]?.primary).toMatchObject({ model: "sonnet", effort: "medium" });
		expect(args.slices[1]?.primary).toMatchObject({ model: "sonnet", effort: "xhigh" });
		expect(args.slices[2]?.primary).toMatchObject({ model: "opus", effort: "xhigh" });
	});

	test("keeps a complexity high dba primary on opus", async () => {
		const args = await resolveArgs([fixture("plan-profile-expensive.md"), "--layer", "0"]);
		expect(args.slices[3]?.primary).toMatchObject({ model: "opus", effort: "xhigh" });
	});

	test("leaves qa[] reviewers and the qa-writer role at their tier defaults", async () => {
		const args = await resolveArgs([fixture("plan-profile-expensive.md"), "--layer", "0"]);
		expect(args.slices[0]?.qa).toEqual([
			{ agentType: "dg:qa-code", model: "sonnet", effort: "medium" },
			{ agentType: "dg:security", model: "opus", effort: "xhigh" },
		]);
		expect(args.roles["qa-writer"]).toMatchObject({ model: "sonnet", effort: "medium" });
	});

	test("a slice with no complexity resolves exactly as under balance", async () => {
		const slices = [
			slice({ id: 1, qa: ["dg:qa-code"] }),
			slice({ id: 2, primary: "dba", qa: ["security"] }),
		];
		const balance = await resolvePlan({ profile: "balance", slices });
		const expensive = await resolvePlan({ profile: "expensive", slices });
		expect(expensive.slices).toEqual(balance.slices);
		expect(expensive.roles).toEqual(balance.roles);
	});

	test("agents.model sonnet with complexity medium still shifts the effort to xhigh", async () => {
		const args = await resolvePlan({
			profile: "expensive",
			slices: [slice({ model: "sonnet", complexity: "medium" })],
		});
		expect(args.slices[0]?.primary).toMatchObject({ model: "sonnet", effort: "xhigh" });
	});

	test("clamps an effort raise at xhigh", async () => {
		const args = await resolvePlan({
			profile: "expensive",
			slices: [slice({ primary: "dba", complexity: "medium" })],
		});
		expect(args.slices[0]?.primary).toMatchObject({ model: "opus", effort: "xhigh" });
	});

	test("never lowers a fable primary for complexity high", async () => {
		const args = await resolvePlan({
			profile: "expensive",
			slices: [slice({ primary: "arch", complexity: "high" })],
		});
		expect(args.slices[0]?.primary).toMatchObject({ model: "fable" });
	});

	test("never shifts an effort the slice sets itself", async () => {
		const args = await resolvePlan({
			profile: "expensive",
			slices: [slice({ effort: "low", complexity: "medium" })],
		});
		expect(args.slices[0]?.primary.effort).toBe("low");
	});

	test("hands a proxied complexity high slice a tier flag and omits the default opus effort", async () => {
		const args = await resolvePlan({
			profile: "expensive",
			slices: [slice({ proxy: "codex", complexity: "high" })],
		});
		expect(args.slices[0]?.proxyFlags).toBe("--tier opus");
	});

	test("on grok a complexity medium sonnet primary moves to the top rung high", async () => {
		const args = await resolvePlan(
			{ profile: "expensive", slices: [slice({ complexity: "medium" })] },
			["--layer", "0", "--runtime", "grok"],
		);
		expect(args.slices[0]?.primary.effort).toBe("high");
	});
});

describe("assign resolve complexity outside the expensive profile", () => {
	test.each(["balance", "cheap"])(
		"%s ignores agents.complexity high",
		async (profile) => {
			const args = await resolvePlan({
				profile,
				slices: [slice({ complexity: "high" })],
			});
			expect(args.slices[0]?.primary.model).toBe("sonnet");
		},
	);

	test("expensive keeps an explicit agents.model sonnet on a complexity high slice", async () => {
		const args = await resolvePlan({
			profile: "expensive",
			slices: [slice({ model: "sonnet", complexity: "high" })],
		});
		expect(args.slices[0]?.primary).toMatchObject({ model: "sonnet", effort: "medium" });
	});
});

describe("assign resolve security by bare name", () => {
	test("keeps the tier default inside agents.qa under cheap", async () => {
		const args = await resolvePlan({
			profile: "cheap",
			slices: [slice({ qa: ["security", "dg:qa-code"] })],
		});
		expect(args.slices[0]?.qa[0]).toMatchObject({ model: "opus", effort: "xhigh" });
		expect(args.slices[0]?.qa[1]).toMatchObject({ effort: "low" });
	});
});

describe("assign resolve proxy flags under a profile", () => {
	test("lists the tier flag before the effort flag when both apply", async () => {
		const args = await resolvePlan({
			profile: "cheap",
			slices: [slice({ proxy: "codex", model: "opus" })],
		});
		expect(args.slices[0]?.proxyFlags).toBe("--tier opus --effort medium");
	});

	test("omits proxy flags when the resolved stage equals the persona default", async () => {
		const args = await resolvePlan({
			profile: "balance",
			slices: [slice({ proxy: "codex" })],
		});
		expect(args.slices[0]?.proxyFlags ?? "").toBe("");
	});
});

describe("assign resolve proxy flags for raised efforts", () => {
	test("hands an effort-only raise to the proxy under expensive", async () => {
		const args = await resolvePlan({
			profile: "expensive",
			slices: [slice({ proxy: "codex", complexity: "medium" })],
		});
		expect(args.slices[0]?.proxyFlags).toBe("--effort xhigh");
	});

	test("omits proxy flags under expensive for a low complexity slice", async () => {
		const args = await resolvePlan({
			profile: "expensive",
			slices: [slice({ proxy: "codex", complexity: "low" })],
		});
		expect(args.slices[0]).not.toHaveProperty("proxyFlags");
	});
});

describe("assign resolve invalid profile inputs", () => {
	test("exits 1 naming the slice and value for an unknown complexity", async () => {
		const file = writePlan(scratch(), { slices: [slice({ complexity: "extreme" })] });
		const result = await runAssign(["resolve", file, "--layer", "0"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain('slice 1 agents.complexity "extreme"');
	});

	test("exits 1 for an unknown execution profile", async () => {
		const file = writePlan(scratch(), { profile: "turbo", slices: [slice()] });
		const result = await runAssign(["resolve", file, "--layer", "0"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain(
			'execution.profile "turbo" must be one of balance, cheap, expensive',
		);
	});
});

describe("assign resolve agents.model", () => {
	test("exits 1 naming the slice and the value for a model outside the tier table", async () => {
		const file = writePlan(scratch(), { slices: [slice({ model: "gpt" })] });
		const result = await runAssign(["resolve", file, "--layer", "0"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain('slice 1 agents.model "gpt" is not a tier');
	});
});

describe("assign resolve slice baking", () => {
	test("bakes dependsOn limited to ids inside the selection", async () => {
		const file = fixture("plan-high.md");
		const layer0 = await resolveArgs([file, "--layer", "0"]);
		expect(layer0.slices.map((entry) => entry.dependsOn)).toEqual([[], []]);
		const some = await resolveArgs([file, "--slices", "1,3"]);
		expect(some.slices.map((entry) => [entry.id, entry.dependsOn])).toEqual([
			[1, []],
			[3, [1]],
		]);
		const all = await resolveArgs([file, "--slices", "1,2,3"]);
		expect(all.slices[2]?.dependsOn).toEqual([1, 2]);
	});
});
