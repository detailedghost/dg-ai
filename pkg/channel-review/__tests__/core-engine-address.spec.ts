import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { CrCode } from "../src/errors";
import { ownerName, replyText } from "../src/errors";
import type { EngineHarness, HarnessOptions } from "./support/fakes";
import {
	addressMessage,
	BOT_NAME,
	buildMessage,
	createEngineHarness,
	OK_RESULT,
	OTHER_ID,
	PR_URL,
	reviewMessage,
} from "./support/fakes";

const harnesses: EngineHarness[] = [];
function setup(options: HarnessOptions = {}): EngineHarness {
	const harness = createEngineHarness(options);
	harnesses.push(harness);
	return harness;
}
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const SUCCESS_TRAIL = [
	"+pending",
	"-pending",
	"+inProgress",
	"-inProgress",
	"+approved",
];
const FAILURE_TRAIL = [
	"+pending",
	"-pending",
	"+inProgress",
	"-inProgress",
	"+failure",
];
const READY = `✅ Addressed #12 ${PR_URL}. Ready for re-review.`;

const crText = (h: EngineHarness, code: CrCode): string =>
	replyText(code, {
		agent: "claude",
		minutes: h.config.runner.addressTimeoutMinutes,
		owner: ownerName(h.config.owner.token),
	});

const cloneRoot = (h: EngineHarness): string => h.config.address.cloneRoot;

describe("engine $address", () => {
	test("reacts pending, inProgress, approved and replies ready for re-review", async () => {
		const h = setup();
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual(SUCCESS_TRAIL);
		expect(h.replies().map((reply) => reply.text)).toEqual([READY]);
		expect(h.trail("sent-1")).toEqual(["+approved"]);
		expect(h.state.get().handled.m1?.status).toBe("done");
	});

	test("runs claude's /address in the fresh clone with the address timeout", async () => {
		const h = setup({
			configExtra: { runner: { default: "codex", addressTimeoutMinutes: 5 } },
		});
		await h.engine.handle(addressMessage("m1", PR_URL, "~no-ci"));
		await h.engine.idle();
		const dir = join(cloneRoot(h), "github.com-o-r-m1");
		expect(h.workspace.clones).toEqual([
			{ url: PR_URL, host: "github", branch: "feature", dir },
		]);
		expect(h.runners.codex.runs).toHaveLength(0);
		expect(h.runner.runs).toHaveLength(1);
		expect(h.runner.runs[0]).toMatchObject({
			task: "address",
			noCi: true,
			cwd: dir,
			timeoutMs: 5 * 60_000,
		});
		expect(basename(h.runner.runs[0]?.logPath ?? "")).toBe("m1.log");
	});

	test("deletes the clone after success and after failure", async () => {
		let seen = false;
		const h = setup({
			runnerScript: (run) => {
				seen = existsSync(run.cwd);
				return { ...OK_RESULT, status: 1 };
			},
		});
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(seen).toBe(true);
		expect(readdirSync(cloneRoot(h))).toEqual([]);
	});

	test("reacts failure on the trigger and the reply when /address fails", async () => {
		const h = setup({ runnerScript: () => ({ ...OK_RESULT, status: 1 }) });
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual(FAILURE_TRAIL);
		expect(h.replies().map((reply) => reply.text)).toEqual([
			crText(h, "CR-203"),
		]);
		expect(h.trail("sent-1")).toEqual(["+failure"]);
		expect(h.state.get().handled.m1?.status).toBe("failed");
	});

	test("reports the address timeout in minutes", async () => {
		const h = setup({
			runnerScript: () => ({ ...OK_RESULT, status: null, timedOut: true }),
		});
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(h.replies().map((reply) => reply.text)).toEqual([
			crText(h, "CR-204"),
		]);
		expect(crText(h, "CR-204")).toContain("60 minutes");
	});

	test("refuses a fork PR without cloning", async () => {
		const h = setup();
		h.workspace.nextHead = { ...h.workspace.nextHead, fork: true };
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual(FAILURE_TRAIL);
		expect(h.replies().map((reply) => reply.text)).toEqual([
			crText(h, "CR-305"),
		]);
		expect(h.workspace.clones).toEqual([]);
		expect(h.runner.runs).toEqual([]);
	});

	test.each([
		["CR-302", "CR-302"],
		["CR-303", "CR-303"],
	] as const)("maps a PR head error %s to its code", async (thrown, code) => {
		const h = setup();
		h.workspace.headError = thrown;
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(h.replies().map((reply) => reply.text)).toEqual([crText(h, code)]);
	});

	test("reports CR-306 when the clone fails and runs nothing", async () => {
		const h = setup();
		h.workspace.cloneError = "CR-306";
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(h.replies().map((reply) => reply.text)).toEqual([
			crText(h, "CR-306"),
		]);
		expect(h.runner.runs).toEqual([]);
	});

	test("does not change the blocked registry", async () => {
		const h = setup();
		h.state.markBlocked(PR_URL, "m0", { comment: false, fun: false }, "chat-1");
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(Object.keys(h.state.get().blocked)).toEqual([PR_URL]);
	});

	test("never treats the bot's ready for re-review reply as a readiness message", async () => {
		const h = setup();
		h.state.markBlocked(PR_URL, "m0", { comment: false, fun: false }, "chat-1");
		await h.engine.handle(
			buildMessage("bot-1", `<p>${READY}</p>`, {
				from: { id: "bot", name: BOT_NAME, isBot: true },
			}),
		);
		await h.engine.idle();
		expect(h.runner.runs).toEqual([]);
		expect(h.provider.calls).toEqual([]);
	});

	test("refuses $address with $review in one message", async () => {
		const h = setup();
		await h.engine.handle(addressMessage("m1", PR_URL, "$review"));
		await h.engine.idle();
		expect(h.replies().map((reply) => reply.text)).toEqual([
			crText(h, "CR-105"),
		]);
		expect(h.runner.runs).toEqual([]);
	});
});

describe("engine $address sender gate", () => {
	test("refuses a sender outside owner.senderIds with CR-106 and logs the id", async () => {
		const h = setup();
		await h.engine.handle(addressMessage("m1", PR_URL, "", OTHER_ID));
		await h.engine.idle();
		expect(h.runner.runs).toEqual([]);
		expect(h.trail("m1")).toEqual(["+failure"]);
		expect(h.replies().map((reply) => reply.text)).toEqual([
			crText(h, "CR-106"),
		]);
		expect(h.state.get().handled.m1?.status).toBe("failed");
		expect(h.log.lines).toContainEqual({
			level: "info",
			message: `message m1 $address refused: sender Owner (${OTHER_ID}) is not in owner.senderIds`,
		});
	});

	test("refuses everyone when senderIds is empty and allowAnySender is off", async () => {
		const h = setup({ configExtra: { owner: { token: "!owner", email: "owner@example.com" } } });
		await h.engine.handle(addressMessage("m1"));
		await h.engine.idle();
		expect(h.replies().map((reply) => reply.text)).toEqual([
			crText(h, "CR-106"),
		]);
	});

	test("lets anyone run $address when allowAnySender is on", async () => {
		const h = setup();
		h.config.address.allowAnySender = true;
		h.workspace.cloneError = "CR-306";
		await h.engine.handle(addressMessage("m1", PR_URL, "", OTHER_ID));
		await h.engine.idle();
		expect(h.workspace.clones).toHaveLength(1);
	});

	test("still runs a review from a sender outside owner.senderIds", async () => {
		const h = setup();
		await h.engine.handle({
			...reviewMessage("m1"),
			from: { id: OTHER_ID, name: "Other", isBot: false },
		});
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(1);
	});
});

describe("engine recover with clones", () => {
	test("removes leftover clones of interrupted jobs only", async () => {
		const h = setup();
		const root = cloneRoot(h);
		for (const name of [
			"github.com-o-r-m1",
			"github.com-o-r-m2",
			"github.com-o-r-m3",
		]) {
			mkdirSync(join(root, name), { recursive: true });
		}
		h.state.markHandled("m1", "running", "chat-1");
		h.state.markHandled("m2", "done", "chat-1");
		await h.engine.recover({
			isAlive: () => false,
			listArgs: () => "",
			startTime: () => undefined,
			killTree: () => {},
		});
		expect(readdirSync(root).sort()).toEqual([
			"github.com-o-r-m2",
			"github.com-o-r-m3",
		]);
	});
});
