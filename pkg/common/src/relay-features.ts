import {
	INBOX_DEFAULT_TIMEOUT_MS,
	INBOX_WIRE,
	type InboxRelayBodies,
	validateInboxBrowserResponse,
	validateInboxCliRequest,
} from "./inbox-format";
import {
	PROTO_DEFAULT_TIMEOUT_MS,
	PROTO_WIRE,
	type ProtoRelayBodies,
	markedUrlForTimeout,
	validateProtoCliRequest,
} from "./proto-format";
import {
	PW_EXT_DEFAULT_TIMEOUT_MS,
	PW_EXT_WIRE,
	type PwExtRelayBodies,
	validatePwExtCliCancel,
	validatePwExtCliRequest,
} from "./pw-ext-format";
import { PW_EXT_MIN_EXTENSION_VERSION } from "./pw-ext-format";
import { bootstrapHint, defineRelayFeature } from "./relay-format";

const INBOX_VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function inboxExtensionSupported(version: string | undefined): boolean {
	const match = version?.match(INBOX_VERSION_PATTERN);
	if (!match) return false;
	const major = Number(match[1]);
	return major > 1 || (major === 1 && Number(match[2]) >= 11);
}

const MIN_VERSION = PW_EXT_MIN_EXTENSION_VERSION.join(".");

function versionAtLeastMinimum(version: string | undefined): boolean {
	const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/);
	if (!match) return false;
	const actual = match.slice(1, 4).map(Number);
	for (let i = 0; i < 3; i++) {
		const want = PW_EXT_MIN_EXTENSION_VERSION[i] as number;
		if ((actual[i] as number) !== want) return (actual[i] as number) > want;
	}
	return true;
}

export const INBOX_RELAY = defineRelayFeature<InboxRelayBodies>()({
	...INBOX_WIRE,
	validateCliRequest: validateInboxCliRequest,
	caps: { pending: 128, perRequester: 8, sessionIds: 10_000 },
	timeoutMs: (cli) => cli.timeoutMs ?? INBOX_DEFAULT_TIMEOUT_MS,
	toBrowserRequest: (cli) => ({ request: cli.request! }),
	fromBrowserRequest: (frame) => frame.request,
	toCliResult: (frame) =>
		frame.ok
			? { ok: true, value: validateInboxBrowserResponse(frame.data) }
			: { ok: false, error: frame.error },
	checks: [
		{ check: "active", refusal: "Inbox requires an active dg session." },
		{ check: "pendingDuplicate" },
		{
			check: "cap",
			of: ["requester"],
			refusal:
				"Inbox has too many pending requests from this client; wait for existing work to finish.",
		},
		{
			check: "replay",
			refusal: "Inbox requestId was already used; create a new requestId.",
		},
		{
			check: "cap",
			of: ["sessionIds", "pending"],
			refusal:
				"Inbox request capacity reached; finish pending work or start a new session.",
		},
		{ check: "burn" },
		{
			check: "peers",
			multiple:
				"Multiple extension peers make the inbox request ambiguous; keep one extension connected to this session.",
			none: ({ sessionId, port }) =>
				`No extension peer on session ${sessionId}. Connect the dg extension to session ${sessionId} and open an authenticated Proton Mail tab. ` +
				`Open ${bootstrapHint(port)} in the browser where the extension is loaded, then reload the Proton Mail tab. ` +
				"Inbox requires dg extension 1.11.0 or newer.",
		},
		{
			check: "version",
			accepts: inboxExtensionSupported,
			refusal:
				"Inbox requires dg extension 1.11.0 or newer; update the extension, reload it, and reconnect this session.",
		},
	],
	strings: {
		activeRequired: "Inbox requires an active dg session.",
		sessionClosed: "Inbox session closed before the extension replied.",
		timeout: () =>
			"Inbox extension request timed out; check the authenticated Proton tab and retry with a new requestId.",
		requesterDisconnected: "Inbox requester disconnected.",
		extensionDisconnected: "Inbox extension disconnected before replying.",
		sendFailed:
			"Inbox extension request could not be sent; reconnect the extension.",
		extensionFailed:
			"Proton extension request failed. Open or reload the mail tab and retry.",
	},
	flags: { failAllOnUnreadable: false },
});

export const PROTO_RELAY = defineRelayFeature<ProtoRelayBodies>()({
	...PROTO_WIRE,
	validateCliRequest: validateProtoCliRequest,
	caps: { pending: 32, perRequester: 4, sessionIds: 10_000 },
	timeoutMs: (cli) => cli.timeoutMs ?? PROTO_DEFAULT_TIMEOUT_MS[cli.phase],
	toBrowserRequest: (cli, timeoutMs) => ({
		phase: cli.phase,
		slug: cli.slug,
		markedUrl: cli.markedUrl,
		timeoutMs,
	}),
	fromBrowserRequest: ({ phase, slug, markedUrl, timeoutMs }) =>
		timeoutMs === undefined
			? { phase, slug, markedUrl }
			: { phase, slug, markedUrl, timeoutMs },
	toCliResult: (frame) =>
		frame.ok
			? { ok: true, data: frame.data }
			: frame.notReady
				? { ok: false, notReady: frame.notReady }
				: { ok: false, error: frame.error },
	checks: [
		{ check: "active", refusal: "Prototype --ext requires an active dg session." },
		{ check: "pendingDuplicate", refuseOtherRequester: "duplicate requestId" },
		{
			check: "replay",
			refusal:
				"Prototype requestId was already used on this session; send a new one.",
		},
		{
			check: "cap",
			of: ["requester"],
			refusal:
				"Prototype has too many pending requests from this client; wait for existing work to finish.",
		},
		{
			check: "cap",
			of: ["pending", "sessionIds"],
			refusal:
				"Prototype request capacity reached; finish pending work or start a new session.",
		},
		{
			check: "peers",
			multiple:
				"Multiple extension peers make the prototype request ambiguous; keep one extension connected to this session.",
			none: ({ sessionId, port }) =>
				`No extension peer on session ${sessionId}. Connect the dg extension to session ${sessionId}. ` +
				`Open ${bootstrapHint(port)} in the browser where the extension is loaded, then retry. ` +
				`Run dg-skills inbox bootstrap-url --session ${sessionId} to print the real URL (that pairing is shared across every daemon feature, not just inbox).`,
		},
		{ check: "burn" },
	],
	strings: {
		activeRequired: "Prototype --ext requires an active dg session.",
		sessionClosed: "Prototype session closed before the extension replied.",
		timeout: ({ cli, timeoutMs, lastStatus }) =>
			lastStatus
				? `Prototype ${cli.phase} timed out after ${timeoutMs}ms; last report from the extension: ${lastStatus}.`
				: `Prototype ${cli.phase} timed out after ${timeoutMs}ms with no report from the extension. It may not have loaded ${markedUrlForTimeout(cli.markedUrl)} in a paired browser, or it predates this change; rebuild and reload the unpacked extension and retry.`,
		requesterDisconnected: "Prototype requester disconnected.",
		extensionDisconnected: "Prototype extension disconnected before replying.",
		sendFailed:
			"Prototype extension request could not be sent; reconnect the extension.",
		rejected: (detail) =>
			`Prototype result could not be delivered: ${detail}`.slice(0, 2048),
		unreadableFailAll:
			"Prototype result exceeded the relay size limit and could not be delivered.",
		extensionFailed:
			"Prototype extension request failed before the browser reported a result.",
	},
	rejected: { afterOversized: "return" },
	flags: { failAllOnUnreadable: true },
});

export const PW_EXT_RELAY = defineRelayFeature<PwExtRelayBodies>()({
	...PW_EXT_WIRE,
	validateCliRequest: validatePwExtCliRequest,
	validateCliCancel: validatePwExtCliCancel,
	caps: { pending: 16, perRequester: 2, sessionIds: 10_000 },
	timeoutMs: (cli) => cli.timeoutMs ?? PW_EXT_DEFAULT_TIMEOUT_MS,
	toBrowserRequest: (cli, timeoutMs) => ({ request: cli.request, timeoutMs }),
	fromBrowserRequest: (frame) => frame.request,
	toCliResult: (frame) =>
		frame.ok
			? { ok: true, data: frame.data }
			: { ok: false, error: frame.error },
	checks: [
		{ check: "active", refusal: "pw --ext requires an active dg session." },
		{
			check: "replay",
			refusal:
				"pw --ext requestId was already used on this session; send a new one.",
		},
		{
			check: "cap",
			of: ["sessionIds"],
			refusal: "pw --ext request capacity reached; start a new session.",
		},
		{
			check: "cap",
			of: ["requester", "pending"],
			refusal:
				"pw --ext has too many pending requests; wait for the open requests to finish.",
		},
		{
			check: "peers",
			multiple:
				"Multiple extension peers make the pw --ext request ambiguous; keep one extension connected to this session.",
			none: ({ sessionId }) =>
				`No extension peer on session ${sessionId}. Pair the dg-ai-extension with this session, then retry. Run dg-skills doctor pw for the steps.`,
		},
		{ check: "burn" },
		{
			check: "version",
			accepts: versionAtLeastMinimum,
			refusal: `pw --ext requires dg-ai-extension ${MIN_VERSION} or newer; update the extension, reload it, and reconnect this session.`,
		},
	],
	strings: {
		activeRequired: "pw --ext requires an active dg session.",
		sessionClosed: "pw --ext session closed before the extension replied.",
		timeout: ({ timeoutMs }) =>
			`pw --ext timed out after ${timeoutMs}ms; the extension was told to cancel it.`,
		requesterDisconnected: "pw --ext requester disconnected.",
		extensionDisconnected: "pw --ext extension disconnected before replying.",
		sendFailed: "pw --ext request could not be sent; reconnect the extension.",
		canceled: "pw --ext request canceled.",
		rejected: (detail) =>
			`pw --ext result could not be delivered: ${detail}`.slice(0, 2048),
		extensionFailed:
			"pw --ext failed in the extension before it reported a result.",
	},
	rejected: {
		oversizedReason: "it exceeded the relay size limit",
		afterOversized: "continue",
	},
	flags: { failAllOnUnreadable: false },
});

export const RELAY_FEATURES = [INBOX_RELAY, PROTO_RELAY, PW_EXT_RELAY] as const;

export type RelayFeatureName = (typeof RELAY_FEATURES)[number]["name"];

export type FeatureNamed<N extends RelayFeatureName> = Extract<
	(typeof RELAY_FEATURES)[number],
	{ name: N }
>;
