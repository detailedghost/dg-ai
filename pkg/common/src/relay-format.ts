import type { Envelope } from "./chat-format";

declare const bodies: unique symbol;

export type RelayBodies = {
	cliRequest: { requestId: string };
	cliCancel?: { requestId: string };
	browserRequest: { requestId: string };
	browserCancel?: { requestId: string };
	browserResult: { requestId: string; ok: boolean };
	browserProgress?: { requestId: string; status: string };
};

export type RelayFrameValidator = (
	value: Record<string, unknown>,
	path: string,
) => void;

export type RelayCliResult = { readonly ok: boolean } & Readonly<
	Record<string, unknown>
>;

export type RelayCtx<Cli = { requestId: string }> = {
	readonly sessionId: string;
	readonly cli: Cli;
	readonly timeoutMs: number;
	readonly lastStatus?: string;
	readonly detail?: string;
};

export type RelayCheck<Cli = { requestId: string }> =
	| { readonly check: "active"; readonly refusal: string }
	| { readonly check: "pendingDuplicate"; readonly refuseOtherRequester?: string }
	| { readonly check: "replay"; readonly refusal: string }
	| {
			readonly check: "cap";
			readonly of: readonly ("sessionIds" | "requester" | "pending")[];
			readonly refusal: string;
	  }
	| {
			readonly check: "peers";
			readonly multiple: string;
			none(ctx: RelayCtx<Cli>): string;
	  }
	| { readonly check: "burn" }
	| {
			readonly check: "version";
			accepts(version: string | undefined): boolean;
			readonly refusal: string;
	  }
	| {
			readonly check: "supports";
			accepts(peer: RelayPeer, cli: Cli): boolean;
			refusal(cli: Cli): string;
	  };

/** What the one extension peer announced in its connect handshake. */
export type RelayPeer = {
	readonly extensionVersion?: string;
	readonly pwExtVerbs?: readonly string[];
};

export type RelayStrings<Cli = { requestId: string }> = {
	readonly activeRequired: string;
	readonly sessionClosed: string;
	timeout(ctx: RelayCtx<Cli>): string;
	readonly requesterDisconnected: string;
	readonly extensionDisconnected: string;
	readonly sendFailed: string;
	readonly canceled?: string;
	rejected?(detail: string): string;
	readonly unreadableFailAll?: string;
	readonly extensionFailed: string;
};

export type RelayFeature<
	Name extends string = string,
	Cli extends { requestId: string } = { requestId: string },
	Browser extends { requestId: string } = { requestId: string },
	Result extends { requestId: string; ok: boolean } = {
		requestId: string;
		ok: boolean;
	},
> = {
	readonly name: Name;
	readonly frames: {
		readonly cliRequest: string;
		readonly cliResult: string;
		readonly browserRequest: string;
		readonly browserResult: string;
		readonly cliCancel?: string;
		readonly browserCancel?: string;
		readonly browserProgress?: string;
	};
	readonly validators: Readonly<Record<string, RelayFrameValidator>>;
	readonly inbound: readonly string[];
	validateCliRequest(value: unknown): Cli;
	validateCliCancel?(value: unknown): { requestId: string };
	readonly caps: {
		readonly pending: number;
		readonly perRequester: number;
		readonly sessionIds: number;
	};
	timeoutMs(cli: Cli): number;
	toBrowserRequest(cli: Cli, timeoutMs: number): Omit<Browser, "requestId">;
	fromBrowserRequest(frame: Browser): unknown;
	toCliResult(frame: Result): RelayCliResult;
	readonly checks: readonly RelayCheck<Cli>[];
	readonly strings: RelayStrings<Cli>;
	readonly rejected?: {
		readonly oversizedReason?: string;
		readonly afterOversized: "return" | "continue";
	};
	readonly flags: { readonly failAllOnUnreadable: boolean };
};

export type AnyRelayFeature = RelayFeature;

export type RelayWire = Pick<
	AnyRelayFeature,
	"name" | "frames" | "validators" | "inbound"
>;

export type RequestOf<F extends AnyRelayFeature> = ReturnType<
	F["fromBrowserRequest"]
>;

export type ResultBody<F extends AnyRelayFeature> = F extends {
	[bodies]?: { browserResult: infer R };
}
	? Omit<R, "requestId">
	: never;

type BrowserRole =
	| "browserRequest"
	| "browserCancel"
	| "browserResult"
	| "browserProgress";

type CliRole = "cliRequest" | "cliCancel";

type BrowserFrameOf<F extends AnyRelayFeature, Role extends BrowserRole> =
	F extends {
		readonly frames: { readonly [K in Role]: infer Type extends string };
		readonly inbound: readonly (infer Inbound)[];
		readonly [bodies]?: { readonly [K in Role]: infer Body };
	}
		? Envelope & { type: Type } & ([Type] extends [Inbound]
					? { token: string }
					: unknown) &
				Body
		: never;

type CliFrameOf<F extends AnyRelayFeature, Role extends CliRole> = F extends {
	readonly frames: { readonly [K in Role]: string };
	readonly [bodies]?: { readonly [K in Role]: infer Body };
}
	? Body
	: never;

/** The ChatFrame members of one or more relay tables. */
export type RelayChatFrame<F extends AnyRelayFeature> = {
	[Role in BrowserRole]: BrowserFrameOf<F, Role>;
}[BrowserRole];

/** The CLI request and cancel frames of one or more relay tables. */
export type RelayCliFrame<F extends AnyRelayFeature> = {
	[Role in CliRole]: CliFrameOf<F, Role>;
}[CliRole];

/** Browser frame types of the tables, or only those that carry a token. */
export function relayFrameTypes(
	features: readonly RelayWire[],
	which: "inbound" | "all",
): string[] {
	return features.flatMap(({ frames, inbound }) =>
		which === "inbound"
			? inbound
			: [
					frames.browserRequest,
					frames.browserResult,
					frames.browserCancel,
					frames.browserProgress,
				].filter((type) => type !== undefined),
	);
}

/** One validator per browser frame type across the tables. */
export function relayValidators(
	features: readonly RelayWire[],
): Map<string, RelayFrameValidator> {
	return new Map(features.flatMap(({ validators }) => Object.entries(validators)));
}

/** Checks one feature table and tags it with its frame body types. */
export function defineRelayFeature<Bodies extends RelayBodies>() {
	return <
		const T extends RelayFeature<
			string,
			Bodies["cliRequest"],
			Bodies["browserRequest"],
			Bodies["browserResult"]
		>,
	>(
		table: T,
	): T & { readonly [bodies]?: Bodies } => table;
}
