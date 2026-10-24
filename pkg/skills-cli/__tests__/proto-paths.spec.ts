import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateStyleGuide } from "@dg/common";
import {
	normalizeColor,
	styleGuideFromSamples,
} from "../../extension/lib/features/prototype";
import { protoScratchPath, protoSlug } from "../src/utils/proto-paths";
import { protoCliHarness, protoDaemonFixture } from "./proto-cli-harness";

function buildRawSamples() {
	return {
		meta: {
			url: "https://example.test/account",
			scrapedAt: 1_721_234_567_890,
			sameOrigin: true,
		},
		customProps: { "--z-index": "10", "--brand": "#111111" },
		colors: ["#ffffff", "#111111", "#111111", "#00aaff", "#ffffff", "#111111"],
		fontStacks: ["Inter, sans-serif", "Inter, sans-serif"],
		typeScale: ["14px", "16px", "16px", "24px"],
		spacing: ["8px", "4px", "16px", "8px", "4px"],
		radii: ["8px", "4px", "8px", "4px"],
		shadows: [
			"0 1px 2px rgb(0 0 0 / 0.1)",
			"0 2px 8px rgb(0 0 0 / 0.15)",
			"0 1px 2px rgb(0 0 0 / 0.1)",
		],
		components: {
			button: { "z-index": "1", background: "#111111" },
			input: { color: "#111111", border: "1px solid #111111" },
			link: { "font-weight": "600", color: "#00aaff" },
		},
		controls: [],
	};
}

describe("prototype paths", () => {
	test("builds stable scratch and collision-resistant URL paths", () => {
		const firstUrl = "https://example.test/account/summary";
		const secondUrl = "https://example.test/account/settings";
		const firstSlug = protoSlug(firstUrl);

		expect(protoSlug(firstUrl)).toBe(firstSlug);
		expect(firstSlug).toMatch(/^example-test-account-summary-[a-f0-9]{8}$/);
		expect(protoSlug(secondUrl)).not.toBe(firstSlug);
		expect(protoSlug(`${firstUrl}?view=compact`)).not.toBe(firstSlug);
		expect(
			protoSlug(`https://example.test/${"nested-path/".repeat(40)}`),
		).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/);
		expect(
			protoScratchPath(firstSlug, "style-guide.json", {
				env: { AI_SCRATCH_DIR: "/agent-scratch" },
				homeDir: "/home/ada",
			}),
		).toBe(join("/agent-scratch", "proto", firstSlug, "style-guide.json"));
		expect(
			protoScratchPath(firstSlug, "style-guide.json", {
				env: {},
				homeDir: "/home/ada",
			}),
		).toBe(join("/home/ada", ".dg", "proto", firstSlug, "style-guide.json"));
	});
});

describe("styleGuideFromSamples", () => {
	test("frequency-ranks colors and deterministically quantizes repeated tokens", () => {
		const raw = buildRawSamples();

		const first = styleGuideFromSamples(raw);
		const second = styleGuideFromSamples(structuredClone(raw));

		expect(validateStyleGuide(first)).toBe(first);
		expect(second).toEqual(first);
		expect(first.tokens.colors).toEqual([
			"rgb(17, 17, 17)",
			"rgb(255, 255, 255)",
			"rgb(0, 170, 255)",
		]);
		expect(first.tokens.spacing).toEqual(["4px", "8px", "16px"]);
		expect(first.tokens.radii).toEqual(["4px", "8px"]);
		expect(first.tokens.shadows).toEqual([
			"0 1px 2px rgb(0 0 0 / 0.1)",
			"0 2px 8px rgb(0 0 0 / 0.15)",
		]);
		expect(Object.keys(first.tokens.customProps)).toEqual([
			"--brand",
			"--z-index",
		]);
		expect(Object.keys(first.components.button)).toEqual([
			"background",
			"z-index",
		]);
		expect(Object.keys(first.components.input)).toEqual(["border", "color"]);
	});

	test("normalizes equivalent colors and uses first occurrence as the tie-break", () => {
		const raw = buildRawSamples();
		raw.colors = [
			"#fff",
			"rgb(0 0 0)",
			"rgb(255, 255, 255)",
			"#000000",
			"rgba(255 255 255 / 100%)",
			"transparent",
			"rgba(0, 0, 0, 0)",
		];

		const guide = styleGuideFromSamples(raw);

		expect(normalizeColor("#0af8")).toBe("rgba(0, 170, 255, 0.533)");
		expect(guide.tokens.colors).toEqual([
			"rgb(255, 255, 255)",
			"rgb(0, 0, 0)",
			"rgba(0, 0, 0, 0)",
		]);
	});
});

describe("proto --ext scrape, daemon relay through a fake extension peer", () => {
	test("writes the extension's style guide to scratch, never to a download", async () => {
		const h = protoCliHarness();
		const styleGuide = styleGuideFromSamples(buildRawSamples());
		const server = protoDaemonFixture(h, (request, reply) => {
			reply({
				type: "cli-proto-result",
				sessionId: "fixture-cli-session",
				requestId: request.requestId,
				ok: true,
				data: { kind: "style-guide", styleGuide },
			});
		});
		try {
			const url = "https://example.test/account";
			const slug = protoSlug(url);
			const result = await h.run(
				["scrape", url, "--session", server.sessionId],
				{},
				{ timeoutMs: 5000 },
			);
			const expectedScratch = protoScratchPath(slug, "style-guide.json", {
				env: { AI_SCRATCH_DIR: h.scratch },
			});

			expect(result.code).toBe(0);
			expect(result.stdout).toContain(expectedScratch);
			expect(JSON.parse(await readFile(expectedScratch, "utf8"))).toEqual(
				styleGuide,
			);
		} finally {
			server.stop();
			h.cleanup();
		}
	});

	test("reports a typed not-ready error with its code and landed URL instead of a Downloads timeout", async () => {
		const h = protoCliHarness();
		const server = protoDaemonFixture(h, (request, reply) => {
			reply({
				type: "cli-proto-result",
				sessionId: "fixture-cli-session",
				requestId: request.requestId,
				ok: false,
				notReady: {
					code: "login-page",
					message: "The page looks like a sign-in page.",
					landedUrl: "https://example.test/login?next=/account",
				},
			});
		});
		try {
			const result = await h.run(
				["scrape", "https://example.test/account", "--session", server.sessionId],
				{},
				{ timeoutMs: 5000 },
			);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("login-page");
			expect(result.stderr).toContain("sign-in page");
			expect(result.stderr).toContain("https://example.test/login?next=/account");
		} finally {
			server.stop();
			h.cleanup();
		}
	});

	test("surfaces the daemon's error verbatim when the extension reports a transport failure", async () => {
		const h = protoCliHarness();
		const server = protoDaemonFixture(h, (request, reply) => {
			reply({
				type: "cli-proto-result",
				sessionId: "fixture-cli-session",
				requestId: request.requestId,
				ok: false,
				error: "the extension could not open a tab for this URL",
			});
		});
		try {
			const result = await h.run(
				["scrape", "https://example.test/account", "--session", server.sessionId],
				{},
				{ timeoutMs: 5000 },
			);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"the extension could not open a tab for this URL",
			);
		} finally {
			server.stop();
			h.cleanup();
		}
	});

	test("rejects a malformed style guide from the extension before writing scratch", async () => {
		const h = protoCliHarness();
		const server = protoDaemonFixture(h, (request, reply) => {
			reply({
				type: "cli-proto-result",
				sessionId: "fixture-cli-session",
				requestId: request.requestId,
				ok: true,
				data: { kind: "style-guide", styleGuide: { ready: true } },
			});
		});
		try {
			const url = "https://example.test/invalid-guide";
			const slug = protoSlug(url);
			const result = await h.run(
				["scrape", url, "--session", server.sessionId],
				{},
				{ timeoutMs: 5000 },
			);
			const expectedScratch = protoScratchPath(slug, "style-guide.json", {
				env: { AI_SCRATCH_DIR: h.scratch },
			});

			expect(result.code).toBe(1);
			expect(result.stderr).toMatch(/Invalid response from the extension/i);
			await expect(readFile(expectedScratch, "utf8")).rejects.toThrow();
		} finally {
			server.stop();
			h.cleanup();
		}
	});

	test("gives up without ever polling a Downloads folder when the daemon never answers", async () => {
		const h = protoCliHarness();
		const server = protoDaemonFixture(h, () => {});
		try {
			const result = await h.run(
				[
					"scrape",
					"https://example.test/no-reply",
					"--session",
					server.sessionId,
					"--timeout",
					"60",
				],
				{},
				{ timeoutMs: 7500 },
			);

			expect(result.code).toBe(1);
			expect(result.stderr).toMatch(/dg-daemon did not answer/i);
			expect(result.stderr).not.toMatch(/Downloads/i);
			expect(result.stderr).not.toMatch(/crdownload/i);
		} finally {
			server.stop();
			h.cleanup();
		}
	}, 8000);
});
