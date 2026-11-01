import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { InboxBrowserRequest, InboxBrowserResponse } from "@dg/common";
import { isWSL, resolveDgPaths } from "@dg/common/node";
import {
	createPwBrowserRequest,
	isProtonMailOrigin,
	PROTON_MAIL_URL,
	PROTON_SESSION_NAME,
	PROTON_SIGN_IN_COMMAND,
	type ProtonPwSession,
	type ProtonPwSessionSpec,
	ProtonSignedOutError,
	protonProfilePaths,
} from "@dg/inbox";

export { PROTON_SIGN_IN_COMMAND, ProtonSignedOutError, protonProfilePaths };

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const SIGN_IN_POLL_MS = 2_000;

export type PwRunner = (
	argv: string[],
) => Promise<{ code: number; out: string; err: string }>;

export type SignInDeps = {
	openSession(spec: ProtonPwSessionSpec): Promise<ProtonPwSession>;
	sleep(ms: number): Promise<void>;
	log(line: string): void;
	timeoutMs?: number;
};

export const protonDataDir = (): string => resolveDgPaths().stateDir;

export const isProtonSignedIn = (dataDir: string): boolean =>
	readSignedInMarker(dataDir) !== undefined;

export function assertProtonSignedIn(dataDir: string): void {
	if (!isProtonSignedIn(dataDir)) throw new ProtonSignedOutError();
}

export type ProtonProfileLocation = "windows" | "local";

export type ProtonSignInMarker = {
	signedInAt?: string;
	profile?: ProtonProfileLocation;
};

export const protonProfileLocation = (): ProtonProfileLocation =>
	isWSL() ? "windows" : "local";

export function writeSignedInMarker(
	dataDir: string,
	profile: ProtonProfileLocation = protonProfileLocation(),
): void {
	const { markerPath } = protonProfilePaths(dataDir);
	mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
	const temporary = `${markerPath}.${process.pid}.tmp`;
	const marker: ProtonSignInMarker = {
		signedInAt: new Date().toISOString(),
		profile,
	};
	writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
	renameSync(temporary, markerPath);
}

export function readSignedInMarker(
	dataDir: string,
): ProtonSignInMarker | undefined {
	const { markerPath } = protonProfilePaths(dataDir);
	if (!existsSync(markerPath)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return undefined;
	const { signedInAt, profile } = parsed as Record<string, unknown>;
	return {
		...(typeof signedInAt === "string" ? { signedInAt } : {}),
		...(profile === "windows" || profile === "local" ? { profile } : {}),
	};
}

export function clearSignedInMarker(dataDir: string): void {
	rmSync(protonProfilePaths(dataDir).markerPath, { force: true });
}

async function runPw(argv: string[]) {
	const { main } = await import("../pw/cli");
	let out = "";
	let err = "";
	const code = await main(argv, {
		cwd: process.cwd(),
		out: (text) => void (out += `${text}\n`),
		err: (text) => void (err += `${text}\n`),
	});
	return { code, out: out.trim(), err: err.trim() };
}

function headerValue(text: string, name: string): string | undefined {
	const matches = [
		...text.matchAll(new RegExp(`^\\s+${name}:\\s*(.+)$`, "gim")),
	];
	return matches.at(-1)?.[1]?.trim();
}

export async function openProtonSession(
	spec: ProtonPwSessionSpec,
	run: PwRunner = runPw,
): Promise<ProtonPwSession> {
	const session = `-s=${spec.name}`;
	const placement =
		protonProfileLocation() === "windows"
			? ["--windows"]
			: ["--profile", spec.profileDir];
	const opened = await run([
		session,
		"open",
		...placement,
		...(spec.headless ? ["--headless"] : []),
		spec.url ?? PROTON_MAIL_URL,
	]);
	if (opened.code !== 0)
		throw new Error(
			`Could not open the Proton pw profile: ${opened.err.split("\n")[0] ?? "unknown error"}`,
		);
	const evaluate = async (source: string): Promise<unknown> => {
		const result = await run([session, "--raw", "eval", source]);
		if (result.code !== 0) throw new Error("Proton page evaluation failed.");
		return JSON.parse(result.out);
	};
	return {
		page: {
			url: async () => String(await evaluate("location.href")),
			observedHeaders: async () => {
				const listing = await run([
					session,
					"--raw",
					"network",
					"--request-headers",
					"--filter",
					"/api/",
				]);
				const uid = headerValue(listing.out, "x-pm-uid");
				if (!uid) return undefined;
				const appVersion = headerValue(listing.out, "x-pm-appversion");
				const locale = headerValue(listing.out, "x-pm-locale");
				return {
					uid,
					...(appVersion ? { appVersion } : {}),
					...(locale ? { locale } : {}),
				};
			},
			evaluate: (script, call) =>
				evaluate(`async () => (${script})(${JSON.stringify(call)})`),
		},
		close: async () => void (await run([session, "close"])),
	};
}

export function protonPwRuntime(
	dataDir: string,
	openSession: (
		spec: ProtonPwSessionSpec,
	) => Promise<ProtonPwSession> = openProtonSession,
): {
	pwBrowserRequest(request: InboxBrowserRequest): Promise<InboxBrowserResponse>;
	close(): Promise<void>;
} {
	const transport = createPwBrowserRequest({
		dataDir,
		openSession,
	});
	return {
		close: transport.close,
		async pwBrowserRequest(request) {
			assertProtonSignedIn(dataDir);
			try {
				return await transport.browserRequest(request);
			} catch (error) {
				if (error instanceof ProtonSignedOutError) clearSignedInMarker(dataDir);
				throw error;
			}
		},
	};
}

const realSignInDeps: SignInDeps = {
	openSession: (spec) => openProtonSession(spec),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	log: (line) => console.error(line),
};

export async function runProtonSignIn(
	dataDir: string,
	deps: SignInDeps = realSignInDeps,
): Promise<void> {
	const { profileDir } = protonProfilePaths(dataDir);
	const session = await deps.openSession({
		name: PROTON_SESSION_NAME,
		profileDir,
		headless: false,
	});
	try {
		deps.log(
			"Sign in to Proton Mail in the browser window. This command waits.",
		);
		const deadline = Date.now() + (deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
		for (;;) {
			const url = await session.page.url();
			if (
				isProtonMailOrigin(new URL(url).origin) &&
				(await session.page.observedHeaders())?.uid
			)
				break;
			if (Date.now() >= deadline)
				throw new Error(
					`Proton sign-in timed out. Run ${PROTON_SIGN_IN_COMMAND} again.`,
				);
			await deps.sleep(SIGN_IN_POLL_MS);
		}
		writeSignedInMarker(dataDir);
		deps.log("Proton Mail is signed in. The profile is saved.");
	} finally {
		await session.close();
	}
}
