import { join } from "node:path";
import {
	CREDENTIAL_PREFIX,
	channelReviewPaths,
	DATADOG_CREDENTIAL,
	type EnvName,
	fetchRelaySecret,
	loadConfig,
	relayCredentialName,
	resolveEnv,
	SENTRY_CREDENTIAL,
} from "@dg/channel-review";
import { type CredentialMeta, DgCliError, describeError } from "@dg/common";
import {
	type CredentialClient,
	createCredentialClient,
	ensurePrivateDir,
	openOAuthBrowser,
	resolveDgPaths,
} from "@dg/common/node";
import { promptHidden } from "./credentials";

export const CONNECT_TOKEN_NAME = "channel-review-daemon";
export const CONNECT_PROVIDERS = ["datadog", "sentry", "relay"] as const;
export const DATADOG_SCOPES = [
	"error_tracking_read",
	"apm_read",
	"logs_read_data",
];
export const SENTRY_SCOPES = ["event:read", "project:read", "org:read"];
export const DATADOG_TOKEN_PATTERN = /^ddpat_[A-Za-z0-9_.-]{20,}$/;
export const SENTRY_TOKEN_PATTERN =
	/^(?:sntryu_[A-Za-z0-9_+/=.-]{20,}|[a-f0-9]{64})$/;
const DEFAULT_DATADOG_SITE = "datadoghq.com";
const DEFAULT_SENTRY_BASE = "https://sentry.io";
const DATADOG_TOKENS_PATH = "/personal-settings/access-tokens";
const SENTRY_TOKENS_PATH = "/settings/account/api/auth-tokens/";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_POLL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SENTRY_TOKEN_WAIT_MS = 30_000;
const SENTRY_TOKEN_POLL_MS = 500;
const HOUR_MS = 3_600_000;
const YEAR_MS = 365 * 86_400_000;
const TOKEN_NAME_PATTERN = new RegExp(
	`(?<![\\w-])${CONNECT_TOKEN_NAME}(?![\\w-])`,
);
const SENTRY_TOKEN_SCAN = `(() => {
	for (const el of document.querySelectorAll("input, textarea, code, pre")) {
		const text = ("value" in el && el.value) || el.textContent || "";
		const match = text.match(/sntryu_[A-Za-z0-9_+\\/=.-]{20,}/);
		if (match) return match[0];
	}
	return null;
})()`;

export type ConnectProvider = (typeof CONNECT_PROVIDERS)[number];
export type ConnectFlags = {
	env?: EnvName;
	site?: string;
	org?: string;
	paste?: boolean;
	session?: string;
};

type AriaName = { name?: string | RegExp };

/** The slice of a Playwright locator the connect flows use. */
export type UiLocator = {
	first(): UiLocator;
	last(): UiLocator;
	or(other: UiLocator): UiLocator;
	filter(options: { hasText?: string | RegExp }): UiLocator;
	getByRole(
		role:
			| "button"
			| "link"
			| "row"
			| "option"
			| "dialog"
			| "heading"
			| "combobox",
		options?: AriaName,
	): UiLocator;
	getByLabel(text: string | RegExp): UiLocator;
	getByPlaceholder(text: string | RegExp): UiLocator;
	locator(selector: string): UiLocator;
	click(): Promise<void>;
	fill(value: string): Promise<void>;
	count(): Promise<number>;
	allInnerTexts(): Promise<string[]>;
	isVisible(): Promise<boolean>;
};

/** The slice of a Playwright page the connect flows use. */
export type UiPage = Pick<
	UiLocator,
	"getByRole" | "getByLabel" | "getByPlaceholder" | "locator"
> & {
	goto(url: string): Promise<unknown>;
	url(): string;
	evaluate(expression: string): Promise<unknown>;
};

export type BrowserSession = {
	page: UiPage;
	grantClipboard(origin: string): Promise<void>;
	close(): Promise<void>;
};

export type ConnectClient = Pick<
	CredentialClient,
	"set" | "listGrants" | "grant" | "close"
>;
type RelayParams = Parameters<typeof fetchRelaySecret>[0];

export type ConnectDeps = {
	createClient(session?: string): ConnectClient;
	launchBrowser(): Promise<BrowserSession>;
	openExternal(url: string): Promise<void>;
	readSecret(prompt: string): Promise<string>;
	relayTarget(env?: EnvName): { envName: EnvName; params: RelayParams };
	fetchRelaySecret(params: RelayParams): Promise<string>;
	fetch(url: string, init: RequestInit): Promise<Response>;
	write(line: string): void;
	now(): Date;
	sleep(ms: number): Promise<void>;
};

async function launchChrome(): Promise<BrowserSession> {
	const profiles = join(resolveDgPaths().stateDir, "browser-profiles");
	const profileDir = join(profiles, "connect");
	ensurePrivateDir(profiles);
	ensurePrivateDir(profileDir);
	const { chromium } = await import("playwright-core");
	const context = await chromium.launchPersistentContext(profileDir, {
		channel: "chrome",
		headless: false,
	});
	const page = context.pages()[0] ?? (await context.newPage());
	page.setDefaultTimeout(REQUEST_TIMEOUT_MS);
	return {
		page,
		grantClipboard: (origin) =>
			context.grantPermissions(["clipboard-read", "clipboard-write"], {
				origin,
			}),
		close: () => context.close(),
	};
}

export const defaultConnectDeps: ConnectDeps = {
	createClient: (session) =>
		createCredentialClient({ paths: resolveDgPaths(), session }),
	launchBrowser: launchChrome,
	openExternal: (url) => openOAuthBrowser(url),
	readSecret: (prompt) => promptHidden(prompt),
	relayTarget: (env) => {
		const config = loadConfig(channelReviewPaths("dev").configPath);
		const resolved = resolveEnv(config, env);
		return {
			envName: resolved.name,
			params: { profile: resolved.awsProfile, ...config.relay.secret },
		};
	},
	fetchRelaySecret: (params) => fetchRelaySecret(params),
	fetch: (url, init) => fetch(url, init),
	write: (line) => console.log(line),
	now: () => new Date(),
	sleep: (ms) => Bun.sleep(ms),
};

/** Creates the read-only `channel-review` grant the daemon reads through, when it is missing. */
export async function ensureGrant(
	client: ConnectClient,
	write: (line: string) => void,
): Promise<void> {
	if (
		(await client.listGrants()).some(
			(grant) => grant.prefix === CREDENTIAL_PREFIX,
		)
	)
		return;
	await client.grant(CREDENTIAL_PREFIX);
	write(`created the ${CREDENTIAL_PREFIX} credential grant`);
}

async function store(
	deps: ConnectDeps,
	flags: ConnectFlags,
	name: string,
	value: string,
	meta: CredentialMeta,
): Promise<void> {
	const client = deps.createClient(flags.session);
	try {
		try {
			await client.set(name, value, meta);
		} catch (error) {
			throw new DgCliError(`Could not store ${name}: ${describeError(error)}`);
		}
		deps.write(`stored ${name}`);
		await ensureGrant(client, deps.write);
	} finally {
		client.close();
	}
}

async function verify(
	deps: ConnectDeps,
	url: string,
	init: RequestInit,
): Promise<void> {
	try {
		const response = await deps.fetch(url, {
			...init,
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok)
			throw new DgCliError(`verification failed (HTTP ${response.status})`);
		deps.write(`verified (HTTP ${response.status})`);
	} catch (error) {
		if (error instanceof DgCliError) throw error;
		throw new DgCliError(`verification failed (${describeError(error)})`);
	}
}

function datadogAppHost(site: string): string {
	return site.split(".").length === 2 ? `app.${site}` : site;
}

const DATADOG_HOST_PATTERN =
	/^(?:[a-z0-9-]+\.)*(?:datadoghq\.(?:com|eu)|ddog-gov\.com)$/;

function isDatadogHost(host: string): boolean {
	const lower = host.toLowerCase();
	return DATADOG_HOST_PATTERN.test(lower) && hostnameOf(lower) === lower;
}

function hostnameOf(host: string): string | undefined {
	try {
		return new URL(`https://${host}`).hostname;
	} catch {
		return undefined;
	}
}

function datadogSiteFromHost(host: string): string {
	return host.startsWith("app.") ? host.slice("app.".length) : host;
}

async function waitForSignIn(
	page: UiPage,
	deps: ConnectDeps,
	path: string,
	heading: RegExp,
	signedIn: (url: URL) => boolean,
): Promise<URL> {
	const deadline = deps.now().getTime() + LOGIN_TIMEOUT_MS;
	let told = false;
	for (;;) {
		const url = new URL(page.url());
		if (!signedIn(url)) {
			if (!told)
				deps.write(
					`Sign in in the browser window. Waiting up to ${LOGIN_TIMEOUT_MS / 60_000} minutes.`,
				);
			told = true;
		} else if (!url.pathname.startsWith(path)) {
			await page.goto(`${url.origin}${path}`);
		} else if (
			await page.getByRole("heading", { name: heading }).first().isVisible()
		) {
			return url;
		}
		if (deps.now().getTime() >= deadline)
			throw new DgCliError("Timed out waiting for sign-in.");
		await deps.sleep(LOGIN_POLL_MS);
	}
}

function validate(value: string, pattern: RegExp, label: string): string {
	const token = value.trim();
	if (!pattern.test(token)) throw new DgCliError(`That is not a ${label}.`);
	return token;
}

function validateCaptured(
	value: string,
	pattern: RegExp,
	label: string,
): string {
	try {
		return validate(value, pattern, label);
	} catch (error) {
		throw new Error(describeError(error));
	}
}

async function viaBrowser<T>(
	deps: ConnectDeps,
	run: (session: BrowserSession) => Promise<T>,
): Promise<T | undefined> {
	let session: BrowserSession | undefined;
	try {
		session = await deps.launchBrowser();
		return await run(session);
	} catch (error) {
		if (error instanceof DgCliError) throw error;
		deps.write("Browser automation failed. Falling back to paste mode.");
		return undefined;
	} finally {
		await session?.close().catch(() => undefined);
	}
}

async function pasteToken(
	deps: ConnectDeps,
	url: string,
	instructions: string,
	label: string,
	pattern: RegExp,
): Promise<string> {
	await deps.openExternal(url);
	deps.write(instructions);
	return validate(await deps.readSecret(`${label}: `), pattern, label);
}

async function listDatadogTokenRows(page: UiPage): Promise<string[]> {
	const texts = await page
		.getByRole("row")
		.filter({ hasText: CONNECT_TOKEN_NAME })
		.allInnerTexts();
	return texts
		.map((text) => text.replace(/\s+/g, " ").trim())
		.filter((text) => TOKEN_NAME_PATTERN.test(text));
}

async function revokeDatadogTokens(
	page: UiPage,
	deps: ConnectDeps,
	previous: string[],
): Promise<void> {
	for (const text of previous) {
		try {
			const row = page.getByRole("row").filter({ hasText: text });
			if ((await row.count()) !== 1) throw new Error("ambiguous row");
			await row
				.getByRole("button", { name: /revoke/i })
				.first()
				.click();
			await page
				.getByRole("dialog")
				.last()
				.getByRole("button", { name: /revoke/i })
				.first()
				.click();
			deps.write(`revoked the previous ${CONNECT_TOKEN_NAME} token`);
		} catch {
			deps.write(
				`Could not revoke the previous ${CONNECT_TOKEN_NAME} token. Revoke it in Datadog by hand.`,
			);
		}
	}
}

async function createDatadogToken(page: UiPage): Promise<void> {
	await page
		.getByRole("button", { name: /new (access )?token/i })
		.first()
		.click();
	const form = page.getByRole("dialog").last();
	await form.getByLabel(/name/i).first().fill(CONNECT_TOKEN_NAME);
	await form
		.getByLabel(/expiration/i)
		.first()
		.click();
	await page
		.getByRole("option", { name: /1 year/i })
		.first()
		.click();
	await form
		.getByRole("button", { name: /scopes/i })
		.first()
		.click();
	const scopes = page.getByRole("dialog").last();
	for (const scope of DATADOG_SCOPES) {
		await scopes
			.getByPlaceholder(/search/i)
			.first()
			.fill(scope);
		await scopes.locator("label").filter({ hasText: scope }).first().click();
	}
	await scopes.getByRole("button", { name: /^save/i }).first().click();
	await page
		.getByRole("dialog")
		.last()
		.getByRole("button", { name: /create/i })
		.first()
		.click();
}

async function copyDatadogToken(
	session: BrowserSession,
	origin: string,
): Promise<string> {
	const { page } = session;
	await session.grantClipboard(origin);
	try {
		await page
			.getByRole("dialog")
			.last()
			.getByRole("button", { name: /copy/i })
			.first()
			.click();
		return validateCaptured(
			String(await page.evaluate("navigator.clipboard.readText()")),
			DATADOG_TOKEN_PATTERN,
			"Datadog access token",
		);
	} finally {
		await page.evaluate('navigator.clipboard.writeText("")');
	}
}

async function connectDatadog(
	flags: ConnectFlags,
	deps: ConnectDeps,
): Promise<void> {
	if (flags.site !== undefined && !isDatadogHost(flags.site))
		throw new DgCliError("That is not a Datadog site.");
	const flagSite =
		flags.site === undefined
			? undefined
			: datadogSiteFromHost(flags.site.toLowerCase());
	const tokensUrl = (site: string) =>
		`https://${datadogAppHost(site)}${DATADOG_TOKENS_PATH}`;
	const save = (value: string, site: string) =>
		store(deps, flags, DATADOG_CREDENTIAL, value, {
			provider: "datadog",
			site,
			scopes: DATADOG_SCOPES,
			expiresAt: new Date(deps.now().getTime() + YEAR_MS).toISOString(),
			createdBy: "connect",
		});
	const captured = flags.paste
		? undefined
		: await viaBrowser(deps, async (session) => {
				await session.page.goto(tokensUrl(flagSite ?? DEFAULT_DATADOG_SITE));
				const url = await waitForSignIn(
					session.page,
					deps,
					DATADOG_TOKENS_PATH,
					/access tokens/i,
					({ hostname, pathname }) =>
						isDatadogHost(hostname) && !pathname.startsWith("/account/"),
				);
				const previous = await listDatadogTokenRows(session.page);
				await createDatadogToken(session.page);
				const value = await copyDatadogToken(session, url.origin);
				const site = flagSite ?? datadogSiteFromHost(url.hostname);
				await save(value, site);
				await revokeDatadogTokens(session.page, deps, previous);
				return { value, site };
			});
	const site = captured?.site ?? flagSite ?? DEFAULT_DATADOG_SITE;
	let value = captured?.value;
	if (value === undefined) {
		value = await pasteToken(
			deps,
			tokensUrl(site),
			`Create a personal access token named ${CONNECT_TOKEN_NAME} with expiration 1 year and scopes ${DATADOG_SCOPES.join(", ")}, then copy it.`,
			"Datadog access token",
			DATADOG_TOKEN_PATTERN,
		);
		await save(value, site);
	}
	const now = deps.now();
	await verify(
		deps,
		`https://api.${site}/api/v2/error-tracking/issues/search`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${value}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				data: {
					type: "search_request",
					attributes: {
						query: "",
						from: now.getTime() - HOUR_MS,
						to: now.getTime(),
						track: "trace",
					},
				},
			}),
		},
	);
}

function sentryOrgFromHost(host: string, base: URL): string | undefined {
	const suffix = `.${base.hostname}`;
	return host.endsWith(suffix) ? host.slice(0, -suffix.length) : undefined;
}

async function scanSentryToken(page: UiPage, deps: ConnectDeps): Promise<string> {
	const deadline = deps.now().getTime() + SENTRY_TOKEN_WAIT_MS;
	for (;;) {
		const value = await page.evaluate(SENTRY_TOKEN_SCAN);
		if (typeof value === "string") return value;
		if (deps.now().getTime() >= deadline)
			throw new DgCliError(
				`Sentry did not show the new token. Revoke the ${CONNECT_TOKEN_NAME} token in Sentry and run connect again.`,
			);
		await deps.sleep(SENTRY_TOKEN_POLL_MS);
	}
}

async function createSentryToken(
	page: UiPage,
	deps: ConnectDeps,
): Promise<string> {
	const create = /create new token|new token|create token/i;
	await page
		.getByRole("button", { name: create })
		.or(page.getByRole("link", { name: create }))
		.first()
		.click();
	await page.getByLabel(/name/i).first().fill(CONNECT_TOKEN_NAME);
	for (const resource of [/^project/i, /^organization/i, /^issue/i]) {
		await page.getByRole("combobox", { name: resource }).first().click();
		await page
			.getByRole("option", { name: /^read$/i })
			.first()
			.click();
	}
	await page
		.getByRole("button", { name: /create token|save/i })
		.last()
		.click();
	return validateCaptured(
		await scanSentryToken(page, deps),
		SENTRY_TOKEN_PATTERN,
		"Sentry auth token",
	);
}

function parseSentryBase(site: string): URL {
	let base: URL;
	try {
		base = new URL(site);
	} catch {
		throw new DgCliError("The Sentry site must be an https URL such as https://sentry.io.");
	}
	if (base.protocol !== "https:")
		throw new DgCliError("The Sentry site must use https.");
	return base;
}

async function connectSentry(
	flags: ConnectFlags,
	deps: ConnectDeps,
): Promise<void> {
	const base = parseSentryBase(flags.site ?? DEFAULT_SENTRY_BASE);
	const baseUrl = base.origin;
	const captured = flags.paste
		? undefined
		: await viaBrowser(deps, async (session) => {
				await session.page.goto(`${baseUrl}${SENTRY_TOKENS_PATH}`);
				const url = await waitForSignIn(
					session.page,
					deps,
					SENTRY_TOKENS_PATH,
					/auth tokens/i,
					({ hostname, pathname }) =>
						(hostname === base.hostname ||
							hostname.endsWith(`.${base.hostname}`)) &&
						!pathname.startsWith("/auth/"),
				);
				const org = flags.org ?? sentryOrgFromHost(url.hostname, base);
				if (!org)
					throw new DgCliError(
						"Pass --org <slug> before creating a Sentry token.",
					);
				return {
					value: await createSentryToken(session.page, deps),
					org,
				};
			});
	const org = captured?.org ?? flags.org;
	if (org === undefined)
		throw new DgCliError(
			"Pass the Sentry organization slug with --org <slug>.",
		);
	const value =
		captured?.value ??
		(await pasteToken(
			deps,
			`${baseUrl}${SENTRY_TOKENS_PATH}`,
			`Create a user auth token named ${CONNECT_TOKEN_NAME} with scopes ${SENTRY_SCOPES.join(", ")}, then copy it.`,
			"Sentry auth token",
			SENTRY_TOKEN_PATTERN,
		));
	await store(deps, flags, SENTRY_CREDENTIAL, value, {
		provider: "sentry",
		site: baseUrl,
		org,
		scopes: SENTRY_SCOPES,
		createdBy: "connect",
	});
	await verify(
		deps,
		`${baseUrl}/api/0/organizations/${encodeURIComponent(org)}/`,
		{
			method: "GET",
			headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
		},
	);
}

async function connectRelay(
	flags: ConnectFlags,
	deps: ConnectDeps,
): Promise<void> {
	const { envName, params } = deps.relayTarget(flags.env);
	const value = await deps.fetchRelaySecret(params);
	await store(deps, flags, relayCredentialName(envName), value, {
		provider: "relay",
		createdBy: "connect",
	});
}

/** Captures a provider secret and stores it under `channel-review/`; the value is never printed. */
export async function runConnect(
	provider: ConnectProvider,
	flags: ConnectFlags,
	deps: ConnectDeps = defaultConnectDeps,
): Promise<void> {
	if (provider === "datadog") return connectDatadog(flags, deps);
	if (provider === "sentry") return connectSentry(flags, deps);
	return connectRelay(flags, deps);
}
