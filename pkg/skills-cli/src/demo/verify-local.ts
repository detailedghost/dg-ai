import { envReference, MissingEnvError, type TourScript } from "@dg/common";
import { wslChromiumArgs } from "@dg/common/node";
import type { Page } from "playwright-core";
import { pickLaunch } from "../pw/core/browser";
import type { VerifyResult } from "../utils/demo-verify";
import { PasswordFieldError, playbackSteps, recordTour, StepError, VIEWPORT } from "./recorder/drive";

export type VerifySession = { page: Page; close(): Promise<void> };

export type VerifyLocalDeps = {
	open(): Promise<VerifySession>;
	env?: Record<string, string | undefined>;
};

export async function openLocalSession(): Promise<VerifySession> {
	const { chromium } = await import("playwright-core");
	const pick = pickLaunch();
	const browser = await chromium.launch({
		headless: true,
		...("channel" in pick
			? { channel: pick.channel }
			: { executablePath: pick.executablePath }),
		args: wslChromiumArgs(),
	});
	try {
		const context = await browser.newContext({ viewport: VIEWPORT });
		return {
			page: await context.newPage(),
			close: () => browser.close().catch(() => undefined),
		};
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}

const harnessError = (error: unknown): VerifyResult => ({
	ok: false,
	findings: [
		{
			step: 0,
			kind: "harness-error",
			message: error instanceof Error ? error.message : String(error),
		},
	],
});

const flattenSetup = (script: TourScript): TourScript => {
	const { setup } = script;
	if (!setup || setup.includeInTour) return script;
	const [first, ...rest] = script.steps;
	const steps =
		first && !first.navigate && setup.steps.length > 0
			? [{ ...first, navigate: script.startUrl }, ...rest]
			: script.steps;
	return { ...script, steps, setup: { ...setup, includeInTour: true } };
};

function findingFor(error: unknown, script: TourScript): VerifyResult {
	const steps = playbackSteps(script);
	if (error instanceof PasswordFieldError)
		return {
			ok: false,
			findings: [{ step: error.index + 1, kind: "harness-error", message: error.message }],
		};
	if (error instanceof StepError)
		return {
			ok: false,
			findings: [
				{
					step: error.index + 1,
					kind: "selector-unresolved",
					selector: steps[error.index]?.step.selector ?? "",
				},
			],
		};
	if (error instanceof MissingEnvError) {
		const at = steps.findIndex(
			({ step }) =>
				step.action?.do === "fill" && envReference(step.action.value) === error.variable,
		);
		return {
			ok: false,
			findings: [{ step: at + 1, kind: "env-unset", variable: error.variable }],
		};
	}
	return harnessError(error);
}

export async function verifyLocal(
	given: TourScript,
	deps: VerifyLocalDeps = { open: openLocalSession },
): Promise<VerifyResult> {
	const script = flattenSetup(given);
	let session: VerifySession;
	try {
		session = await deps.open();
	} catch (error) {
		return harnessError(error);
	}
	try {
		await recordTour(session.page, script, {
			env: deps.env ?? process.env,
			overlays: false,
			hold: () => 0,
		});
		return { ok: true, findings: [] };
	} catch (error) {
		return findingFor(error, script);
	} finally {
		await session.close().catch(() => undefined);
	}
}
