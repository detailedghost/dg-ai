export type PwExtPageAction =
	| { kind: "snapshot" }
	| { kind: "click"; target: string; handle?: string }
	| { kind: "fill"; target: string; value: string; handle?: string }
	| { kind: "describe"; target: string; handle?: string }
	| {
			kind: "upload";
			handle?: string;
			target: string;
			base64: string;
			fileName: string;
			fileType: string;
	  }
	| { kind: "selection" }
	| { kind: "console" };

/** What the approval shows about a click, fill or upload target. */
export type PwExtElement = {
	tag: string;
	role: string;
	name: string;
	text: string;
	href: string;
};

export type PwExtPageResult =
	| { tree: string; text: string }
	| { detail: string }
	| { element: PwExtElement }
	| { text: string }
	| { started: boolean; entries: string[] }
	| { error: string };

/** Self-contained action that scripting.executeScript runs in the tab's isolated world. */
export function pwExtPageAction(
	action: PwExtPageAction,
	expectUrl?: string,
): PwExtPageResult {
	const TREE_MAX = 60_000;
	const TEXT_MAX = 30_000;
	const SELECTION_MAX = 20_000;
	const NODE_MAX = 2_000;
	const DEPTH_MAX = 16;
	const CONSOLE_MAX = 50;
	const REDACTED = "[redacted]";
	const doc = document;
	const win = doc.defaultView as unknown as Window & Record<symbol, unknown>;
	const REFS = Symbol.for("dg.pwExt.refs");
	const HANDLES = Symbol.for("dg.pwExt.handles");
	const CONSOLE = Symbol.for("dg.pwExt.console");
	const SECRET_NAME = /pass|secret|token|otp|cvv|cvc|ssn|pin\b|api[-_]?key/i;
	const TEXT_INPUTS = new Set([
		"",
		"text",
		"search",
		"email",
		"url",
		"tel",
		"number",
	]);
	const INTERACTIVE = new Set([
		"link",
		"button",
		"textbox",
		"searchbox",
		"checkbox",
		"radio",
		"combobox",
		"listbox",
		"option",
		"menuitem",
		"tab",
		"switch",
		"slider",
		"spinbutton",
	]);
	const LEAF = new Set([...INTERACTIVE, "heading", "img"]);

	const squash = (value: string, max = 80): string => {
		const text = redactTokens(value).replace(/\s+/g, " ").trim();
		return text.length > max ? `${text.slice(0, max)}…` : text;
	};
	const cap = (value: string, max: number): string =>
		value.length > max
			? `${value.slice(0, max)}\n[truncated: ${value.length - max} more characters]`
			: value;

	const isSecret = (el: Element): boolean => {
		const input = el as HTMLInputElement;
		if (el.tagName === "INPUT" && input.type === "password") return true;
		const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
		if (/password|one-time-code|cc-|csc/.test(autocomplete)) return true;
		return SECRET_NAME.test(
			`${el.getAttribute("name") ?? ""} ${el.id ?? ""}`,
		);
	};

	const hidden = (el: Element): boolean => {
		if (el.closest("[hidden],[aria-hidden='true'],[inert]")) return true;
		if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden")
			return true;
		const check = (
			el as Element & {
				checkVisibility?: (options: { visibilityProperty: boolean }) => boolean;
			}
		).checkVisibility;
		if (typeof check === "function")
			return !check.call(el, { visibilityProperty: true });
		const style = win.getComputedStyle?.(el);
		return style?.display === "none" || style?.visibility === "hidden";
	};

	const role = (el: Element): string | undefined => {
		const explicit = el.getAttribute("role")?.split(/\s+/)[0]?.slice(0, 40);
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "input") {
			const type = (el as HTMLInputElement).type.toLowerCase();
			if (type === "checkbox") return "checkbox";
			if (type === "radio") return "radio";
			if (["button", "submit", "reset", "image", "file"].includes(type))
				return "button";
			if (type === "search") return "searchbox";
			if (type === "range") return "slider";
			return "textbox";
		}
		const map: Record<string, string> = {
			button: "button",
			textarea: "textbox",
			select: "combobox",
			option: "option",
			img: "img",
			nav: "navigation",
			main: "main",
			header: "banner",
			footer: "contentinfo",
			aside: "complementary",
			form: "form",
			dialog: "dialog",
			ul: "list",
			ol: "list",
			li: "listitem",
			table: "table",
			tr: "row",
			td: "cell",
			th: "columnheader",
		};
		if (tag === "a") return el.hasAttribute("href") ? "link" : undefined;
		if (el.getAttribute("contenteditable") === "true") return "textbox";
		return map[tag];
	};

	const labelText = (el: Element): string => {
		const ids = el.getAttribute("aria-labelledby");
		if (ids)
			return ids
				.split(/\s+/)
				.map((id) => {
					const target = doc.getElementById(id);
					return target ? safeText(target) : "";
				})
				.join(" ");
		const aria = el.getAttribute("aria-label");
		if (aria) return aria;
		if (el.id) {
			const label = doc.querySelector(
				`label[for="${el.id.replace(/["\\]/g, "\\$&")}"]`,
			);
			if (label) return safeText(label);
		}
		const wrapping = el.closest("label");
		if (wrapping) {
			const copy = wrapping.cloneNode(true) as Element;
			for (const field of copy.querySelectorAll("input,select,textarea"))
				field.remove();
			const text = safeText(copy);
			if (text.trim()) return text;
		}
		return (
			el.getAttribute("alt") ??
			el.getAttribute("title") ??
			el.getAttribute("placeholder") ??
			""
		);
	};

	const name = (el: Element, r: string): string => {
		const label = labelText(el);
		if (label.trim()) return squash(label);
		if (["textbox", "searchbox", "combobox", "checkbox", "radio"].includes(r))
			return "";
		return squash(safeText(el));
	};

	const describe = (el: Element): string => {
		const r = role(el) ?? el.tagName.toLowerCase();
		const n = name(el, r);
		return n ? `${r} "${n}"` : r;
	};

	const secretFields = (): Element[] =>
		Array.from(
			doc.querySelectorAll("textarea,[contenteditable],[role='textbox']"),
		).filter(isSecret);

	const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
	const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|NAV|MAIN|ASIDE|FORM|BLOCKQUOTE|PRE|DT|DD|BR|LABEL|BUTTON)$/;

	const safeText = (root: Element): string => {
		const parts: string[] = [];
		const visit = (node: Node): void => {
			if (node.nodeType === 3) {
				parts.push(node.nodeValue ?? "");
				return;
			}
			if (node.nodeType !== 1) return;
			const el = node as Element;
			if (SKIP_TAGS.has(el.tagName) || isSecret(el)) return;
			for (const child of Array.from(el.childNodes)) visit(child);
		};
		visit(root);
		return parts.join(" ");
	};

	const visibleText = (): string => {
		const parts: string[] = [];
		const visit = (node: Node): void => {
			if (node.nodeType === 3) {
				const value = (node.nodeValue ?? "").replace(/\s+/g, " ");
				if (value.trim()) parts.push(value);
				return;
			}
			if (node.nodeType !== 1) return;
			const el = node as Element;
			if (SKIP_TAGS.has(el.tagName) || el.tagName === "TEXTAREA") return;
			if (isSecret(el) || hidden(el)) return;
			const block = BLOCK.test(el.tagName);
			if (block) parts.push("\n");
			for (const child of Array.from(el.childNodes)) visit(child);
			if (block) parts.push("\n");
		};
		visit(doc.body);
		return parts
			.join("")
			.replace(/[ \t]*\n[ \t]*/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	};

	const TOKEN_PATTERNS: [RegExp, string][] = [
		[/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
		[/([?#&](?:token|access_token|refresh_token|id_token|code|session|api_key|apikey|key|password|secret)=)[^&#\s]+/gi, `$1${REDACTED}`],
		[/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|glpat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g, REDACTED],
		[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
		[/((?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*)\S+/gi, `$1${REDACTED}`],
		[/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED],
	];
	const redactTokens = (value: string): string =>
		TOKEN_PATTERNS.reduce(
			(out, [pattern, replacement]) => out.replace(pattern, replacement),
			value,
		);
	const sanitize = (result: PwExtPageResult): PwExtPageResult => {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(result))
			out[key] =
				typeof value === "string"
					? redactTokens(value)
					: Array.isArray(value)
						? value.map((entry) => redactTokens(String(entry)))
						: value && typeof value === "object"
							? Object.fromEntries(
									Object.entries(value).map(([k, v]) => [
										k,
										redactTokens(String(v)),
									]),
								)
							: value;
		return out as PwExtPageResult;
	};

	const insideSecret = (node: Node | null | undefined): boolean => {
		const el = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
		for (let at: Element | null | undefined = el; at; at = at.parentElement)
			if (isSecret(at)) return true;
		return false;
	};

	const snapshot = (): PwExtPageResult => {
		const refs = new Map<string, Element>();
		win[REFS] = refs;
		const lines: string[] = [];
		let nodes = 0;
		const walk = (parent: Element, depth: number): void => {
			for (const child of Array.from(parent.children)) {
				if (nodes >= NODE_MAX) return;
				if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(child.tagName))
					continue;
				if (hidden(child)) continue;
				const r = role(child);
				if (!r || depth >= DEPTH_MAX) {
					walk(child, depth);
					continue;
				}
				nodes++;
				const n = name(child, r);
				let line = `${"  ".repeat(depth)}- ${r}${n ? ` "${n.replaceAll('"', '\\"')}"` : ""}`;
				if (r === "heading") line += ` [level=${child.tagName.slice(1) || "2"}]`;
				if (
					(r === "checkbox" || r === "radio") &&
					(child as HTMLInputElement).checked
				)
					line += " [checked]";
				if (INTERACTIVE.has(r)) {
					const ref = `e${refs.size + 1}`;
					refs.set(ref, child);
					line += ` [ref=${ref}]`;
				}
				if (
					(r === "textbox" || r === "searchbox" || r === "combobox") &&
					isSecret(child)
				)
					line += `: ${REDACTED}`;
				else if (r === "textbox" || r === "searchbox" || r === "combobox") {
					const value =
						child.tagName === "SELECT"
							? ((child as HTMLSelectElement).selectedOptions?.[0]?.textContent ?? "")
							: "value" in child
								? String((child as HTMLInputElement).value ?? "")
								: (child.textContent ?? "");
					if (value) line += `: ${squash(value, 200)}`;
				}
				const before = lines.length;
				lines.push(line);
				if (!LEAF.has(r)) {
					walk(child, depth + 1);
					if (lines.length === before + 1) {
						const text = squash(safeText(child), 120);
						if (text) lines[before] += `: ${text}`;
					}
				}
			}
		};
		walk(doc.body, 0);
		if (nodes >= NODE_MAX) lines.push(`[truncated: more than ${NODE_MAX} nodes]`);
		const text = visibleText();
		return {
			tree: cap(redactTokens(lines.join("\n")), TREE_MAX),
			text: cap(redactTokens(text), TEXT_MAX),
		};
	};

	const resolve = (target: string): Element | string => {
		if (/^e\d+$/.test(target)) {
			const found = (win[REFS] as Map<string, Element> | undefined)?.get(target);
			if (!found || !found.isConnected)
				return `Ref ${target} not found. Run dg-skills pw --ext snapshot again.`;
			return found;
		}
		let matches: Element[];
		try {
			matches = Array.from(doc.querySelectorAll(target));
		} catch {
			return `${target} is not a valid CSS selector or ref.`;
		}
		if (matches.length === 0) return `No element matches ${target}.`;
		if (matches.length > 1)
			return `${target} matches ${matches.length} elements; use a ref from snapshot or a narrower selector.`;
		return matches[0] as Element;
	};

	const click = (target: string, handle?: string): PwExtPageResult => {
		const el = bound(target, handle);
		if (typeof el === "string") return { error: el };
		if ((el as HTMLButtonElement).disabled)
			return { error: `${describe(el)} is disabled.` };
		(el as HTMLElement).scrollIntoView?.({ block: "center" });
		if (typeof (el as HTMLElement).click === "function")
			(el as HTMLElement).click();
		else
			el.dispatchEvent(
				new (win as unknown as typeof globalThis).MouseEvent("click", {
					bubbles: true,
					cancelable: true,
				}),
			);
		return { detail: `clicked ${describe(el)}` };
	};

	const fill = (target: string, value: string, handle?: string): PwExtPageResult => {
		const el = bound(target, handle);
		if (typeof el === "string") return { error: el };
		if (isSecret(el))
			return { error: "pw --ext does not fill password or secret fields." };
		const input = el as HTMLInputElement;
		const editable = el.getAttribute("contenteditable") === "true";
		const field =
			(el.tagName === "INPUT" && TEXT_INPUTS.has(input.type.toLowerCase())) ||
			el.tagName === "TEXTAREA";
		if ((!field && !editable) || input.disabled || input.readOnly)
			return { error: `${describe(el)} cannot be filled.` };
		input.focus?.();
		if (editable) el.textContent = value;
		else {
			const setter = Object.getOwnPropertyDescriptor(
				Object.getPrototypeOf(el),
				"value",
			)?.set;
			if (setter) setter.call(el, value);
			else input.value = value;
		}
		const EventCtor = (win as unknown as typeof globalThis).Event;
		el.dispatchEvent(new EventCtor("input", { bubbles: true }));
		el.dispatchEvent(new EventCtor("change", { bubbles: true }));
		return { detail: `filled ${describe(el)}` };
	};

	const destination = (el: Element): string => {
		const link = el.closest("a[href]") as HTMLAnchorElement | null;
		if (link) return String(link.href ?? "");
		const control = el as HTMLButtonElement;
		const submits =
			(el.tagName === "BUTTON" && (control.type ?? "submit") === "submit") ||
			(el.tagName === "INPUT" && ["submit", "image"].includes(control.type));
		if (submits && control.form)
			return String(control.formAction || control.form.action || "");
		return "";
	};

	const fingerprint = (el: Element): string => {
		const input = el as HTMLInputElement;
		const r = role(el) ?? el.tagName.toLowerCase();
		return JSON.stringify([
			el.tagName,
			r,
			name(el, r),
			squash(safeText(el), 120),
			input.type ?? "",
			Boolean(input.disabled),
			Boolean(input.readOnly),
			el.getAttribute("contenteditable") ?? "",
			destination(el),
		]);
	};

	const bound = (target: string, handle?: string): Element | string => {
		const el = resolve(target);
		if (typeof el === "string" || handle === undefined) return el;
		const handles = win[HANDLES] as
			| Map<string, { el: Element; print: string }>
			| undefined;
		const approved = handles?.get(handle);
		handles?.delete(handle);
		if (approved?.el !== el || !el.isConnected || fingerprint(el) !== approved.print)
			return "The element changed after approval; nothing was done. Retry.";
		return el;
	};

	const describeTarget = (target: string, handle?: string): PwExtPageResult => {
		const el = resolve(target);
		if (typeof el === "string") return { error: el };
		if (handle !== undefined)
			win[HANDLES] = new Map([[handle, { el, print: fingerprint(el) }]]);
		const tag = el.tagName.toLowerCase().slice(0, 40);
		const r = role(el) ?? tag;
		return {
			element: {
				tag,
				role: r,
				name: name(el, r),
				text: squash(safeText(el), 120),
				href: (() => {
					const full = destination(el);
					return full.length > 2048 ? `${full.slice(0, 2048)}…` : full;
				})(),
			},
		};
	};

	const upload = (
		target: string,
		base64: string,
		fileName: string,
		fileType: string,
		handle?: string,
	): PwExtPageResult => {
		const el = bound(target, handle);
		if (typeof el === "string") return { error: el };
		const input = el as HTMLInputElement;
		if (el.tagName !== "INPUT" || input.type.toLowerCase() !== "file" || input.disabled)
			return { error: `${describe(el)} is not an enabled file input.` };
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		const scope = win as unknown as typeof globalThis;
		const transfer = new scope.DataTransfer();
		transfer.items.add(new scope.File([bytes], fileName, { type: fileType }));
		input.files = transfer.files;
		input.dispatchEvent(new scope.Event("input", { bubbles: true }));
		input.dispatchEvent(new scope.Event("change", { bubbles: true }));
		return { detail: `uploaded ${fileName} to ${describe(el)}` };
	};

	const selection = (): PwExtPageResult => {
		const active = doc.activeElement as HTMLInputElement | null;
		if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
			if (isSecret(active)) return { text: "" };
			const start = active.selectionStart ?? 0;
			const end = active.selectionEnd ?? 0;
			if (end > start)
				return {
					text: cap(redactTokens(active.value.slice(start, end)), SELECTION_MAX),
				};
		}
		const selected = win.getSelection();
		if (
			insideSecret(selected?.anchorNode) ||
			insideSecret(selected?.focusNode) ||
			(active && insideSecret(active)) ||
			secretFields().some((field) => selected?.containsNode(field, true))
		)
			return { text: "" };
		return { text: cap(redactTokens(selected?.toString() ?? ""), SELECTION_MAX) };
	};

	const consoleCapture = (): PwExtPageResult => {
		const existing = win[CONSOLE] as string[] | undefined;
		if (existing) return { started: false, entries: [...existing] };
		const entries: string[] = [];
		win[CONSOLE] = entries;
		const push = (line: string) => {
			entries.push(squash(line, 500));
			if (entries.length > CONSOLE_MAX) entries.shift();
		};
		win.addEventListener(
			"error",
			(event) => {
				const e = event as ErrorEvent;
				if (!e.message) return;
				push(
					`[error] ${e.message}${e.filename ? ` (${e.filename}:${e.lineno ?? 0})` : ""}`,
				);
			},
			true,
		);
		win.addEventListener("unhandledrejection", (event) => {
			const reason = (event as PromiseRejectionEvent).reason;
			push(
				`[error] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
			);
		});
		return { started: true, entries: [] };
	};

	if (expectUrl !== undefined && doc.URL !== expectUrl)
		return {
			error: "The page changed after approval; nothing was done. Retry.",
		};
	const run = (): PwExtPageResult => {
		switch (action.kind) {
			case "snapshot":
				return snapshot();
			case "click":
				return click(action.target, action.handle);
			case "fill":
				return fill(action.target, action.value, action.handle);
			case "selection":
				return selection();
			case "describe":
				return describeTarget(action.target, action.handle);
			case "upload":
				return upload(
					action.target,
					action.base64,
					action.fileName,
					action.fileType,
					action.handle,
				);
			case "console":
				return consoleCapture();
		}
	};
	return sanitize(run());
}
