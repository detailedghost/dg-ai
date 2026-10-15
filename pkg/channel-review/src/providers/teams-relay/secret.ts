import { isRecord } from "@dg/common";
import { runCapture as defaultRunCapture } from "@dg/common/node";

type Capture = {
	status: number;
	signal: unknown;
	stdout: string;
	stderr: string;
};

export type SecretSeams = {
	runCapture?: (command: string, args: string[]) => Promise<Capture>;
	which?: (command: string) => string | null;
};

export type SecretParams = {
	profile: string;
	region: string;
	id: string;
	key: string;
};

export async function fetchRelaySecret(
	{ profile, region, id, key }: SecretParams,
	{ runCapture = defaultRunCapture, which = Bun.which }: SecretSeams = {},
): Promise<string> {
	if (which("aws") === null) throw new Error("aws CLI not found");
	const result = await runCapture("aws", [
		"secretsmanager",
		"get-secret-value",
		"--secret-id",
		id,
		"--region",
		region,
		"--profile",
		profile,
		"--query",
		"SecretString",
		"--output",
		"text",
	]).catch(() => {
		throw new Error("aws secretsmanager call could not start");
	});
	if (result.status !== 0) {
		if (/sso|token|expired/i.test(result.stderr)) {
			throw new Error(
				`AWS SSO session expired. Run: aws sso login --profile ${profile}`,
			);
		}
		throw new Error(
			`aws secretsmanager call failed with exit code ${result.status}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("secret is not JSON");
	}
	const value = isRecord(parsed) ? parsed[key] : undefined;
	if (typeof value !== "string" || value === "") {
		throw new Error(`secret ${id} has no key ${key}`);
	}
	return value;
}
