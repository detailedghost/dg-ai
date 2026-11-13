import type { NetworkBody, NetworkEntry, NetworkHeader, NetworkShape, StorageItem } from "@dg/common";

export type PwExtAgentFetch = {
	url: string;
	method: string;
	body?: string;
	contentType?: string;
	headers: [string, string][];
	auth: boolean;
	values: boolean;
};

export type PwExtStorageItem = StorageItem;

export type PwExtNetworkAction =
	| { kind: "install"; seal?: boolean }
	| { kind: "remove" }
	| { kind: "read"; values: boolean; since?: number }
	| { kind: "clear" }
	| { kind: "seal" }
	| { kind: "sealed-get"; name: string }
	| ({ kind: "fetch" } & PwExtAgentFetch)
	| { kind: "storage"; area: "local" | "session"; key?: string; keysOnly?: boolean; values: boolean }
	| { kind: "storage-get"; area: "local" | "session"; key: string };

export type PwExtNetworkResult =
	| { entries: NetworkEntry[] }
	| { cleared: number }
	| { error: string }
	| { value: string }
	| { missing: true }
	| { items: PwExtStorageItem[]; total: number };

/** Self-contained MAIN-world hook that records fetch and XMLHttpRequest calls in a bounded ring; a sensitive header value never enters the ring, and values leave the page only on a values read; after the approval, a sealed closure keeps same-origin sign-in header values for the agent's own fetch and credential save only. */
export function pwExtNetwork(
	action: PwExtNetworkAction,
	expectUrl?: string,
	owner?: number,
): PwExtNetworkResult | Promise<PwExtNetworkResult> {
	try {
		if (expectUrl !== undefined && document.URL !== expectUrl)
			return { error: "The page changed; nothing was done. Retry." };
		const MAX_ENTRIES = 100;
		const MAX_HEADERS = 40;
		const HEADER_VALUE_MAX = 512;
		const BODY_MAX = 8000;
		const URL_MAX = 4096;
		const TYPE_MAX = 128;
		const READ_MAX_BYTES = 1_048_576;
		const SHAPE_DEPTH = 8;
		const SHAPE_KEYS = 40;
		const SHAPE_NODES = 400;
		const KEY_MAX = 256;
		const SENSITIVE =
			/auth|cookie|token|secret|key|session|canary|csrf|xsrf|credential|pass|signature|jwt|dpop|bearer|assertion/i;
		const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
		const SEALED_MAX = 8192;
		const STORAGE_MAX_KEYS = 200;
		const STORAGE_VALUE_MAX = 65_536;
		type Slot = {
			entries: NetworkEntry[];
			active: boolean;
			removed: boolean;
			owner?: number;
			wrap(): void;
			unwrap(): void;
			seal(on: boolean): void;
			sealedGet(name: string): string | undefined;
			agentFetch(request: PwExtAgentFetch): Promise<PwExtNetworkResult>;
			storage(area: "local" | "session", key: string | undefined, keysOnly: boolean, values: boolean): PwExtNetworkResult;
			storageGet(area: "local" | "session", key: string): PwExtNetworkResult;
		};
		const outEntry = (entry: NetworkEntry, values: boolean): NetworkEntry => {
			const strip = (body: NetworkBody | undefined): NetworkBody | undefined =>
				body === undefined
					? undefined
					: {
							type: body.type,
							size: body.size,
							...(body.shape === undefined ? {} : { shape: body.shape }),
							...(values && body.text !== undefined ? { text: body.text, ...(body.cut ? { cut: true as const } : {}) } : {}),
						};
			const names = (list: NetworkHeader[]) => list.map(({ name, value }) => (values && value !== undefined ? { name, value } : { name }));
			const request = strip(entry.request);
			const response = strip(entry.response);
			return JSON.parse(
				JSON.stringify({
					at: entry.at,
					via: entry.via,
					method: entry.method,
					url: entry.url,
					...(entry.status === undefined ? {} : { status: entry.status }),
					...(entry.failed ? { failed: true as const } : {}),
					requestHeaders: names(entry.requestHeaders),
					responseHeaders: names(entry.responseHeaders),
					...(request ? { request } : {}),
					...(response ? { response } : {}),
				}),
			) as NetworkEntry;
		};
		const KEY = Symbol.for("dg.pwExt.network");
		const win = document.defaultView as unknown as Window & typeof globalThis & Record<symbol, unknown>;
		let slot = (win[KEY] ?? undefined) as Slot | undefined;
		if (slot === undefined && action.kind !== "install") return action.kind === "clear" ? { cleared: 0 } : { entries: [] };
		if (slot === undefined) {
			const nativeFetch = win.fetch;
			const proto = win.XMLHttpRequest.prototype;
			const native = { open: proto.open, setRequestHeader: proto.setRequestHeader, send: proto.send };
			const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
			const shapeOf = (value: unknown, depth: number, budget: { n: number }): NetworkShape => {
				budget.n--;
				if (value === null || value === undefined) return "null";
				if (typeof value === "string") return "string";
				if (typeof value === "number") return "number";
				if (typeof value === "boolean") return "boolean";
				if (Array.isArray(value)) {
					if (value.length === 0 || depth >= SHAPE_DEPTH || budget.n <= 0) return { n: value.length };
					return { n: value.length, of: shapeOf(value[0], depth + 1, budget) };
				}
				if (typeof value !== "object") return "null";
				const keys = Object.keys(value as object);
				const pairs: [string, NetworkShape][] = [];
				for (const key of keys) {
					if (depth >= SHAPE_DEPTH || pairs.length >= SHAPE_KEYS || budget.n <= 0) break;
					pairs.push([clip(key, KEY_MAX), shapeOf((value as Record<string, unknown>)[key], depth + 1, budget)]);
				}
				const more = keys.length - pairs.length;
				return more > 0 ? { keys: pairs, more } : { keys: pairs };
			};
			const jsonShape = (text: string): NetworkShape | undefined => {
				if (text.length > READ_MAX_BYTES || !/^\s*[[{]/.test(text)) return undefined;
				try {
					return shapeOf(JSON.parse(text), 0, { n: SHAPE_NODES });
				} catch {
					return undefined;
				}
			};
			const textBody = (type: string, text: string, size: number, cut = false): NetworkBody => {
				const shape = cut ? undefined : jsonShape(text);
				return {
					type: clip(type, TYPE_MAX),
					size,
					...(shape === undefined ? {} : { shape }),
					text: clip(text, BODY_MAX),
					...(cut || text.length > BODY_MAX ? { cut: true as const } : {}),
				};
			};
			const byteLength = (text: string) => new TextEncoder().encode(text).length;
			const requestBody = (body: unknown, type: string): NetworkBody | undefined => {
				if (body === undefined || body === null) return undefined;
				if (typeof body === "string") return textBody(type, body, byteLength(body));
				if (body instanceof win.URLSearchParams) {
					const text = body.toString();
					return textBody(type || "application/x-www-form-urlencoded", text, byteLength(text));
				}
				if (body instanceof win.FormData) return { type: clip(type || "multipart/form-data", TYPE_MAX), size: -1 };
				if (body instanceof win.Blob) return { type: clip(type || body.type, TYPE_MAX), size: body.size };
				if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
					return { type: clip(type, TYPE_MAX), size: (body as ArrayBuffer).byteLength };
				return { type: clip(type, TYPE_MAX), size: -1 };
			};
			const header = (name: string, value: string): NetworkHeader | undefined => {
				const lower = name.trim().toLowerCase();
				if (!HEADER_NAME.test(lower)) return undefined;
				return SENSITIVE.test(lower) ? { name: lower } : { name: lower, value: clip(value, HEADER_VALUE_MAX) };
			};
			const addHeader = (list: NetworkHeader[], name: string, value: string, append = false) => {
				const at = list.findIndex((held) => held.name === name.trim().toLowerCase());
				const before = at === -1 ? undefined : list[at]?.value;
				const entry = header(name, append && before !== undefined ? `${before}, ${value}` : value);
				if (!entry) return;
				if (at !== -1) list[at] = entry;
				else if (list.length < MAX_HEADERS) list.push(entry);
			};
			const contentType = (list: NetworkHeader[]) => list.find((held) => held.name === "content-type")?.value ?? "";
			const absolute = (raw: unknown): string => {
				try {
					return clip(new URL(String(raw), document.baseURI).href, URL_MAX);
				} catch {
					return clip(String(raw), URL_MAX);
				}
			};
			const methodOf = (raw: unknown) => {
				const method = String(raw ?? "GET");
				return /^[A-Za-z]{1,16}$/.test(method) ? method.toUpperCase() : "OTHER";
			};
			const pageOrigin = win.location.origin;
			const sealed = { on: false, anchor: undefined as string | undefined, values: new Map<string, string>() };
			const sealHeaders = (url: string, pairs: [string, string][]) => {
				if (!sealed.on) return;
				let origin = "";
				try {
					origin = new URL(url).origin;
				} catch {}
				if (origin !== pageOrigin) return;
				const anchor = pairs.find(([name]) => /anchor/i.test(name))?.[1];
				if (anchor !== undefined) {
					if (sealed.anchor !== undefined && sealed.anchor !== anchor) sealed.values.clear();
					sealed.anchor = anchor;
				}
				for (const [name, value] of pairs) {
					const lower = name.trim().toLowerCase();
					if (HEADER_NAME.test(lower) && SENSITIVE.test(lower) && !/cookie/.test(lower) && value.length <= SEALED_MAX)
						sealed.values.set(lower, value);
				}
			};
			const headerPairs = (source: HeadersInit | Headers | undefined): [string, string][] => {
				const pairs: [string, string][] = [];
				if (source !== undefined) new win.Headers(source).forEach((value, name) => pairs.push([name, value]));
				return pairs;
			};
			const record = (entry: NetworkEntry) => {
				fresh.entries.push(entry);
				if (fresh.entries.length > MAX_ENTRIES) fresh.entries.shift();
			};
			const readable = (type: string) => /json|^text\/(?!event-stream)|xml|javascript|x-www-form-urlencoded/i.test(type);
			const readBounded = async (stream: ReadableStream<Uint8Array>) => {
				const reader = stream.getReader();
				const decoder = new TextDecoder();
				let text = "";
				let bytes = 0;
				let cut = false;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > READ_MAX_BYTES) {
						text += decoder.decode(value.subarray(0, value.byteLength - (bytes - READ_MAX_BYTES)), { stream: true });
						cut = true;
						void reader.cancel().catch(() => undefined);
						break;
					}
					text += decoder.decode(value, { stream: true });
				}
				return { text: text + decoder.decode(), bytes, cut };
			};
			const readResponse = async (entry: NetworkEntry, response: Response) => {
				const type = contentType(entry.responseHeaders);
				const declared = response.headers.get("content-length");
				const length = declared === null || declared.trim() === "" ? Number.NaN : Number(declared);
				const size = Number.isSafeInteger(length) && length >= 0 ? length : -1;
				if (!readable(type) || response.body === null) {
					entry.response = { type: clip(type, TYPE_MAX), size };
					return;
				}
				const body = response.clone().body;
				if (!body) return;
				const { text, bytes, cut } = await readBounded(body);
				if (!fresh.active) return;
				entry.response = textBody(type, text, cut ? size : bytes, cut);
			};
			const wrappedFetch = function fetch(this: unknown, ...args: Parameters<typeof win.fetch>) {
				if (!fresh.active) return nativeFetch.apply(this, args);
				let entry: NetworkEntry | undefined;
				try {
					const [input, init] = args;
					const request = input instanceof win.Request ? input : undefined;
					const requestHeaders: NetworkHeader[] = [];
					const given = init?.headers;
					const plain =
						given instanceof win.Headers ||
						Array.isArray(given) ||
						(typeof given === "object" &&
							given !== null &&
							[Object.prototype, null].includes(Object.getPrototypeOf(given)));
					const pairs =
						given !== undefined && plain ? headerPairs(given) : given === undefined ? headerPairs(request?.headers) : [];
					for (const [name, value] of pairs) addHeader(requestHeaders, name, value);
					sealHeaders(absolute(request ? request.url : input), pairs);
					const made: NetworkEntry = {
						at: Date.now(),
						via: "fetch",
						method: methodOf(init?.method ?? request?.method),
						url: absolute(request ? request.url : input),
						requestHeaders,
						responseHeaders: [],
					};
					entry = made;
					const body = requestBody(init?.body, contentType(requestHeaders));
					if (body) made.request = body;
					else if (request && request.body !== null && !request.bodyUsed) {
						const type = contentType(requestHeaders);
						const stream = readable(type) ? request.clone().body : null;
						if (stream)
							void readBounded(stream)
								.then(({ text, bytes, cut }) => {
									made.request = textBody(type, text, cut ? -1 : bytes, cut);
								})
								.catch(() => undefined);
						else made.request = { type: clip(type, TYPE_MAX), size: -1 };
					}
				} catch {
					entry = undefined;
				}
				const sent = nativeFetch.apply(this, args);
				const held = entry;
				if (held === undefined) return sent;
				record(held);
				sent.then(
					(response) => {
						try {
							held.status = response.status;
							response.headers.forEach((value, name) => addHeader(held.responseHeaders, name, value));
							void readResponse(held, response).catch(() => undefined);
						} catch {}
					},
					() => {
						held.failed = true;
					},
				);
				return sent;
			};
			type Tracked = { method: string; url: string; headers: NetworkHeader[]; sensitive: [string, string][] };
			const tracked = new WeakMap<XMLHttpRequest, Tracked>();
			const wrappers = {
				open: function open(this: XMLHttpRequest, ...args: unknown[]) {
					try {
						if (fresh.active)
							tracked.set(this, { method: methodOf(args[0]), url: absolute(args[1]), headers: [], sensitive: [] });
					} catch {}
					return (native.open as (...args: unknown[]) => void).apply(this, args);
				},
				setRequestHeader: function setRequestHeader(this: XMLHttpRequest, name: string, value: string) {
					try {
						const held = fresh.active ? tracked.get(this) : undefined;
						if (held) {
							addHeader(held.headers, String(name), String(value), true);
							if (sealed.on && SENSITIVE.test(String(name))) held.sensitive.push([String(name), String(value)]);
						}
					} catch {}
					return native.setRequestHeader.call(this, name, value);
				},
				send: function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
					try {
						const held = fresh.active ? tracked.get(this) : undefined;
						if (held) {
							const xhr = this;
							const entry: NetworkEntry = {
								at: Date.now(),
								via: "xhr",
								method: held.method,
								url: held.url,
								requestHeaders: held.headers,
								responseHeaders: [],
							};
							sealHeaders(held.url, held.sensitive);
							held.sensitive = [];
							const sentBody = requestBody(body, contentType(held.headers));
							if (sentBody) entry.request = sentBody;
							record(entry);
							xhr.addEventListener(
								"loadend",
								() => {
									try {
										if (xhr.status === 0) {
											entry.failed = true;
											return;
										}
										entry.status = xhr.status;
										for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
											const at = line.indexOf(":");
											if (at > 0) addHeader(entry.responseHeaders, line.slice(0, at), line.slice(at + 1).trim());
										}
										const type = contentType(entry.responseHeaders);
										if (xhr.responseType === "" || xhr.responseType === "text") {
											const text = xhr.responseText;
											entry.response = readable(type) ? textBody(type, text, byteLength(text)) : { type: clip(type, TYPE_MAX), size: byteLength(text) };
										} else if (xhr.responseType === "json") {
											const text = JSON.stringify(xhr.response) ?? "null";
											entry.response = textBody(type, text, byteLength(text));
										} else if (xhr.response instanceof ArrayBuffer)
											entry.response = { type: clip(type, TYPE_MAX), size: xhr.response.byteLength };
										else if (xhr.response instanceof win.Blob)
											entry.response = { type: clip(type, TYPE_MAX), size: xhr.response.size };
										else entry.response = { type: clip(type, TYPE_MAX), size: -1 };
									} catch {}
								},
								{ once: true },
							);
						}
					} catch {}
					return native.send.call(this, body);
				},
			};
			const fresh: Slot = {
				entries: [],
				active: false,
				removed: false,
				wrap() {
					win.fetch = wrappedFetch as typeof win.fetch;
					Object.assign(proto, wrappers);
					fresh.active = true;
				},
				unwrap() {
					if (win.fetch === (wrappedFetch as unknown)) win.fetch = nativeFetch;
					for (const name of ["open", "setRequestHeader", "send"] as const)
						if (proto[name] === (wrappers[name] as unknown)) (proto as unknown as Record<string, unknown>)[name] = native[name];
					fresh.active = false;
					fresh.entries.length = 0;
					fresh.removed = true;
					fresh.seal(false);
				},
				seal(on) {
					sealed.on = on;
					if (!on) {
						sealed.values.clear();
						sealed.anchor = undefined;
					}
				},
				sealedGet(name) {
					return sealed.on ? sealed.values.get(name.toLowerCase()) : undefined;
				},
				async agentFetch(request) {
					let target: URL;
					try {
						target = new URL(request.url, document.baseURI);
					} catch {
						return { error: "The address is not valid." };
					}
					if (target.origin !== pageOrigin) return { error: "pw --ext fetch sends requests only to the page's own origin." };
					const headers = new win.Headers();
					for (const [name, value] of request.headers) headers.append(name, value);
					if (request.contentType !== undefined) headers.set("content-type", request.contentType);
					if (request.auth) {
						if (!sealed.on || sealed.values.size === 0)
							return {
								error:
									"No sign-in header was seen on this page since the approval. Act in the page, for example open a folder, then retry.",
							};
						for (const [name, value] of sealed.values) headers.set(name, value);
					}
					const entry: NetworkEntry = {
						at: Date.now(),
						via: "fetch",
						method: request.method,
						url: clip(target.href, URL_MAX),
						requestHeaders: [],
						responseHeaders: [],
					};
					headers.forEach((value, name) => addHeader(entry.requestHeaders, name, value));
					if (request.body !== undefined)
						entry.request = textBody(contentType(entry.requestHeaders), request.body, byteLength(request.body));
					try {
						const response = await nativeFetch.call(win, target.href, {
							method: request.method,
							headers,
							...(request.body === undefined ? {} : { body: request.body }),
							credentials: "same-origin",
							redirect: "manual",
						});
						entry.status = response.status;
						response.headers.forEach((value, name) => addHeader(entry.responseHeaders, name, value));
						await readResponse(entry, response);
					} catch {
						entry.failed = true;
					}
					return { entries: [outEntry(entry, request.values)] };
				},
				storage(area, key, keysOnly, values) {
					const store = area === "session" ? win.sessionStorage : win.localStorage;
					const items: PwExtStorageItem[] = [];
					const total = store.length;
					for (let index = 0; index < total && items.length < STORAGE_MAX_KEYS; index++) {
						const name = store.key(index);
						if (name === null || (key !== undefined && name !== key)) continue;
						const raw = store.getItem(name) ?? "";
						const shape = keysOnly ? undefined : jsonShape(raw);
						items.push({
							key: clip(name, KEY_MAX),
							length: raw.length,
							type: shape === undefined ? "text" : "json",
							...(shape === undefined ? {} : { shape }),
							...(values && !keysOnly ? { value: clip(raw, BODY_MAX) } : {}),
						});
					}
					return { items, total: key === undefined ? total : items.length };
				},
				storageGet(area, key) {
					const raw = (area === "session" ? win.sessionStorage : win.localStorage).getItem(key);
					if (raw === null || raw.length > STORAGE_VALUE_MAX) return { missing: true };
					return { value: raw };
				},
			};
			Object.defineProperty(win, KEY, { value: fresh, configurable: false });
			slot = fresh;
		}
		if (action.kind === "remove") slot.unwrap();
		if (slot.removed)
			return action.kind !== "install" && action.kind !== "remove"
				? {
						error:
							"This page lost its network capture when it left an agent tab group. Capture starts again when the page loads in an agent tab.",
					}
				: { entries: [] };
		if (owner !== undefined && slot.owner !== owner) {
			slot.entries.length = 0;
			slot.seal(false);
			slot.owner = owner;
		}
		if (!slot.active) slot.wrap();
		if ((action.kind === "install" && action.seal) || action.kind === "seal") slot.seal(true);
		if (action.kind === "sealed-get") {
			const value = slot.sealedGet(action.name);
			return value === undefined ? { missing: true } : { value };
		}
		if (action.kind === "fetch") {
			const { kind: _, ...request } = action;
			return slot.agentFetch(request);
		}
		if (action.kind === "storage") return slot.storage(action.area, action.key, action.keysOnly === true, action.values);
		if (action.kind === "storage-get") return slot.storageGet(action.area, action.key);
		if (action.kind === "clear") {
			const cleared = slot.entries.length;
			slot.entries.length = 0;
			return { cleared };
		}
		if (action.kind !== "read") return { entries: [] };
		const since = action.since;
		const values = action.values;
		return {
			entries: slot.entries.filter((entry) => since === undefined || entry.at > since).map((entry) => outEntry(entry, values)),
		};
	} catch {
		return { error: "Network capture failed on this page." };
	}
}
