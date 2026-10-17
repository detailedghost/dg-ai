import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { makeTempDir } from "./git-repo-fixtures";
import { EXIT } from "../src/utils/legacy-command";
import { resetProviderCache } from "../src/provider/index";
import { notSupportedMessage } from "../src/provider/types";
import {
	applyBaseActions,
	applyChain,
	type BaseAction,
	fetchPrBody,
	formatRef,
	parseLayerArg,
	planBaseActions,
	planNativeStack,
	renderChainLine,
	renderPlan,
	renderStack,
	setPrBody,
	upsertManagedBlock,
	wrapManaged,
} from "../src/chain/index";


describe("formatRef", () => {
	test("prefixes a bare PR number with #", () => {
		expect(formatRef("101")).toBe("#101");
	});

	test("prefixes a bare PR number with owner/repo# when repo is given", () => {
		expect(formatRef("101", "acme/widgets")).toBe("acme/widgets#101");
	});

	test("passes through an already-qualified ref unchanged", () => {
		expect(formatRef("acme/widgets#101")).toBe("acme/widgets#101");
		expect(formatRef("#101")).toBe("#101");
	});

	test("passes through a pre-PR branch name unchanged", () => {
		expect(formatRef("feature/step-1")).toBe("feature/step-1");
	});
});


describe("parseLayerArg", () => {
	test("splits a comma-separated layer and trims whitespace", () => {
		expect(parseLayerArg("101, 102 ,103")).toEqual(["101", "102", "103"]);
	});

	test("returns a single-element array for a plain ref", () => {
		expect(parseLayerArg("101")).toEqual(["101"]);
	});

	test("drops empty segments", () => {
		expect(parseLayerArg("101,,102,")).toEqual(["101", "102"]);
	});
});


describe("renderChainLine", () => {
	test("renders a linear chain base-first, ending at the target", () => {
		expect(renderChainLine([["101"], ["102"]])).toBe("#101 → #102 → main");
	});

	test("joins multi-member layers with commas within a layer, arrows between layers", () => {
		expect(renderChainLine([["101", "102"], ["103"]])).toBe("#101, #102 → #103 → main");
	});

	test("honors a custom target", () => {
		expect(renderChainLine([["101"], ["102"]], "release")).toBe("#101 → #102 → release");
	});
});


describe("renderStack", () => {
	test("renders only the Stack section for a pure linear chain", () => {
		const out = renderStack([["101"], ["102"]]);
		expect(out).toContain("## Stack (merge order)");
		expect(out).not.toContain("## Related PRs");
		expect(out).toContain("#101 → #102 → main");
	});

	test("renders only Related PRs for a single layer (nothing sequential)", () => {
		const out = renderStack([["101", "102"]]);
		expect(out).not.toContain("## Stack");
		expect(out).toContain("## Related PRs (independent — mergeable in any order)");
		expect(out).toContain("- #101");
		expect(out).toContain("- #102");
	});

	test("renders both sections for a mixed batch", () => {
		const out = renderStack([["101"], ["102"]], { independent: ["103", "104"] });
		expect(out).toContain("## Stack (merge order)");
		expect(out).toContain("## Related PRs (independent — mergeable in any order)");
		expect(out).toContain("- #103");
		expect(out).toContain("- #104");
	});

	test("bolds the --mark ref and labels it 'this PR'", () => {
		const out = renderStack([["101"], ["102"]], { mark: "102" });
		expect(out).toContain("**#102 — this PR**");
	});

	test("marks the first layer 'merge first' and later layers 'depends on'", () => {
		const out = renderStack([["101"], ["102"]]);
		expect(out).toContain("- #101 — merge first");
		expect(out).toContain("- #102 — depends on #101");
	});

	test("never emits a ref inside a code fence", () => {
		const out = renderStack([["101"], ["102"]], { independent: ["103"] });
		expect(out).not.toContain("```");
	});

	test("returns empty string for no layers and no independent refs", () => {
		expect(renderStack([])).toBe("");
	});
});


describe("upsertManagedBlock", () => {
	test("appends a managed block to a body with no existing block", () => {
		const body = "Some PR description.";
		const managed = wrapManaged("## Stack (merge order)\n\n#101 → main");
		const result = upsertManagedBlock(body, managed);
		expect(result).toContain("Some PR description.");
		expect(result).toContain(managed);
	});

	test("replaces an existing managed block in place, leaving surrounding text intact", () => {
		const original = wrapManaged("## Stack (merge order)\n\n#101 → main");
		const body = `Intro text.\n\n${original}\n\nOutro text.`;
		const updated = wrapManaged("## Stack (merge order)\n\n#101 → #102 → main");
		const result = upsertManagedBlock(body, updated);
		expect(result).toContain("Intro text.");
		expect(result).toContain("Outro text.");
		expect(result).toContain("#101 → #102 → main");
		expect(result).not.toContain("#101 → main");
	});

	test("is idempotent — applying twice yields the same result as once", () => {
		const managed = wrapManaged("## Stack (merge order)\n\n#101 → main");
		const once = upsertManagedBlock("Body text.", managed);
		const twice = upsertManagedBlock(once, managed);
		expect(twice).toBe(once);
	});
});


describe("planBaseActions", () => {
	test("retargets a true one-parent chain link", () => {
		const actions = planBaseActions([["101"], ["102"]]);
		expect(actions).toEqual([{ ref: "102", action: "retarget", newBase: "101" }]);
	});

	test("skips when the previous layer has multiple members", () => {
		const actions = planBaseActions([["101", "102"], ["103"]]);
		expect(actions).toHaveLength(1);
		expect(actions[0].action).toBe("skip");
		expect(actions[0].reason).toContain("previous layer has 2 independent members");
	});

	test("skips every member of a multi-member layer sharing a base", () => {
		const actions = planBaseActions([["101"], ["102", "103"]]);
		expect(actions).toHaveLength(2);
		expect(actions.every((a: BaseAction) => a.action === "skip")).toBe(true);
		expect(actions[0].reason).toContain("this layer has 2 members");
	});

	test("chains across three layers", () => {
		const actions = planBaseActions([["101"], ["102"], ["103"]]);
		expect(actions).toEqual([
			{ ref: "102", action: "retarget", newBase: "101" },
			{ ref: "103", action: "retarget", newBase: "102" },
		]);
	});

	test("returns no actions for a single layer", () => {
		expect(planBaseActions([["101", "102"]])).toEqual([]);
	});
});


describe("renderPlan", () => {
	test("includes the stack block and a base-retarget summary", () => {
		const out = renderPlan([["101"], ["102"]]);
		expect(out).toContain("## Stack (merge order)");
		expect(out).toContain("## Base-retarget plan (dry run — no gh calls made)");
		expect(out).toContain("retarget 102 → base = head branch of 101");
	});

	test("notes when there are no retargets to make", () => {
		const out = renderPlan([["101", "102"]]);
		expect(out).toContain("no base retargets");
	});

	test("omits the native-stack section by default", () => {
		expect(renderPlan([["101"], ["102"]])).not.toContain("Native GitHub stack");
	});

	test("shows the gh stack link dry-run command when --native and eligible", () => {
		const layers = [["101"], ["102"]];
		const out = renderPlan(layers, {}, true, planNativeStack(layers, {}));
		expect(out).toContain("## Native GitHub stack (--native, dry run — no gh calls made)");
		expect(out).toContain("would run: gh stack link --base main 101 102");
	});

	test("shows the skip reason when --native but the chain is ineligible", () => {
		const layers = [["101"], ["102", "103"]];
		const out = renderPlan(layers, {}, true, planNativeStack(layers, {}));
		expect(out).toContain("skip (a fan-out layer");
	});

	test("throws when --native is requested without a pre-resolved nativePlan", () => {
		expect(() => renderPlan([["101"], ["102"]], {}, true)).toThrow(/nativePlan/);
	});
});


describe("planNativeStack", () => {
	test("is eligible for a linear, single-repo, multi-layer chain", () => {
		const plan = planNativeStack([["101"], ["102"], ["103"]]);
		expect(plan.eligible).toBe(true);
		expect(plan.args).toEqual(["stack", "link", "--base", "main", "101", "102", "103"]);
	});

	test("honors a custom --target as the stack's base", () => {
		const plan = planNativeStack([["101"], ["102"]], { target: "release" });
		expect(plan.args).toEqual(["stack", "link", "--base", "release", "101", "102"]);
	});

	test("is ineligible for a single layer — nothing to stack", () => {
		const plan = planNativeStack([["101", "102"]]);
		expect(plan.eligible).toBe(false);
		expect(plan.reason).toContain("at least two layers");
	});

	test("is ineligible when any layer fans out (no single git base)", () => {
		const plan = planNativeStack([["101"], ["102", "103"]]);
		expect(plan.eligible).toBe(false);
		expect(plan.reason).toContain("fan-out layer");
	});

	test("is ineligible when --repo is set (refs assumed outside the current repo)", () => {
		const plan = planNativeStack([["101"], ["102"]], { repo: "acme/widgets" });
		expect(plan.eligible).toBe(false);
		expect(plan.reason).toContain("--repo");
	});

	test("is ineligible when a ref is explicitly cross-repo qualified", () => {
		const plan = planNativeStack([["acme/widgets#101"], ["102"]]);
		expect(plan.eligible).toBe(false);
		expect(plan.reason).toContain("cross-repo");
	});
});


const UNROUTABLE_HOST = "chain-cli-test.invalid";
const CHAIN_CLI = join(import.meta.dir, "../src/index.ts");
const BUN_BIN = process.execPath;
cliFixtures.isolateCliTests();

let savedCwd: string;
let createdDirs: string[];

function tmp(prefix: string): string {
	return cliFixtures.tmp(createdDirs, prefix);
}

beforeEach(() => {
	createdDirs = [];
	savedCwd = process.cwd();
	process.chdir(tmp("chain-cli-test-cwd-"));
	process.env.GH_HOST = UNROUTABLE_HOST;
	process.env.GITLAB_HOST = UNROUTABLE_HOST;
	resetProviderCache();
});

afterEach(() => {
	process.chdir(savedCwd);
	for (const dir of createdDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	resetProviderCache();
});

function writeJson(name: string, data: unknown): string {
	return cliFixtures.writeJson(createdDirs, "fake-fixture-", name, data);
}

function callLogPath(): string {
	const path = cliFixtures.callLogPath(createdDirs, "fake-log-");
	process.env.FAKE_CALL_LOG = path;
	return path;
}

function readCalls(path: string): string[] {
	return cliFixtures.readCalls(path);
}

function fakeCliScript(caseBody: string): string {
	return cliFixtures.shScript(caseBody);
}

function fakeGh(script: string): string {
	const dir = tmp("fake-gh-bin-");
	writeFakeCli(dir, "gh", script);
	const bin = join(dir, "gh");
	process.env.GH_BIN = bin;
	return bin;
}

function fakeGlab(script: string): void {
	const dir = tmp("fake-glab-bin-");
	writeFakeCli(dir, "glab", script);
	process.env.GLAB_BIN = join(dir, "glab");
}

function rawPr(n: number, state: "OPEN" | "CLOSED" | "MERGED", overrides: Record<string, unknown> = {}) {
	return {
		number: n,
		title: `PR #${n}`,
		url: `https://github.com/acme/widgets/pull/${n}`,
		state,
		headRefName: `feature-${n}`,
		baseRefName: "main",
		body: `body of PR ${n}`,
		mergedAt: state === "MERGED" ? "2026-01-01T00:00:00Z" : null,
		...overrides,
	};
}

function rawMr(n: number, state: "opened" | "closed" | "merged" | "locked", overrides: Record<string, unknown> = {}) {
	return {
		iid: n,
		title: `MR #${n}`,
		web_url: `https://gitlab.com/acme/widgets/-/merge_requests/${n}`,
		state,
		source_branch: `feature-${n}`,
		target_branch: "main",
		description: `body of MR ${n}`,
		merged_at: state === "merged" ? "2026-01-01T00:00:00Z" : null,
		...overrides,
	};
}

const PR_VIEW_101 = "pr view 101 --json number,title,url,state,headRefName,baseRefName,body,mergedAt";
const MR_VIEW_101 = "mr view 101 --output json";

/** A retarget names a PR, but git needs its head branch — the fake resolves 101 to feature-101. */
function resolvableBaseScript(extraCases = ""): string {
	return fakeCliScript(`
  "pr view 101 --json"*)
    echo '${JSON.stringify(rawPr(101, "OPEN"))}'
    ;;
  "pr view 102 --json"*)
    echo '${JSON.stringify(rawPr(102, "OPEN"))}'
    ;;
  "mr view 101 --output json")
    echo '${JSON.stringify(rawMr(101, "opened"))}'
    ;;${extraCases}`);
}

describe("applyBaseActions", () => {
	test("retargets via the GitHub adapter, skipping non-retarget actions", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const log = callLogPath();
		fakeGh(resolvableBaseScript());

		const actions: BaseAction[] = [
			{ ref: "102", action: "retarget", newBase: "101" },
			{ ref: "103", action: "skip", reason: "shared base" },
		];
		await applyBaseActions(actions);

		expect(readCalls(log)).toEqual([PR_VIEW_101, "pr edit 102 --base feature-101"]);
	});

	test("retargets via the GitLab adapter", async () => {
		process.env.AI_VCS_PROVIDER = "gitlab";
		const log = callLogPath();
		fakeGlab(resolvableBaseScript());

		await applyBaseActions([{ ref: "102", action: "retarget", newBase: "101" }]);

		expect(readCalls(log)).toEqual([MR_VIEW_101, "mr update 102 --target-branch feature-101"]);
	});

	test("continues to the next retarget after one fails, instead of aborting the whole batch", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const log = callLogPath();
		fakeGh(
			resolvableBaseScript(`
  "pr edit 102 --base feature-101")
    echo 'not found' 1>&2
    exit 1
    ;;`),
		);

		const actions: BaseAction[] = [
			{ ref: "102", action: "retarget", newBase: "101" },
			{ ref: "103", action: "retarget", newBase: "102" },
		];

		await expect(applyBaseActions(actions)).resolves.toBeUndefined();
		expect(readCalls(log)).toEqual([
			PR_VIEW_101,
			"pr edit 102 --base feature-101",
			PR_VIEW_101.replace("101", "102"),
			"pr edit 103 --base feature-102",
		]);
	});

	test("retargets a qualified owner/repo#N ref against that named repo, not the ambient one", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const log = callLogPath();
		fakeGh(resolvableBaseScript());

		await applyBaseActions([{ ref: "acme/widgets#202", action: "retarget", newBase: "101" }]);

		expect(readCalls(log)).toEqual([PR_VIEW_101, "pr edit 202 -R acme/widgets --base feature-101"]);
	});

	test("fails loudly on a pre-PR branch-name ref instead of sending a NaN identifier", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const log = callLogPath();
		fakeGh(fakeCliScript(""));
		const written: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write;

		try {
			await applyBaseActions([{ ref: "feature/step-1", action: "retarget", newBase: "feature/step-0" }]);
		} finally {
			process.stderr.write = originalWrite;
		}

		expect(readCalls(log)).toEqual([]);
		const stderr = written.join("");
		expect(stderr).toContain("failed to retarget feature/step-1");
		expect(stderr).toContain("branch-name ref");
		expect(stderr).not.toContain("NaN");
	});
});

describe("fetchPrBody", () => {
	test("returns the PR body via the GitHub adapter", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("pr.json", rawPr(101, "OPEN", { body: "existing body" }));
		fakeGh(
			fakeCliScript(`
  "pr view "*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		expect(await fetchPrBody("101")).toBe("existing body");
		expect(readCalls(log).some((c) => c.startsWith("pr view 101 "))).toBe(true);
	});

	test("throws when the GitHub adapter call fails", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		fakeGh(
			fakeCliScript(`
  "pr view "*)
    echo 'not found' 1>&2
    exit 1
    ;;`),
		);

		await expect(fetchPrBody("101")).rejects.toThrow();
	});

	test("returns the MR body via the GitLab adapter", async () => {
		process.env.AI_VCS_PROVIDER = "gitlab";
		const log = callLogPath();
		process.env.FAKE_MR_JSON = writeJson("mr.json", rawMr(101, "opened", { description: "existing body" }));
		fakeGlab(
			fakeCliScript(`
  "mr view "*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		expect(await fetchPrBody("101")).toBe("existing body");
		expect(readCalls(log).some((c) => c.startsWith("mr view 101 "))).toBe(true);
	});

	test("throws on a pre-PR branch-name ref instead of sending a NaN identifier", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const log = callLogPath();
		fakeGh(fakeCliScript(""));

		await expect(fetchPrBody("feature/step-1")).rejects.toThrow(/branch-name ref/);
		expect(readCalls(log)).toEqual([]);
	});
});

describe("setPrBody", () => {
	test("pipes the new body via stdin through the GitHub adapter", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const capture = join(tmp("fake-gh-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = capture;
		fakeGh(
			fakeCliScript(`
  *"pr edit 101 --body-file -"*)
    cat > "$FAKE_STDIN_CAPTURE" 2>/dev/null || true
    exit 0
    ;;`),
		);

		await setPrBody("101", "new chain body");

		expect(readFileSync(capture, "utf8")).toBe("new chain body");
	});

	test("pipes the new body via stdin through the GitLab adapter", async () => {
		process.env.AI_VCS_PROVIDER = "gitlab";
		const capture = join(tmp("fake-glab-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = capture;
		fakeGlab(
			fakeCliScript(`
  *"mr update 101 --description-file -"*)
    cat > "$FAKE_STDIN_CAPTURE" 2>/dev/null || true
    exit 0
    ;;`),
		);

		await setPrBody("101", "new chain body");

		expect(readFileSync(capture, "utf8")).toBe("new chain body");
	});
});

function runCli(
	args: readonly string[],
	env: Record<string, string>,
	cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
	const proc = Bun.spawnSync([BUN_BIN, "run", CHAIN_CLI, "chain", ...args], {
		cwd,
		env: {
			...process.env,
			...env,
		},
	});
	return {
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		exitCode: proc.exitCode ?? 1,
	};
}

function freshCwd(): string {
	return tmp("chain-cli-cwd-");
}

describe("chain apply --native (GitHub)", () => {
	test("runs gh stack link after the retargets and before the body upserts, and chain plan --native agrees it's eligible", () => {
		const cwd = freshCwd();
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("pr.json", rawPr(101, "OPEN"));
		const ghBin = fakeGh(
			fakeCliScript(`
  *"--body-file -"*)
    cat > /dev/null
    exit 0
    ;;
  "pr view "*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const env = { AI_VCS_PROVIDER: "github", GH_BIN: ghBin };
		const apply = runCli(["apply", "101", "102", "--native"], env, cwd);

		expect(apply.exitCode).toBe(0);
		const calls = readCalls(log);
		expect(calls).toHaveLength(7);
		expect(calls[0]).toMatch(/^pr view 101 --json/);
		expect(calls[1]).toBe("pr edit 102 --base feature-101");
		expect(calls[2]).toBe("stack link --base main 101 102");
		expect(calls[3]).toMatch(/^pr view 101 --json/);
		expect(calls[4]).toBe("pr edit 101 --body-file -");
		expect(calls[5]).toMatch(/^pr view 102 --json/);
		expect(calls[6]).toBe("pr edit 102 --body-file -");

		const plan = runCli(["plan", "101", "102", "--native"], env, cwd);
		expect(plan.exitCode).toBe(0);
		expect(plan.stdout).toContain("would run: gh stack link --base main 101 102");
	});

	test("a structurally ineligible chain still proceeds with retargets and body upserts, skipping only the native call, and chain plan --native agrees it's ineligible", () => {
		const cwd = freshCwd();
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("pr.json", rawPr(101, "OPEN"));
		const ghBin = fakeGh(
			fakeCliScript(`
  *"--body-file -"*)
    cat > /dev/null
    exit 0
    ;;
  "pr view "*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);
		const env = { AI_VCS_PROVIDER: "github", GH_BIN: ghBin };

		const result = runCli(["apply", "101", "102,103", "--native"], env, cwd);

		expect(result.exitCode).toBe(0);
		const calls = readCalls(log);
		expect(calls.some((c) => c.startsWith("stack link"))).toBe(false);
		expect(calls.filter((c) => c === "pr edit 101 --body-file -")).toHaveLength(1);
		expect(calls.filter((c) => c === "pr edit 102 --body-file -")).toHaveLength(1);
		expect(calls.filter((c) => c === "pr edit 103 --body-file -")).toHaveLength(1);

		const plan = runCli(["plan", "101", "102,103", "--native"], env, cwd);
		expect(plan.exitCode).toBe(0);
		expect(plan.stdout).not.toContain("would run: gh stack link");
		expect(plan.stdout).toContain("skip (a fan-out layer");
	});
});

describe("chain apply (GitLab, non-native)", () => {
	test("retargets bases and upserts the rendered stack into each MR body via the GitLab adapter", () => {
		const cwd = freshCwd();
		const log = callLogPath();
		const mr101 = writeJson("101.json", rawMr(101, "opened", { description: "Intro text for MR 101." }));
		const mr102 = writeJson("102.json", rawMr(102, "opened", { description: "Intro text for MR 102." }));
		const stdin101 = join(tmp("fake-glab-fixtures-"), "stdin-101.txt");
		const stdin102 = join(tmp("fake-glab-fixtures-"), "stdin-102.txt");

		const dir = tmp("fake-glab-bin-");
		writeFakeCli(
			dir,
			"glab",
			`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  "mr update 102 --target-branch feature-101")
    exit 0
    ;;
  "mr view 101 --output json")
    cat "${mr101}"
    exit 0
    ;;
  "mr view 102 --output json")
    cat "${mr102}"
    exit 0
    ;;
  "mr update 101 --description-file -")
    cat > "${stdin101}" 2>/dev/null || true
    exit 0
    ;;
  "mr update 102 --description-file -")
    cat > "${stdin102}" 2>/dev/null || true
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
		);

		const result = runCli(["apply", "101", "102"], { AI_VCS_PROVIDER: "gitlab" }, cwd);

		expect(result.exitCode).toBe(0);
		expect(readCalls(log)).toEqual([
			MR_VIEW_101,
			"mr update 102 --target-branch feature-101",
			"mr view 101 --output json",
			"mr update 101 --description-file -",
			"mr view 102 --output json",
			"mr update 102 --description-file -",
		]);

		const body101 = readFileSync(stdin101, "utf8");
		expect(body101).toContain("Intro text for MR 101.");
		expect(body101).toContain("<!-- /chain:start -->");
		expect(body101).toContain("**#101 — this PR**");
		expect(body101).toContain("#101 → #102 → main");

		const body102 = readFileSync(stdin102, "utf8");
		expect(body102).toContain("Intro text for MR 102.");
		expect(body102).toContain("**#102 — this PR**");
	});
});

describe("chain base (GitLab)", () => {
	test("runs only the base retarget via the GitLab adapter, without touching MR bodies", () => {
		const cwd = freshCwd();
		const log = callLogPath();
		fakeGlab(resolvableBaseScript());

		const result = runCli(["base", "101", "102"], { AI_VCS_PROVIDER: "gitlab" }, cwd);

		expect(result.exitCode).toBe(0);
		expect(readCalls(log)).toEqual([MR_VIEW_101, "mr update 102 --target-branch feature-101"]);
	});
});

describe("chain --native eligibility on a provider without nativeStacking (GitLab)", () => {
	test("apply --native refuses via the shared not-supported message and makes no MR calls at all", () => {
		const cwd = freshCwd();
		const log = callLogPath();
		fakeGlab(fakeCliScript(""));

		const result = runCli(["apply", "101", "102", "--native"], { AI_VCS_PROVIDER: "gitlab" }, cwd);

		expect(result.exitCode).toBe(EXIT.UNSUPPORTED);
		expect(result.stderr).toContain(notSupportedMessage("--native stack linking"));
		expect(result.stderr).not.toContain("ENOENT");
		expect(result.stderr).not.toContain("command not found");
		expect(readCalls(log)).toEqual([]);
	});

	test("plan --native agrees with apply --native by refusing native stacking too", () => {
		const cwd = freshCwd();
		const env = { AI_VCS_PROVIDER: "gitlab" };

		const plan = runCli(["plan", "101", "102", "--native"], env, cwd);
		const apply = runCli(["apply", "101", "102", "--native"], env, cwd);

		expect(plan.exitCode).toBe(0);
		expect(plan.stdout).not.toContain("would run: gh stack link");
		expect(plan.stdout).toContain(notSupportedMessage("--native stack linking"));
		expect(apply.exitCode).toBe(EXIT.UNSUPPORTED);
	});
});

describe("applyChain body-upsert failure handling", () => {
	test("a failed retarget lookup is logged and the body fetch then aborts the batch before a later ref", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const log = callLogPath();
		fakeGh(
			fakeCliScript(`
  "pr view 101 "*)
    echo 'not found' 1>&2
    exit 1
    ;;`),
		);

		await expect(applyChain([["101"], ["102"]], {}, false)).rejects.toThrow();

		const calls = readCalls(log);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatch(/^pr view 101 /);
		expect(calls[1]).toMatch(/^pr view 101 /);
		expect(calls.some((c) => c.includes("--base"))).toBe(false);
		expect(calls.some((c) => c.includes("view 102"))).toBe(false);
		expect(calls.some((c) => c.includes("body-file"))).toBe(false);
	});
});

describe("chain apply --independent (GitHub)", () => {
	test("upserts bodies for --independent refs too, after the chained refs", () => {
		const cwd = freshCwd();
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("pr.json", rawPr(101, "OPEN"));
		const ghBin = fakeGh(
			fakeCliScript(`
  *"--body-file -"*)
    cat > /dev/null
    exit 0
    ;;
  "pr view "*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const result = runCli(
			["apply", "101", "--independent", "104,105"],
			{ AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			cwd,
		);

		expect(result.exitCode).toBe(0);
		const editCalls = readCalls(log).filter((c) => c.endsWith("--body-file -"));
		expect(editCalls).toEqual(["pr edit 101 --body-file -", "pr edit 104 --body-file -", "pr edit 105 --body-file -"]);
	});
});

describe("chain apply --native (GitHub) when gh stack link itself fails", () => {
	test("logs the failure but still completes the retargets and body upserts", () => {
		const cwd = freshCwd();
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("pr.json", rawPr(101, "OPEN"));
		const ghBin = fakeGh(
			fakeCliScript(`
  *"stack link"*)
    echo 'gh: unknown command "stack"' 1>&2
    exit 1
    ;;
  *"--body-file -"*)
    cat > /dev/null
    exit 0
    ;;
  "pr view "*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const result = runCli(["apply", "101", "102", "--native"], { AI_VCS_PROVIDER: "github", GH_BIN: ghBin }, cwd);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("chain: gh stack link failed");
		const calls = readCalls(log);
		expect(calls.filter((c) => c === "pr edit 101 --body-file -")).toHaveLength(1);
		expect(calls.filter((c) => c === "pr edit 102 --body-file -")).toHaveLength(1);
	});
});

describe("chain apply (GitHub) when gh itself is missing, no --native", () => {
	test("exits EXIT.ERR, not EXIT.UNSUPPORTED — a missing-binary ProviderError is not a native-stack refusal", () => {
		const cwd = freshCwd();

		const result = runCli(["apply", "101", "102"], { AI_VCS_PROVIDER: "github", GH_BIN: "/nonexistent/gh" }, cwd);

		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.exitCode).not.toBe(EXIT.UNSUPPORTED);
	});
});

describe("chain raw argv and read-only commands", () => {
	test.each([
		{ args: [], status: 1, message: "Usage:" },
		{ args: ["--help"], status: 0, message: "Usage:" },
		{ args: ["-h"], status: 0, message: "Usage:" },
		{ args: ["bogus", "101"], status: 1, message: "Unknown subcommand: bogus" },
		{ args: ["render"], status: 1, message: "provide at least one layer" },
		{ args: ["render", "101", "--wat"], status: 1, message: "Unknown flag: --wat" },
		{ args: ["render", "--", "101"], status: 1, message: "Unknown flag: --" },
	])("preserves status and stderr for $args", ({ args, status, message }) => {
		const log = callLogPath();
		fakeGh(fakeCliScript(""));
		fakeGlab(fakeCliScript(""));
		const result = runCli(args, {}, freshCwd());
		expect(result.exitCode).toBe(status);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(message);
		expect(readCalls(log)).toEqual([]);
	});

	test("renders mixed refs and repeatable independent layers without provider calls", () => {
		const log = callLogPath();
		fakeGh(fakeCliScript(""));
		fakeGlab(fakeCliScript(""));
		const layers = [["feature/step-1", "#102"], ["other/widgets#103"]];
		const options = { repo: "acme/widgets", target: "release/next", mark: "#102", independent: ["104", "feature/side", "105"] };
		const result = runCli([
			"render", "feature/step-1, #102", "other/widgets#103", "--repo", options.repo,
			"--target", options.target, "--mark", options.mark, "--independent", "104,feature/side", "--independent", "105",
		], {}, freshCwd());
		expect(result).toEqual({ exitCode: 0, stdout: `${renderStack(layers, options)}\n`, stderr: "" });
		expect(readCalls(log)).toEqual([]);
	});

	test("renders only independent refs with no positional layer", () => {
		const result = runCli(["render", "--independent", "101,102"], {}, freshCwd());
		expect(result).toEqual({ exitCode: 0, stdout: `${renderStack([], { independent: ["101", "102"] })}\n`, stderr: "" });
	});

	test.each(["github", "gitlab"])("plans branch refs on %s without native provider reads or mutations", (provider) => {
		const log = callLogPath();
		fakeGh(fakeCliScript(""));
		fakeGlab(fakeCliScript(""));
		const layers = [["feature/first"], ["feature/next"]];
		const result = runCli(["plan", "feature/first", "feature/next"], { AI_VCS_PROVIDER: provider }, freshCwd());
		expect(result).toEqual({ exitCode: 0, stdout: `${renderPlan(layers)}\n`, stderr: "" });
		expect(readCalls(log)).toEqual([]);
	});

	test("imports the chain domain without running the CLI", () => {
		const proc = Bun.spawnSync([BUN_BIN, "-e", `await import(${JSON.stringify(join(import.meta.dir, "../src/chain/index.ts"))}); console.log("import complete");`], { cwd: freshCwd(), env: process.env });
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("import complete\n");
		expect(proc.stderr.toString()).toBe("");
	});
});

interface ChainCall { args: string[]; body?: string }
function statefulProvider(provider: "github" | "gitlab", options: {
	bodies?: Record<string, string>; failBody?: string; failFetch?: string; failRetarget?: string;
} = {}) {
	const dir = tmp("chain-stateful-");
	const statePath = join(dir, "bodies.json");
	const callsPath = join(dir, "calls.jsonl");
	writeFileSync(statePath, JSON.stringify(options.bodies ?? {}));
	const binName = provider === "github" ? "gh" : "glab";
	writeFakeCli(dir, binName, `#!${BUN_BIN}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const opts = ${JSON.stringify(options)};
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
const number = args[2];
const isBody = args.includes("--body-file") || args.includes("--description-file");
const body = isBody ? await Bun.stdin.text() : undefined;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, body }) + "\\n");
if (args[0] === "issue" || args[0] === "label") {
 const issue = ${JSON.stringify(provider === "github" ? {
  number: 71, title: "Issue 71", url: "https://github.com/acme/widgets/issues/71",
  state: "OPEN", body: "Issue body", labels: [{ name: "triage" }], comments: [], createdAt: "2026-01-01T00:00:00Z",
 } : {
  iid: 71, title: "Issue 71", web_url: "https://gitlab.com/acme/widgets/-/issues/71",
  state: "opened", description: "Issue body", labels: ["triage"], created_at: "2026-01-01T00:00:00Z", user_notes_count: 0,
 })};
 if (args[0] === "issue" && args[1] === "create") console.log(issue.url ?? issue.web_url);
 else if (args[1] === "list") console.log(JSON.stringify([issue]));
 else if (args[1] === "view") console.log(JSON.stringify(issue));
 process.exit(0);
}
if (args[1] === "view") {
 if (number === opts.failFetch) { console.error("fixture body fetch failed"); process.exit(1); }
 const body = state[number] ?? "Original body " + number;
 console.log(JSON.stringify(${provider === "github" ? '{ number: Number(number), title: "PR " + number, url: "https://github.com/acme/widgets/pull/" + number, state: "OPEN", headRefName: "feature-" + number, baseRefName: "main", body, mergedAt: null }' : '{ iid: Number(number), title: "MR " + number, web_url: "https://gitlab.com/acme/widgets/-/merge_requests/" + number, state: "opened", source_branch: "feature-" + number, target_branch: "main", description: body, merged_at: null }'}));
} else if (isBody) {
 if (number === opts.failBody) { console.error("fixture body write failed"); process.exit(1); }
 state[number] = body;
 writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
} else if (number === opts.failRetarget) { console.error("fixture retarget failed"); process.exit(1); }
`);
	return {
		env: { AI_VCS_PROVIDER: provider, [provider === "github" ? "GH_BIN" : "GLAB_BIN"]: join(dir, binName) },
		calls: (): ChainCall[] => cliFixtures.readCalls(callsPath).map((line) => JSON.parse(line)),
		bodies: (): Record<string, string> => JSON.parse(readFileSync(statePath, "utf8")),
	};
}

describe.each(["github", "gitlab"] as const)("chain apply managed bodies on %s", (provider) => {
	test("preserves surrounding text, replaces its managed block and is idempotent across repeated apply", () => {
		const layers = [["101"], ["102"]];
		const intro = "Intro 🔗\nLiteral $(touch never) `quotes` & <html>\n\n";
		const outro = "\n\nOutro with trailing whitespace.  \n";
		const fixture = statefulProvider(provider, { bodies: {
			101: `${intro}${wrapManaged("stale stack")}${outro}`, 102: "Unmanaged description ✨\n",
		} });
		const cwd = freshCwd();
		const first = runCli(["apply", "101", "102"], fixture.env, cwd);
		expect(first.exitCode).toBe(0);
		const once = fixture.bodies();
		expect(once[101]).toBe(`${intro}${wrapManaged(renderStack(layers, { mark: "101" }))}${outro}`);
		expect(once[102]).toBe(upsertManagedBlock("Unmanaged description ✨\n", wrapManaged(renderStack(layers, { mark: "102" }))));
		expect(runCli(["apply", "101", "102"], fixture.env, cwd).exitCode).toBe(0);
		expect(fixture.bodies()).toEqual(once);
	});

	test("keeps earlier body updates and stops before later bodies after a write fails", () => {
		const fixture = statefulProvider(provider, { failBody: "102" });
		const result = runCli(["apply", "101,102,103"], fixture.env, freshCwd());
		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.stderr).toContain("fixture body write failed");
		expect(fixture.bodies()[101]).toContain(wrapManaged(renderStack([["101", "102", "103"]], { mark: "101" })));
		expect(fixture.bodies()[102]).toBeUndefined();
		expect(fixture.calls().some((call) => call.args[2] === "103")).toBe(false);
	});

	test("continues retargets and body updates after a retarget fails", () => {
		const fixture = statefulProvider(provider, { failRetarget: "102" });
		const result = runCli(["apply", "101", "102", "103"], fixture.env, freshCwd());
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("failed to retarget 102");
		const calls = fixture.calls();
		expect(calls.some((call) => call.args[2] === "103" && call.args.includes("feature-102"))).toBe(true);
		expect(Object.keys(fixture.bodies()).sort()).toEqual(["101", "102", "103"]);
	});
});

const bootstrapTools = ["sh", "mktemp", "find", "grep", "mkdir", "basename", "rm", "dirname", "cp", "chmod", "sort", "wc", "tr"].map((name) => {
	const path = Bun.which(name);
	if (!path) throw new Error(`Missing bootstrap test utility: ${name}`);
	return { name, path };
});

describe("relocated compiled chain and file commands", () => {
	let bundleRoot: string;
	let binary: string;
	let installedSkills: string;
	let installedSkillText: Record<string, string>;

	beforeAll(() => {
		bundleRoot = makeTempDir("dg-chain-file-bundle-");
		const stage = join(bundleRoot, "build stage with spaces");
		const compiled = join(stage, "dg-skills");
		const install = join(bundleRoot, "relocated install with spaces");
		installedSkills = join(install, "skills");
		binary = join(install, "bin", "dg-skills");
		mkdirSync(stage, { recursive: true });
		mkdirSync(join(install, "bin"), { recursive: true });
		const build = Bun.spawnSync([BUN_BIN, join(import.meta.dir, "../build.ts"), "--outfile", compiled], {
			cwd: join(import.meta.dir, "../../.."), env: process.env,
		});
		if (build.exitCode !== 0) throw new Error(`Compile failed: ${build.stderr.toString()}`);
		renameSync(compiled, binary);

		const copiedRepo = join(stage, "copied repository");
		const copiedBootstrap = join(copiedRepo, "pkg", "skills-cli", "bootstrap.sh");
		mkdirSync(join(copiedRepo, "pkg", "skills-cli"), { recursive: true });
		cpSync(join(import.meta.dir, "../bootstrap.sh"), copiedBootstrap);
		installedSkillText = {};
		for (const skill of ["chain", "file"]) {
			const source = join(import.meta.dir, "../../../plugins/dg/skills", skill);
			cpSync(source, join(copiedRepo, "plugins", "dg", "skills", skill), { recursive: true });
			installedSkillText[skill] = readFileSync(join(source, "SKILL.md"), "utf8");
		}
		const tools = join(stage, "bootstrap tools");
		const cwd = join(stage, "external bootstrap cwd");
		const home = join(stage, "isolated home");
		for (const path of [tools, cwd, home]) mkdirSync(path, { recursive: true });
		for (const tool of bootstrapTools) symlinkSync(tool.path, join(tools, tool.name));
		const bootstrap = Bun.spawnSync([join(tools, "sh"), copiedBootstrap, "--skills-only"], {
			cwd,
			env: {
				PATH: tools, HOME: home, TMPDIR: stage,
				DG_SKILLS_DEST: installedSkills, DG_SKILLS_NO_CLI: "1",
			},
		});
		if (bootstrap.exitCode !== 0) throw new Error(`Copied bootstrap failed: ${bootstrap.stderr.toString()}`);
		rmSync(stage, { recursive: true, force: true });
	}, 120_000);

	afterAll(() => {
		if (bundleRoot) rmSync(bundleRoot, { recursive: true, force: true });
	});

	function runCompiled(args: readonly string[], env: Record<string, string>, cwd: string) {
		const proc = Bun.spawnSync([binary, ...args], {
			cwd,
			env: {
				...process.env,
				...env,
				DG_SKILLS_DIR: installedSkills,
				CLAUDE_PLUGIN_ROOT: join(bundleRoot, "relocated install with spaces"),
			},
		});
		return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
	}

	test("copies both skill trees with the packaged bootstrap and preserves compiled usage streams", () => {
		for (const skill of ["chain", "file"]) {
			expect(readFileSync(join(installedSkills, skill, "SKILL.md"), "utf8")).toBe(installedSkillText[skill]);
		}
		const cwd = freshCwd();
		const chain = runCompiled(["chain"], {}, cwd);
		expect(chain.exitCode).toBe(1);
		expect(chain.stdout).toBe("");
		expect(chain.stderr).toContain("Usage:");
		const file = runCompiled(["file"], {}, cwd);
		expect(file.exitCode).toBe(2);
		expect(file.stdout).toContain("Usage:");
		expect(file.stderr).toBe("");
	});

	test.each(["github", "gitlab"] as const)("plans and applies an idempotent managed-body stack on %s outside the checkout", (provider) => {
		const intro = "Intro 🔗\nLiteral $(touch never) `quotes` & <html>\n\n";
		const outro = "\n\nOutro stays.  \n";
		const layers = [["101"], ["102"]];
		const options = { target: "release/next" };
		const fixture = statefulProvider(provider, { bodies: {
			101: `${intro}${wrapManaged("stale stack")}${outro}`, 102: "Original second body\n",
		} });
		const cwd = freshCwd();
		const plan = runCompiled(["chain", "plan", "101", "102", "--target", options.target], fixture.env, cwd);
		expect(plan).toEqual({ exitCode: 0, stdout: `${renderPlan(layers, options)}\n`, stderr: "" });
		expect(fixture.calls()).toEqual([]);

		const args = ["chain", "apply", "101", "102", "--target", options.target, ...(provider === "github" ? ["--native"] : [])];
		const apply = runCompiled(args, fixture.env, cwd);
		expect(apply.exitCode).toBe(0);
		expect(apply.stdout).toBe("");
		const bodies = fixture.bodies();
		expect(bodies[101]).toBe(`${intro}${wrapManaged(renderStack(layers, { ...options, mark: "101" }))}${outro}`);
		expect(bodies[102]).toBe(upsertManagedBlock("Original second body\n", wrapManaged(renderStack(layers, { ...options, mark: "102" }))));
		if (provider === "github") {
			const calls = fixture.calls();
			expect(calls[1].args).toEqual(["pr", "edit", "102", "--base", "feature-101"]);
			expect(calls[2].args).toEqual(["stack", "link", "--base", options.target, "101", "102"]);
			expect(calls[4].body).toBe(bodies[101]);
		}
		expect(runCompiled(args, fixture.env, cwd).exitCode).toBe(0);
		expect(fixture.bodies()).toEqual(bodies);

		if (provider === "gitlab") {
			const calls = fixture.calls();
			const refused = runCompiled(["chain", "apply", "101", "102", "--native"], fixture.env, cwd);
			expect(refused.exitCode).toBe(EXIT.UNSUPPORTED);
			expect(refused.stdout).toBe("");
			expect(refused.stderr).toContain(notSupportedMessage("--native stack linking"));
			expect(fixture.calls()).toEqual(calls);
			expect(fixture.bodies()).toEqual(bodies);
		}
	});

	test.each(["github", "gitlab"] as const)("creates, lists, views and buckets issues on %s with literal compiled argv and stdin", (provider) => {
		const fixture = statefulProvider(provider);
		const cwd = freshCwd();
		const title = 'Fix 🔧 "quoted" `literal` $(touch never) & ;';
		const body = 'First line ✨\nSecond "line"\n$(touch never) `literal` & <html>\n';
		const create = runCompiled(["file", "create", "--title", title, "--body", body, "--label", "triage", "--repo", "acme/widgets"], fixture.env, cwd);
		expect(create.exitCode).toBe(0);
		expect(JSON.parse(create.stdout)).toMatchObject({ number: 71, labels: ["triage"] });
		const createCall = fixture.calls()[0];
		expect(createCall.args.slice(0, 4)).toEqual(["issue", "create", "--title", title]);
		expect(createCall.args.slice(-2)).toEqual(["-R", "acme/widgets"]);
		if (provider === "github") {
			expect(createCall.args).toContain("--body-file");
			expect(createCall.body).toBe(body);
		} else {
			expect(createCall.args).toContain(`--description=${body}`);
		}

		const list = runCompiled(["file", "list", "--group-by-label", "--limit", "1", "--repo", "acme/widgets"], fixture.env, cwd);
		expect(list.exitCode).toBe(0);
		expect(JSON.parse(list.stdout).triage.map((issue: { number: number }) => issue.number)).toEqual([71]);
		const view = runCompiled(["file", "view", "71", "--repo", "acme/widgets"], fixture.env, cwd);
		expect(view.exitCode).toBe(0);
		expect(JSON.parse(view.stdout)).toMatchObject({ number: 71, state: "OPEN" });

		const bucket = runCompiled(["file", "bucket", "triage", "71", "--create", "--provider", provider, "--repo", "acme/widgets"], fixture.env, cwd);
		expect(bucket.exitCode).toBe(0);
		expect(JSON.parse(bucket.stdout).map((issue: { number: number }) => issue.number)).toEqual([71]);
		const bucketCalls = fixture.calls().slice(-3);
		expect(bucketCalls[0].args).toEqual(provider === "github"
			? ["label", "create", "triage", "-R", "acme/widgets"]
			: ["label", "create", "--name", "triage", "-R", "acme/widgets"]);
		expect(bucketCalls[1].args).toEqual(provider === "github"
			? ["issue", "edit", "71", "--add-label", "triage", "-R", "acme/widgets"]
			: ["issue", "update", "71", "--label", "triage", "-R", "acme/widgets"]);
	});
});
