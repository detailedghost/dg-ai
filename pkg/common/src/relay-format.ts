declare const bodies: unique symbol;

export type RelayBodies = {
	cliRequest: { requestId: string };
	cliCancel?: { requestId: string };
	browserRequest: { requestId: string };
	browserCancel?: { requestId: string };
	browserResult: { requestId: string; ok: boolean };
	browserProgress?: { requestId: string; status: string };
};

export type RelayCliResult = { readonly ok: boolean } & Readonly<
	Record<string, unknown>
>;

export type RelayCtx<Cli = { requestId: string }> = {
	readonly sessionId: string;
	readonly cli: Cli;
	readonly timeoutMs: number;
	readonly port?: number;
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

export type RequestOf<F extends AnyRelayFeature> = ReturnType<
	F["fromBrowserRequest"]
>;

export type ResultBody<F extends AnyRelayFeature> = F extends {
	[bodies]?: { browserResult: infer R };
}
	? Omit<R, "requestId">
	: never;

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

export function bootstrapHint(port?: number): string {
	return `http://127.0.0.1:${port ? port : "<port>"}/start#_chat=<base64url JSON of port, sessionId, token, and agentIdentity>`;
}
