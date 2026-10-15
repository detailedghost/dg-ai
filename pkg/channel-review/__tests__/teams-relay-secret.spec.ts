import { describe, expect, test } from "bun:test";
import { fetchRelaySecret } from "../src/providers/teams-relay";

type Capture = { status: number; signal: null; stdout: string; stderr: string };
type Call = { command: string; args: string[] };

const PARAMS = {
	profile: "example-dev",
	region: "us-east-1",
	id: "relay/chat",
	key: "RELAY__CHAT__SECRET",
};
const SECRET_VALUE = "super-secret-value-123";

function seams(
	result: Partial<Capture>,
	which: string | null = "/usr/bin/aws",
) {
	const calls: Call[] = [];
	return {
		calls,
		runCapture: async (command: string, args: string[]): Promise<Capture> => {
			calls.push({ command, args });
			return { status: 0, signal: null, stdout: "", stderr: "", ...result };
		},
		which: () => which,
	};
}

describe("fetchRelaySecret", () => {
	test("returns the configured key from the JSON secret string", async () => {
		const fake = seams({
			stdout: `${JSON.stringify({ [PARAMS.key]: SECRET_VALUE, other: "x" })}\n`,
		});
		await expect(fetchRelaySecret(PARAMS, fake)).resolves.toBe(SECRET_VALUE);
	});

	test("runs aws secretsmanager get-secret-value with the profile and region", async () => {
		const fake = seams({
			stdout: JSON.stringify({ [PARAMS.key]: SECRET_VALUE }),
		});
		await fetchRelaySecret(PARAMS, fake);
		expect(fake.calls).toEqual([
			{
				command: "aws",
				args: [
					"secretsmanager",
					"get-secret-value",
					"--secret-id",
					PARAMS.id,
					"--region",
					PARAMS.region,
					"--profile",
					PARAMS.profile,
					"--query",
					"SecretString",
					"--output",
					"text",
				],
			},
		]);
	});

	test("reports a missing aws CLI without running anything", async () => {
		const fake = seams({}, null);
		await expect(fetchRelaySecret(PARAMS, fake)).rejects.toThrow(
			"aws CLI not found",
		);
		expect(fake.calls).toHaveLength(0);
	});

	test.each([
		["sso", "The SSO session associated with this profile has expired"],
		["token", "Error loading Token for profile"],
		["expired", "credentials have expired"],
	])("maps stderr mentioning %s to the login remedy", async (_name, stderr) => {
		const fake = seams({ status: 255, stderr, stdout: SECRET_VALUE });
		await expect(fetchRelaySecret(PARAMS, fake)).rejects.toThrow(
			`AWS SSO session expired. Run: aws sso login --profile ${PARAMS.profile}`,
		);
	});

	test("reports a spawn failure without leaking the secret id arguments or stdout", async () => {
		const failing = {
			runCapture: async () => {
				throw new Error(`spawn failed ${SECRET_VALUE}`);
			},
			which: () => "/usr/bin/aws",
		};
		const failure = await fetchRelaySecret(PARAMS, failing).catch(
			(error: Error) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain(SECRET_VALUE);
	});

	test("rejects a key whose value is an empty string", async () => {
		const fake = seams({ stdout: JSON.stringify({ [PARAMS.key]: "" }) });
		await expect(fetchRelaySecret(PARAMS, fake)).rejects.toThrow(
			`secret ${PARAMS.id} has no key ${PARAMS.key}`,
		);
	});

	test("reports a generic failure without echoing stdout", async () => {
		const fake = seams({
			status: 1,
			stderr: "AccessDenied",
			stdout: SECRET_VALUE,
		});
		const failure = await fetchRelaySecret(PARAMS, fake).catch(
			(error: Error) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain(SECRET_VALUE);
	});

	test("reports a non-JSON secret without echoing stdout", async () => {
		const fake = seams({ stdout: `not-json-${SECRET_VALUE}` });
		const failure = await fetchRelaySecret(PARAMS, fake).catch(
			(error: Error) => error,
		);
		expect((failure as Error).message).toContain("secret is not JSON");
		expect((failure as Error).message).not.toContain(SECRET_VALUE);
	});

	test("reports a missing key naming the secret id and key but never stdout", async () => {
		const fake = seams({ stdout: JSON.stringify({ other: SECRET_VALUE }) });
		const failure = await fetchRelaySecret(PARAMS, fake).catch(
			(error: Error) => error,
		);
		expect((failure as Error).message).toContain(
			`secret ${PARAMS.id} has no key ${PARAMS.key}`,
		);
		expect((failure as Error).message).not.toContain(SECRET_VALUE);
	});
});
