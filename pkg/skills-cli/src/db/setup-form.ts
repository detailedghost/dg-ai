import {
	type CredentialClient,
	createCredentialClient,
	resolveDgPaths,
	tryOpen,
} from "@dg/common/node";
import type { SetupPlan } from "./setup";

const POLL_MS = 1_000;

export class SecretFormExpiredError extends Error {
	constructor() {
		super("The secret link expired before a value was saved.");
	}
}

export type SetupFormClient = Pick<CredentialClient, "intake" | "list" | "close">;

export interface SetupFormDeps {
	createClient(session: string): SetupFormClient;
	open(url: string): Promise<boolean>;
	now(): number;
	sleep(ms: number): Promise<void>;
	stdout(line: string): void;
}

/** Waits for the human to save the value on a one-time daemon page. */
export async function runSetupForm(
	plan: SetupPlan,
	deps: SetupFormDeps,
): Promise<void> {
	const name = `db/${plan.name}`;
	const stored = async (client: SetupFormClient) =>
		(await client.list()).find((entry) => entry.name === name.toLowerCase())
			?.updatedAt;
	const client = deps.createClient(plan.session);
	try {
		const before = await stored(client);
		const { url, expiresAt } = await client.intake(name, plan.meta);
		deps.stdout(
			(await deps.open(url))
				? "Opened the secret form in your browser. Type the password there."
				: `Open this link in your browser and type the password there: ${url}`,
		);
		const deadline = Date.parse(expiresAt);
		while (true) {
			await deps.sleep(POLL_MS);
			if ((await stored(client)) !== before) return;
			if (!(deps.now() < deadline)) throw new SecretFormExpiredError();
		}
	} finally {
		client.close();
	}
}

export function createSetupForm(
	stdout: (line: string) => void,
): (plan: SetupPlan) => Promise<void> {
	return (plan) =>
		runSetupForm(plan, {
			createClient: (session) =>
				createCredentialClient({ paths: resolveDgPaths(), session }),
			open: (url) => tryOpen(url),
			now: Date.now,
			sleep: (ms) => Bun.sleep(ms),
			stdout,
		});
}
