import type { NetworkBody, NetworkEntry, NetworkHeader, NetworkShape } from "@dg/common";

export type PwExtNetworkAction =
	| { kind: "install" }
	| { kind: "remove" }
	| { kind: "read"; values: boolean; since?: number }
	| { kind: "clear" };

export type PwExtNetworkResult = { entries: NetworkEntry[] } | { cleared: number } | { error: string };

/** Self-contained MAIN-world hook that records fetch and XMLHttpRequest calls in a bounded ring; a sensitive header value is never stored, and values leave the page only on a values read. */
export function pwExtNetwork(action: PwExtNetworkAction, expectUrl?: string, owner?: number): PwExtNetworkResult {
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
		const SENSITIVE = /auth|cookie|token|secret|api-?key|session|canary|csrf|xsrf|credential|password|signature/i;
		const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
		type Slot = {
			entries: NetworkEntry[];
			active: boolean;
			removed: boolean;
			owner?: number;
			wrap(): void;
			unwrap(): void;
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
			const addHeader = (list: NetworkHeader[], name: string, value: string) => {
				const entry = header(name, value);
				if (!entry || list.length >= MAX_HEADERS) return;
				const at = list.findIndex((held) => held.name === entry.name);
				if (at === -1) list.push(entry);
				else list[at] = entry;
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
			const record = (entry: NetworkEntry) => {
				fresh.entries.push(entry);
				if (fresh.entries.length > MAX_ENTRIES) fresh.entries.shift();
			};
			const readable = (type: string) => /json|^text\/(?!event-stream)|xml|javascript|x-www-form-urlencoded/i.test(type);
			const readResponse = async (entry: NetworkEntry, response: Response) => {
				const type = contentType(entry.responseHeaders);
				const length = Number(response.headers.get("content-length"));
				const size = Number.isSafeInteger(length) && length >= 0 ? length : -1;
				if (!readable(type) || response.body === null) {
					entry.response = { type: clip(type, TYPE_MAX), size };
					return;
				}
				const reader = response.clone().body?.getReader();
				if (!reader) return;
				const decoder = new TextDecoder();
				let text = "";
				let bytes = 0;
				let cut = false;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > READ_MAX_BYTES) {
						cut = true;
						void reader.cancel().catch(() => undefined);
						break;
					}
					text += decoder.decode(value, { stream: true });
				}
				text += decoder.decode();
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
					request?.headers.forEach((value, name) => addHeader(requestHeaders, name, value));
					if (init?.headers !== undefined)
						new win.Headers(init.headers).forEach((value, name) => addHeader(requestHeaders, name, value));
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
					else if (request && request.body !== null && !request.bodyUsed)
						void request
							.clone()
							.text()
							.then((text) => {
								made.request = textBody(contentType(requestHeaders), text, byteLength(text));
							})
							.catch(() => undefined);
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
			type Tracked = { method: string; url: string; headers: NetworkHeader[] };
			const tracked = new WeakMap<XMLHttpRequest, Tracked>();
			const wrappers = {
				open: function open(this: XMLHttpRequest, ...args: unknown[]) {
					try {
						if (fresh.active) tracked.set(this, { method: methodOf(args[0]), url: absolute(args[1]), headers: [] });
					} catch {}
					return (native.open as (...args: unknown[]) => void).apply(this, args);
				},
				setRequestHeader: function setRequestHeader(this: XMLHttpRequest, name: string, value: string) {
					try {
						const held = fresh.active ? tracked.get(this) : undefined;
						if (held) addHeader(held.headers, String(name), String(value));
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
				},
			};
			Object.defineProperty(win, KEY, { value: fresh, configurable: false });
			slot = fresh;
		}
		if (action.kind === "remove") slot.unwrap();
		if (slot.removed)
			return action.kind === "read" || action.kind === "clear"
				? {
						error:
							"This page lost its network capture when it left an agent tab group. Capture starts again when the page loads in an agent tab.",
					}
				: { entries: [] };
		if (owner !== undefined && slot.owner !== owner) {
			slot.entries.length = 0;
			slot.owner = owner;
		}
		if (!slot.active) slot.wrap();
		if (action.kind === "clear") {
			const cleared = slot.entries.length;
			slot.entries.length = 0;
			return { cleared };
		}
		if (action.kind !== "read") return { entries: [] };
		const since = action.since;
		const strip = (body: NetworkBody | undefined): NetworkBody | undefined =>
			body === undefined
				? undefined
				: {
						type: body.type,
						size: body.size,
						...(body.shape === undefined ? {} : { shape: body.shape }),
						...(action.values && body.text !== undefined ? { text: body.text, ...(body.cut ? { cut: true as const } : {}) } : {}),
					};
		const names = (list: NetworkHeader[]) =>
			list.map(({ name, value }) => (action.values && value !== undefined ? { name, value } : { name }));
		const entries = slot.entries
			.filter((entry) => since === undefined || entry.at > since)
			.map((entry) => {
				const request = strip(entry.request);
				const response = strip(entry.response);
				return {
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
				};
			});
		return { entries: JSON.parse(JSON.stringify(entries)) as NetworkEntry[] };
	} catch {
		return { error: "Network capture failed on this page." };
	}
}
