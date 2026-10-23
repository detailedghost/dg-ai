/** Local demo recording: drives a `dg-skills pw` session, unattended, through `DemoPwDriver` — the fake-browser boundary production and tests substitute independently. */

import { join } from "node:path";
import { partitionTourSteps, type TourScript, type TourStep } from "@dg/common";
import { main } from "../pw/cli";
import type { ClientEnv } from "../pw/core/spec";

export type RenderStepInput = {
	scriptTitle?: string;
	heading?: string;
	body: string;
	index: number;
	total: number;
	phase: "setup" | "tutorial";
	video: boolean;
	target: string | null;
};

export type DemoPwDriver = {
	open(url: string): Promise<void>;
	goto(url: string): Promise<void>;
	renderStep(step: RenderStepInput): Promise<void>;
	click(selector: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	screenshot(filename: string, colorScheme: "light" | "dark"): Promise<void>;
	videoStart(filename: string): Promise<void>;
	videoStop(): Promise<void>;
	close(): Promise<void>;
};

export class DemoPwDriverError extends Error {}

/** Issues one `pw` argv per call, exactly as `dg-skills pw <args>` would from a shell — never reaches into pw's daemon/socket internals directly. */
export function createPwDemoDriver(
	session: string,
	outputDir: string,
	cwd: string = process.cwd(),
): DemoPwDriver {
	const call = async (argv: string[]): Promise<string> => {
		const out: string[] = [];
		const err: string[] = [];
		const env: ClientEnv = {
			cwd,
			out: (text) => out.push(text),
			err: (text) => err.push(text),
		};
		const code = await main([...argv, `--session=${session}`], env);
		if (code !== 0) {
			throw new DemoPwDriverError(
				`pw ${argv[0]} failed (exit ${code}): ${err.join("\n") || out.join("\n")}`,
			);
		}
		return out.join("\n");
	};

	const stepArgs = (step: RenderStepInput): string[] => {
		const args = [
			"tour-step",
			step.body,
			`--index=${step.index}`,
			`--total=${step.total}`,
			`--phase=${step.phase}`,
		];
		if (step.scriptTitle) args.push(`--script-title=${step.scriptTitle}`);
		if (step.heading) args.push(`--heading=${step.heading}`);
		if (step.target) args.push(`--target=${step.target}`);
		if (step.video) args.push("--video");
		return args;
	};

	return {
		async open(url) {
			await call(["open", url, "--scratch", "--out", outputDir]);
		},
		async goto(url) {
			await call(["goto", url]);
		},
		async renderStep(step) {
			await call(stepArgs(step));
		},
		async click(selector) {
			await call(["click", selector]);
		},
		async fill(selector, value) {
			await call(["fill", selector, value]);
		},
		async screenshot(filename, colorScheme) {
			await call(["screenshot", `--filename=${filename}`, `--color-scheme=${colorScheme}`]);
		},
		async videoStart(filename) {
			await call(["video-start", filename]);
		},
		async videoStop() {
			await call(["video-stop"]);
		},
		async close() {
			await call(["close"]);
		},
	};
}

export type LocalRecordArtifacts = {
	screenshots: {
		beforeLight: string;
		beforeDark: string;
		afterLight: string;
		afterDark: string;
	};
	video?: string;
};

const DEFAULT_HOLD_MS = 2500;

function holdMs(step: TourStep): number {
	return typeof step.advance === "number" ? step.advance : DEFAULT_HOLD_MS;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Walks `script`'s tutorial steps unattended through `driver`: setup is assumed already satisfied and every action fires automatically — there is no live user to wait for. */
export async function recordLocalDemo(
	script: TourScript,
	outputDir: string,
	driver: DemoPwDriver,
	/** Overridable so tests don't actually wait out each step's hold time. */
	hold: (ms: number) => Promise<void> = sleep,
): Promise<LocalRecordArtifacts> {
	const { tutorial } = partitionTourSteps(script);
	const video = script.mode === "video";

	await driver.open(script.startUrl);

	const beforeLight = join(outputDir, "before-light.png");
	const beforeDark = join(outputDir, "before-dark.png");
	await driver.screenshot(beforeLight, "light");
	await driver.screenshot(beforeDark, "dark");

	const videoFile = video ? join(outputDir, "recording.webm") : undefined;
	if (videoFile) await driver.videoStart(videoFile);

	let currentUrl = script.startUrl;
	for (const [index, step] of tutorial.entries()) {
		if (step.navigate && step.navigate !== currentUrl) {
			await driver.goto(step.navigate);
			currentUrl = step.navigate;
		}
		await driver.renderStep({
			scriptTitle: script.title,
			heading: step.title,
			body: step.body,
			index,
			total: tutorial.length,
			phase: "tutorial",
			video,
			target: step.selector ?? null,
		});
		if (step.action && step.selector) {
			if (step.action.do === "click") await driver.click(step.selector);
			else await driver.fill(step.selector, step.action.value);
		} else if (step.advance === "click" && step.selector) {
			await driver.click(step.selector);
		}
		await hold(holdMs(step));
	}

	if (videoFile) await driver.videoStop();

	const afterLight = join(outputDir, "after-light.png");
	const afterDark = join(outputDir, "after-dark.png");
	await driver.screenshot(afterLight, "light");
	await driver.screenshot(afterDark, "dark");

	await driver.close();

	return {
		screenshots: { beforeLight, beforeDark, afterLight, afterDark },
		video: videoFile,
	};
}
