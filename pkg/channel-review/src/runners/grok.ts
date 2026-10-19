import { isRecord } from "@dg/common";
import type { runCapture } from "@dg/common/node";
import { CLI_TIMEOUT_MS } from "./probe";
import type { Runner } from "./types";

const AUTH_FAILURE =
	/^(?:error:\s*)?(?:not signed in\b|not logged in\b|not authenticated\b|please run `?grok login\b|invalid API key\b|authentication failed\b|your auth token is invalid or expired\b|401 unauthorized\b|error:\s.*401 unauthorized\b)/im;

export function grokAuthFailure(output: string): boolean {
	return output.split(/\r?\n/).some((line) => {
		if (AUTH_FAILURE.test(line)) return true;
		try {
			const event: unknown = JSON.parse(line);
			return (
				isRecord(event) &&
				event.type === "error" &&
				typeof event.message === "string" &&
				AUTH_FAILURE.test(event.message)
			);
		} catch {
			return false;
		}
	});
}

/** Utility commands only: neither command submits a prompt to a model. */
export async function probeGrok(
	path: string,
	cwd: string,
	capture: typeof runCapture,
): ReturnType<Runner["probe"]> {
	try {
		const models = await capture(path, ["models"], {
			cwd,
			timeoutMs: CLI_TIMEOUT_MS,
		});
		if (
			/^You are not authenticated\.$/m.test(models.stdout) ||
			grokAuthFailure(`${models.stdout}\n${models.stderr}`)
		) {
			return { ok: false, code: "CR-202" };
		}
		if (
			models.status !== 0 ||
			!/^(?:You are using XAI_API_KEY\.|You are logged in with .+\.|Model '.+' is using its own API key\.|You are authenticated via deployment key\.)$/m.test(
				models.stdout,
			)
		) {
			return { ok: false, code: "CR-203" };
		}
		const inspected = await capture(path, ["inspect", "--json"], {
			cwd,
			timeoutMs: CLI_TIMEOUT_MS,
		});
		if (inspected.status !== 0) return { ok: false, code: "CR-203" };
		const report: unknown = JSON.parse(inspected.stdout);
		if (!isRecord(report) || !Array.isArray(report.skills))
			return { ok: false, code: "CR-203" };
		const installed = report.skills.some(
			(skill: unknown) =>
				isRecord(skill) &&
				skill.name === "thrash" &&
				skill.userInvocable === true &&
				skill.disabled !== true &&
				skill.compatibilityStatus !== "disabled" &&
				!skill.collidesWith,
		);
		return installed ? { ok: true } : { ok: false, code: "CR-206" };
	} catch (error) {
		return {
			ok: false,
			code:
				(error as NodeJS.ErrnoException)?.code === "ENOENT"
					? "CR-201"
					: "CR-203",
		};
	}
}
