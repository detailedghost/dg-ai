export const EXT_WRITE_VERBS = ["open", "click", "fill"] as const;
export const EXT_READ_VERBS = ["current", "snapshot", "screenshot", "selection", "console"] as const;
export const EXT_VERBS = [...EXT_WRITE_VERBS, ...EXT_READ_VERBS] as const;

export type ExtWriteVerb = (typeof EXT_WRITE_VERBS)[number];
export type ExtReadVerb = (typeof EXT_READ_VERBS)[number];
export type ExtVerb = (typeof EXT_VERBS)[number];

export const isExtVerb = (value: string): value is ExtVerb => (EXT_VERBS as readonly string[]).includes(value);
export const isExtWriteVerb = (verb: ExtVerb): verb is ExtWriteVerb =>
	(EXT_WRITE_VERBS as readonly string[]).includes(verb);

export type ExtRequest = {
	verb: ExtVerb;
	url?: string;
	target?: string;
	value?: string;
	submit?: boolean;
	depth?: number;
};

export type ExtTab = { url: string; title: string };

export type ExtPayload =
	| { kind: "ack" }
	| { kind: "tabs"; active: ExtTab; tabs: ExtTab[] }
	| { kind: "snapshot"; text: string }
	| { kind: "screenshot"; dataBase64: string }
	| { kind: "selection"; text: string }
	| { kind: "console"; entries: { type: string; text: string }[] };

export type ExtOutcome =
	| { status: "approved"; tab: ExtTab; payload: ExtPayload }
	| { status: "denied"; tab: ExtTab }
	| { status: "blocked"; reason: string };

/** The CLI's half of `pw --ext`; a real implementation forwards this to dg-daemon and the extension. */
export type ExtTransport = (request: ExtRequest) => Promise<ExtOutcome>;
