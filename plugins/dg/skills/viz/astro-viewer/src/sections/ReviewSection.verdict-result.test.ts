import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A submitted verdict settles into the tab bar's own slot, never a full-screen overlay:
 * approve/comment set the result pill (approve also bursts confetti), request_changes
 * enters the reworking state, and nothing closes the reviewer's tab any more.
 */

const FILE_PATH = join(import.meta.dir, "ReviewSection.astro");

function readSource(): string {
	return readFileSync(FILE_PATH, "utf-8");
}

function extractClientScript(src: string): string {
	const frontmatterEnd = src.indexOf("\n---\n", src.indexOf("---") + 3);
	const searchSrc = frontmatterEnd === -1 ? src : src.slice(frontmatterEnd);
	const scriptTags = [...searchSrc.matchAll(/<script(\s[^>]*)?>/g)];
	for (const tag of scriptTags) {
		const attrs = tag[1] ?? "";
		if (attrs.includes("is:inline")) continue;
		const start = tag.index! + tag[0].length;
		const end = searchSrc.indexOf("</script>", start);
		if (end === -1) continue;
		return searchSrc.slice(start, end);
	}
	throw new Error("no client <script> block found in ReviewSection.astro");
}

/** Balanced-brace extraction that starts scanning for "{" on the signature's own line; keeps a leading "async" so awaits inside stay valid. */
function extractFunctionSource(scriptSrc: string, fnName: string): string {
	let defIdx = scriptSrc.search(new RegExp(`function\\s+${fnName}\\s*\\(`));
	if (defIdx === -1) throw new Error(`function ${fnName} not found in client script`);
	const asyncMatch = /async\s+$/.exec(scriptSrc.slice(0, defIdx));
	if (asyncMatch) defIdx -= asyncMatch[0].length;
	const firstNewline = scriptSrc.indexOf("\n", defIdx);
	const braceStart = scriptSrc.lastIndexOf("{", firstNewline === -1 ? scriptSrc.length : firstNewline);
	let depth = 0;
	for (let i = braceStart; i < scriptSrc.length; i++) {
		if (scriptSrc[i] === "{") depth++;
		else if (scriptSrc[i] === "}") {
			depth--;
			if (depth === 0) return scriptSrc.slice(defIdx, i + 1);
		}
	}
	throw new Error(`unbalanced braces extracting ${fnName}`);
}

describe("ReviewSection.astro — no full-screen result overlay", () => {
	it("keeps the reviewer's tab open: no closeTab, no window.close, no scheduled close", () => {
		const scriptSrc = extractClientScript(readSource());

		expect(scriptSrc).not.toInclude("closeTab");
		expect(scriptSrc).not.toInclude("window.close");
	});

	it("renders no viewport-covering overlay markup for either terminal state", () => {
		const src = readSource();

		expect(src).not.toInclude("DoneOverlay");
		expect(src).not.toInclude("rv-reworking-overlay");
		expect(src).toInclude("rv-verdict-slot");
	});

	it("settles the result inside the verdict slot rather than over the board", () => {
		const src = readSource();
		const slotStyles = src.slice(src.indexOf(".rv-verdict-slot {"));
		const resultBlock = slotStyles.slice(0, slotStyles.indexOf(".rv-result-working {"));

		expect(resultBlock).not.toInclude("position: fixed");
		expect(resultBlock).not.toInclude("position: absolute");
	});
});

describe("ReviewSection.astro — submitReview() verdict routing", () => {
	/** Runs the real extracted submitReview() with every dependency stubbed, and reports what fired. */
	async function runSubmitReview(verdict: "approve" | "request_changes" | "comment") {
		const scriptSrc = extractClientScript(readSource());
		const fnSrc = extractFunctionSource(scriptSrc, "submitReview");
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const jsSrc = transpiler.transformSync(fnSrc);
		const factory = new Function(
			"document",
			"overlay",
			"DATA",
			"readVizMeta",
			"signAnswers",
			"respond",
			"setVerdictResult",
			"celebrateApprove",
			"setDoneFavicon",
			"enterReworkingState",
			"window",
			"buildFileApprovalsPayload",
			"buildLineCommentsPayload",
			`let approveCelebrated = false;\n${jsSrc}\nreturn submitReview;`,
		);

		const calls: { fn: string; args: unknown[] }[] = [];
		const fakeEl = (value = "") => ({ value, textContent: "", disabled: false });
		const fakeDocument = {
			getElementById: () => fakeEl(),
			querySelector: () => fakeEl(verdict),
		};

		const submitReview = factory(
			fakeDocument,
			{ classList: { add: () => {} } },
			{ slug: "test-slug" },
			() => ({ nonce: "n" }),
			async () => "hmac",
			async () => ({ ok: true, status: 200 }),
			(...args: unknown[]) => calls.push({ fn: "setVerdictResult", args }),
			(...args: unknown[]) => calls.push({ fn: "celebrateApprove", args }),
			(...args: unknown[]) => calls.push({ fn: "setDoneFavicon", args }),
			(...args: unknown[]) => calls.push({ fn: "enterReworkingState", args }),
			{ setTimeout: () => calls.push({ fn: "window.setTimeout", args: [] }) },
			() => [],
			() => [],
		) as () => Promise<void>;

		await submitReview();
		return calls;
	}

	it("approve settles the pill as approved and celebrates, without scheduling a close", async () => {
		const calls = await runSubmitReview("approve");

		expect(calls.find((c) => c.fn === "setVerdictResult")?.args).toEqual(["approved"]);
		expect(calls.some((c) => c.fn === "celebrateApprove")).toBe(true);
		expect(calls.some((c) => c.fn === "enterReworkingState")).toBe(false);
		expect(calls.some((c) => c.fn === "window.setTimeout")).toBe(false);
	});

	it("comment settles the pill as commented and never celebrates", async () => {
		const calls = await runSubmitReview("comment");

		expect(calls.find((c) => c.fn === "setVerdictResult")?.args).toEqual(["commented"]);
		expect(calls.some((c) => c.fn === "celebrateApprove")).toBe(false);
		expect(calls.some((c) => c.fn === "enterReworkingState")).toBe(false);
	});

	it("request_changes enters the reworking state and settles no pill itself", async () => {
		const calls = await runSubmitReview("request_changes");

		expect(calls.some((c) => c.fn === "enterReworkingState")).toBe(true);
		expect(calls.some((c) => c.fn === "setVerdictResult")).toBe(false);
		expect(calls.some((c) => c.fn === "celebrateApprove")).toBe(false);
	});
});

describe("ReviewSection.astro — approve confetti", () => {
	it("fires on the submit button's mousedown, gated on the approve verdict", () => {
		const scriptSrc = extractClientScript(readSource());
		const listener = scriptSrc.slice(scriptSrc.indexOf("'rvSubmitReview')?.addEventListener('mousedown'"));
		const body = listener.slice(0, listener.indexOf("\n  })"));

		expect(body).toInclude("rv-verdict");
		expect(body).toInclude("'approve'");
		expect(body).toInclude("celebrateApprove");
	});

	it("bursts at most once per submit so the keyboard path cannot double-fire", () => {
		const scriptSrc = extractClientScript(readSource());
		const fnSrc = extractFunctionSource(scriptSrc, "celebrateApprove");
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const jsSrc = transpiler.transformSync(fnSrc);
		const factory = new Function("burstConfetti", `let approveCelebrated = false;\n${jsSrc}\nreturn celebrateApprove;`);

		let bursts = 0;
		const celebrateApprove = factory(() => {
			bursts++;
		}) as () => void;

		celebrateApprove();
		celebrateApprove();
		celebrateApprove();

		expect(bursts).toBe(1);
	});

	it("reuses the shared confetti helper rather than a local burst", () => {
		const src = readSource();

		expect(src).toInclude("import { burstConfetti } from '../lib/confetti.ts'");
	});
});
