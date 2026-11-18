export type PwExtPageAction =
	| { kind: "snapshot" }
	| { kind: "click"; target: string }
	| { kind: "count"; target: string }
	| { kind: "fill"; target: string; value: string; secret?: boolean; until?: number }
	| { kind: "press"; chord: string; key: string; modifiers: string[] }
	| {
			kind: "upload";
			target: string;
			base64: string;
			fileName: string;
			fileType: string;
	  }
	| { kind: "selection" }
	| { kind: "console" };

export type PwExtPageResult =
	| { tree: string; text: string }
	| { detail: string }
	| { text: string }
	| { started: boolean; entries: string[] }
	| { error: string };

/** Self-contained action that scripting.executeScript runs in the tab's isolated world. */
export function pwExtPageAction(
	action: PwExtPageAction,
	expectUrl?: string,
	unmask = false,
	secrets: string[] = [],
	until?: number,
): PwExtPageResult {
	const TREE_MAX = 60_000;
	const TEXT_MAX = 30_000;
	const SELECTION_MAX = 20_000;
	const NODE_MAX = 2_000;
	const DEPTH_MAX = 16;
	const CONSOLE_MAX = 50;
	const COUNT_LIST_MAX = 20;
	const REDACTED = "[redacted]";
	const doc = document;
	const win = doc.defaultView as unknown as Window & Record<symbol, unknown>;
	const REFS = Symbol.for("dg.pwExt.refs");
	const EDITED = Symbol.for("dg.pwExt.pressEdited");
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
	const ATOMIC_INPUTS = new Set(["number", "email", "url"]);
	const DATE_INPUTS: Record<string, [RegExp, string]> = {
		date: [/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"],
		time: [/^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/, "HH:MM (24-hour)"],
		"datetime-local": [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "YYYY-MM-DDTHH:MM"],
		month: [/^\d{4}-\d{2}$/, "YYYY-MM"],
		week: [/^\d{4}-W\d{2}$/, "YYYY-Www"],
	};
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
		...(unmask ? [] : [[/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED] as [RegExp, string]]),
	];
	const literals = [
		...new Set(
			secrets
				.filter((secret) => secret.length > 0)
				.flatMap((secret) => [secret, secret.replace(/\s+/g, " "), secret.replace(/[\r\n]/g, "")]),
		),
	]
		.filter((secret) => secret.length > 0)
		.sort((a, b) => b.length - a.length);
	const redactTokens = (value: string): string => {
		const masked = new Uint8Array(value.length);
		for (const secret of literals)
			for (let at = value.indexOf(secret); at !== -1; at = value.indexOf(secret, at + 1))
				masked.fill(1, at, at + secret.length);
		for (const [pattern, replacement] of TOKEN_PATTERNS)
			for (const match of value.matchAll(pattern)) {
				const kept = replacement.startsWith("$1")
					? (match[1] ?? "").length
					: replacement.startsWith("Bearer")
						? (/^Bearer\s+/i.exec(match[0])?.[0].length ?? 0)
						: 0;
				masked.fill(1, (match.index ?? 0) + kept, (match.index ?? 0) + match[0].length);
			}
		const parts: string[] = [];
		let start = 0;
		for (let i = 0; i <= value.length; i++) {
			if (i < value.length && masked[i] === (masked[start] ?? 0)) continue;
			parts.push(masked[start] ? REDACTED : value.slice(start, i));
			start = i;
		}
		return parts.join("");
	};
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

	const candidates = (target: string): Element[] | string => {
		if (/^e\d+$/.test(target)) {
			const found = (win[REFS] as Map<string, Element> | undefined)?.get(target);
			if (!found || !found.isConnected)
				return `Ref ${target} not found. Run dg-skills pw --ext snapshot again.`;
			return [found];
		}
		try {
			return Array.from(doc.querySelectorAll(target));
		} catch {
			return `${target} is not a valid CSS selector or ref.`;
		}
	};

	const resolve = (target: string): Element | string => {
		const matches = candidates(target);
		if (typeof matches === "string") return matches;
		if (matches.length === 0) return `No element matches ${target}.`;
		if (matches.length > 1)
			return `${target} matches ${matches.length} elements; use a ref from snapshot or a narrower selector.`;
		return matches[0] as Element;
	};

	const opaqueId = (value: string): boolean => {
		if (/^\d{5,}$/.test(value)) return true;
		if (/\s/.test(value)) return false;
		if (value.length >= 12 && /[%=+/]/.test(value)) return true;
		if (value.length < 16) return false;
		if (/\d/.test(value) && /[A-Za-z]/.test(value)) return true;
		const letters = value.replace(/[^A-Za-z]/g, "");
		const upper = value.replace(/[^A-Z]/g, "").length;
		return value.length >= 20 && /[a-z]/.test(value) && upper >= letters.length * 0.3;
	};

	const tagOf = (el: Element): string => {
		const attrs = ["type", "id", "name"].flatMap((attr) => {
			const value = el.getAttribute(attr);
			if (value === null) return [];
			return [` ${attr}="${attr !== "type" && opaqueId(value) ? REDACTED : squash(value, 80)}"`];
		});
		return `<${el.tagName.toLowerCase()}${attrs.join("")}>`;
	};

	const count = (target: string): PwExtPageResult => {
		const matches = candidates(target);
		if (typeof matches === "string") return { error: matches };
		const listed = matches.slice(0, COUNT_LIST_MAX).map((el, i) => {
			const label = insideSecret(el) ? REDACTED : describe(el);
			const tag = tagOf(el);
			return `${i + 1}. ${tag}${label === el.tagName.toLowerCase() ? "" : ` ${label}`}`;
		});
		const more = matches.length - listed.length;
		return {
			detail: [
				`${target} matches ${matches.length} element${matches.length === 1 ? "" : "s"}`,
				...listed,
				...(more > 0 ? [`… ${more} more`] : []),
			].join("\n"),
		};
	};

	const click = (target: string): PwExtPageResult => {
		const el = resolve(target);
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

	const fire = (el: Element): void => {
		const EventCtor = (win as unknown as typeof globalThis).Event;
		el.dispatchEvent(new EventCtor("input", { bubbles: true }));
		el.dispatchEvent(new EventCtor("change", { bubbles: true }));
	};

	const setValue = (el: Element, value: string): void => {
		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
		if (setter) setter.call(el, value);
		else (el as HTMLInputElement).value = value;
	};

	const pick = (select: HTMLSelectElement, value: string): PwExtPageResult => {
		if (select.multiple) return { error: `${describe(select)} allows multiple choices; pw --ext picks one option only.` };
		const options = [...select.options];
		const label = (option: HTMLOptionElement) => (option.getAttribute("label") || option.text).replace(/\s+/g, " ").trim();
		const lower = value.toLowerCase();
		const index = [
			options.findIndex((option) => option.value === value),
			options.findIndex((option) => label(option) === value),
			options.findIndex((option) => label(option).toLowerCase() === lower),
		].find((at) => at >= 0);
		if (index === undefined) {
			const names = options.slice(0, 10).map((option) => `"${squash(label(option), 40)}"`);
			const more = options.length > 10 ? `, … ${options.length - 10} more` : "";
			return { error: `${describe(select)} has no option "${squash(value, 40)}". Options: ${names.join(", ")}${more}.` };
		}
		const option = options[index] as HTMLOptionElement;
		const group = option.parentElement as HTMLOptGroupElement | null;
		if (option.disabled || (group?.tagName === "OPTGROUP" && group.disabled))
			return { error: `The option "${squash(label(option), 40)}" in ${describe(select)} is disabled.` };
		select.selectedIndex = index;
		fire(select);
		return { detail: `selected "${squash(label(options[index] as HTMLOptionElement), 40)}" in ${describe(select)}` };
	};

	const fillDate = (input: HTMLInputElement, value: string): PwExtPageResult => {
		const [pattern, format] = DATE_INPUTS[input.type.toLowerCase()] as [RegExp, string];
		if (!pattern.test(value)) return { error: `${describe(input)} takes ${format}.` };
		const before = input.value;
		setValue(input, value);
		if (input.value === "") {
			setValue(input, before);
			return { error: `${describe(input)} takes ${format}.` };
		}
		fire(input);
		return { detail: `filled ${describe(input)}` };
	};

	const fill = (target: string, value: string, secret: boolean, until?: number): PwExtPageResult => {
		const el = resolve(target);
		if (typeof el === "string") return { error: el };
		if (isSecret(el) && (!unmask || (until !== undefined && Date.now() >= until)))
			return {
				error: "pw --ext fills a password or secret field only during an unmask grant. Run pw --ext unmask; the user approves it in the browser.",
			};
		if (isSecret(el) && !secret)
			return {
				error: "Pass a password or secret with --value-env <NAME> or --value-stdin, never on the command line.",
			};
		if (secret && !isSecret(el))
			return { error: "--value-env and --value-stdin fill only a password or secret field." };
		const input = el as HTMLInputElement;
		if (input.disabled || input.readOnly) return { error: `${describe(el)} cannot be filled.` };
		if (el.tagName === "SELECT") return pick(el as HTMLSelectElement, value);
		if (el.tagName === "INPUT" && Object.hasOwn(DATE_INPUTS, input.type.toLowerCase())) return fillDate(input, value);
		const editable = el.getAttribute("contenteditable") === "true";
		const field =
			(el.tagName === "INPUT" &&
				(TEXT_INPUTS.has(input.type.toLowerCase()) || (secret && input.type.toLowerCase() === "password"))) ||
			el.tagName === "TEXTAREA";
		if ((!field && !editable) || input.disabled || input.readOnly)
			return { error: `${describe(el)} cannot be filled.` };
		input.focus?.();
		(win[EDITED] as WeakSet<Element> | undefined)?.delete(el);
		if (editable || secret || ATOMIC_INPUTS.has(input.type.toLowerCase())) {
			if (editable) el.textContent = value;
			else setValue(el, value);
			fire(el);
			return { detail: `filled ${describe(el)}` };
		}
		const chars = [...(el.tagName === "TEXTAREA" ? value.replace(/\r\n?/g, "\n") : value.replace(/[\r\n]/g, ""))];
		const typed = typeText(input, chars);
		if (typed < 0) return { error: `${describe(el)} kept its old value.` };
		input.dispatchEvent(new (win as unknown as typeof globalThis).Event("change", { bubbles: true }));
		if (typed < chars.length) return { error: `${describe(el)} took ${typed} of ${chars.length} characters.` };
		return { detail: `filled ${describe(el)}` };
	};

	const upload = (
		target: string,
		base64: string,
		fileName: string,
		fileType: string,
	): PwExtPageResult => {
		const el = resolve(target);
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

	const FOCUSABLE = "a[href],button,input,select,textarea,summary,iframe,[contenteditable='true'],[tabindex]";
	const BUTTON_INPUTS = new Set(["submit", "button", "reset", "image", "checkbox", "radio", "file", "color", "range"]);

	const focusOrder = (): HTMLElement[] => {
		const index = (el: HTMLElement): number =>
			!el.hasAttribute("tabindex") && el.getAttribute("contenteditable") === "true" ? 0 : el.tabIndex;
		const radioSkipped = (el: HTMLElement): boolean => {
			const radio = el as HTMLInputElement;
			if (el.tagName !== "INPUT" || radio.type.toLowerCase() !== "radio" || !radio.name || radio.checked) return false;
			return (Array.from(doc.querySelectorAll("input")) as HTMLInputElement[]).some(
				(other) => other.type.toLowerCase() === "radio" && other.name === radio.name && other.form === radio.form && other.checked,
			);
		};
		const order = (Array.from(doc.querySelectorAll(FOCUSABLE)) as HTMLElement[]).filter(
			(el) => index(el) >= 0 && !el.matches(":disabled") && !el.closest("fieldset[disabled]") && !hidden(el) && !radioSkipped(el),
		);
		return [...order.filter((el) => index(el) > 0).sort((a, b) => index(a) - index(b)), ...order.filter((el) => index(el) === 0)];
	};

	const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

	const keyInit = (name: string, char: string | undefined, held: Set<string>) => ({
		key: name,
		code: /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : /^\d$/.test(name) ? `Digit${name}` : name === " " ? "Space" : char ? "" : name,
		bubbles: true,
		cancelable: true,
		composed: true,
		shiftKey: held.has("Shift"),
		ctrlKey: held.has("Control"),
		altKey: held.has("Alt"),
		metaKey: held.has("Meta"),
	});

	const edit = (input: HTMLInputElement, text: string, inputType: string, range?: [number, number]): boolean => {
		const value = input.value;
		const [start, end] = range ?? [input.selectionStart ?? value.length, input.selectionEnd ?? value.length];
		let from = start;
		let to = end;
		if (text === "" && start === end) {
			if (inputType === "deleteContentBackward" && start > 0)
				from = start - (start > 1 && LOW_SURROGATE.test(value[start - 1] ?? "") ? 2 : 1);
			if (inputType === "deleteContentForward" && end < value.length)
				to = end + (LOW_SURROGATE.test(value[end + 1] ?? "") ? 2 : 1);
		}
		if (from === to && text === "") return false;
		if (text && input.maxLength >= 0 && value.length - (to - from) + text.length > input.maxLength) return false;
		const next = value.slice(0, from) + text + value.slice(to);
		setValue(input, next);
		const kept = input.value === next;
		setValue(input, value);
		try {
			input.setSelectionRange(start, end);
		} catch {}
		if (!kept) return false;
		const scope = win as unknown as typeof globalThis;
		const data = text ? { data: text } : {};
		if (!input.dispatchEvent(new scope.InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType, ...data }))) return false;
		if (!input.isConnected) return false;
		setValue(input, next);
		try {
			input.setSelectionRange(from + text.length, from + text.length);
		} catch {}
		input.dispatchEvent(new scope.InputEvent("input", { bubbles: true, composed: true, inputType, ...data }));
		return true;
	};

	const typeText = (input: HTMLInputElement, chars: string[]): number => {
		const scope = win as unknown as typeof globalThis;
		let range: [number, number] = [0, input.value.length];
		if (chars.length === 0) return range[1] === 0 || edit(input, "", "deleteContentBackward", range) ? 0 : -1;
		const caret = (): [number, number] => {
			try {
				const start = input.selectionStart;
				if (start !== null) return [start, input.selectionEnd ?? start];
			} catch {}
			return [input.value.length, input.value.length];
		};
		let typed = 0;
		for (const char of chars) {
			const line = char === "\n";
			const init = keyInit(line ? "Enter" : char, line ? undefined : char, new Set());
			const send = (kind: string): boolean => input.dispatchEvent(new scope.KeyboardEvent(kind, init));
			const landed = send("keydown") && send("keypress") && input.isConnected && edit(input, char, line ? "insertLineBreak" : "insertText", range);
			if (input.isConnected) send("keyup");
			if (!landed) break;
			typed++;
			range = caret();
		}
		return typed;
	};

	const submit = (form: HTMLFormElement): string => {
		const submitter = (Array.from(doc.querySelectorAll("button,input")) as HTMLButtonElement[]).find(
			(el) => el.form === form && (el.tagName === "BUTTON" ? el.type === "submit" : ["submit", "image"].includes(el.type.toLowerCase())),
		);
		if (submitter) {
			if ((submitter as HTMLButtonElement).disabled) return "";
			submitter.click();
			return `; clicked ${describe(submitter)} to submit the form`;
		}
		const blocking = Array.from(form.elements).filter(
			(el) => el.tagName === "INPUT" && !BUTTON_INPUTS.has((el as HTMLInputElement).type.toLowerCase()) && (el as HTMLInputElement).type.toLowerCase() !== "hidden",
		);
		if (blocking.length > 1) return "";
		form.requestSubmit();
		return "; submitted the form";
	};

	const press = (chord: string, key: string, modifiers: string[]): PwExtPageResult => {
		const scope = win as unknown as typeof globalThis;
		const active = doc.activeElement;
		const target = active && active !== doc.body ? active : (doc.body ?? doc.documentElement);
		const label = target === doc.body || target === doc.documentElement ? "the page" : describe(target);
		const mac = /Mac|iPhone|iPad/.test(scope.navigator?.platform ?? "");
		const held = new Set(modifiers.map((m) => (m === "ControlOrMeta" ? (mac ? "Meta" : "Control") : m)));
		const command = held.has("Control") || held.has("Alt") || held.has("Meta");
		const name = key === "Space" ? " " : key;
		const char = [...name].length === 1 && !command ? name : undefined;
		const input = target as HTMLInputElement;
		const type = target.tagName === "INPUT" ? input.type.toLowerCase() : "";
		const textField =
			(target.tagName === "INPUT" && (TEXT_INPUTS.has(type) || type === "password")) || target.tagName === "TEXTAREA";
		const typing = char !== undefined || name === "Backspace" || name === "Delete" || (name === "Enter" && target.tagName === "TEXTAREA");
		const caretless = (): boolean => {
			try {
				return input.selectionStart === null;
			} catch {
				return true;
			}
		};
		if (typing && textField && caretless())
			return { error: `pw --ext press cannot edit ${describe(target)}: the browser hides its caret. Use pw --ext fill to set its value.` };
		if (typing && (isSecret(target) || insideSecret(target)))
			return { error: "pw --ext press does not type into a password or secret field. Use pw --ext fill <target> --value-env NAME." };
		const init = keyInit(name, char, held);
		const send = (type: string, to: Element = target): boolean => to.dispatchEvent(new scope.KeyboardEvent(type, init));
		const edited = (win[EDITED] ??= new WeakSet<Element>()) as WeakSet<Element>;
		const commit = (): void => {
			if (!edited.delete(target)) return;
			target.dispatchEvent(new scope.Event("change", { bubbles: true }));
		};
		const change = (text: string, inputType: string): void => {
			const fresh = !edited.has(target);
			if (fresh) {
				edited.add(target);
				target.addEventListener("focusout", commit, { once: true });
			}
			if (edit(input, text, inputType) || !fresh) return;
			edited.delete(target);
			target.removeEventListener("focusout", commit);
		};
		let proceed = send("keydown");
		if (proceed && !command && (char !== undefined || name === "Enter")) proceed = send("keypress");
		let effect = "";
		let spaceClick = false;
		const editable = textField && !input.disabled && !input.readOnly;
		if (proceed && target.isConnected && !command) {
			if (name === "Tab") {
				commit();
				const order = focusOrder();
				const back = held.has("Shift");
				const at = order.indexOf(target as HTMLElement);
				const inPage = at < 0 && target !== doc.body && target !== doc.documentElement;
				const after = (el: Element) => (target.compareDocumentPosition(el) & 4) !== 0;
				const next = inPage
					? back
						? order.filter((el) => !after(el)).pop() ?? order[order.length - 1]
						: order.find(after) ?? order[0]
					: back
						? order[at <= 0 ? order.length - 1 : at - 1]
						: order[(at + 1) % order.length];
				if (next) {
					next.focus();
					effect = `; focus moved to ${describe(next)}`;
				}
			} else if (name === "Enter" && target.tagName === "TEXTAREA") {
				if (editable) change("\n", "insertLineBreak");
			} else if (name === "Enter" && target.tagName === "INPUT" && !BUTTON_INPUTS.has(type)) {
				commit();
				if (input.form && target.isConnected) effect = submit(input.form);
			} else if (name === "Enter" && (target.tagName === "BUTTON" || (target.tagName === "A" && target.hasAttribute("href")) || ["submit", "button", "reset", "image"].includes(type))) {
				(target as HTMLElement).click();
				effect = `; clicked ${label}`;
			} else if (name === " " && (target.tagName === "BUTTON" || ["submit", "button", "reset", "image", "checkbox", "radio"].includes(type))) {
				spaceClick = true;
			} else if (editable && char !== undefined) change(char, "insertText");
			else if (editable && name === "Backspace") change("", "deleteContentBackward");
			else if (editable && name === "Delete") change("", "deleteContentForward");
		}
		const focused = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : target;
		const released = focused.isConnected && send("keyup", focused);
		if (spaceClick && released && target.isConnected) {
			(target as HTMLElement).click();
			effect = `; clicked ${label}`;
		}
		return { detail: `pressed ${chord} on ${label}${effect}` };
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
		if (existing) return { started: false, entries: existing.map((entry) => squash(entry, 500)) };
		const entries: string[] = [];
		win[CONSOLE] = entries;
		const push = (line: string) => {
			entries.push(line.slice(0, 20_000));
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
			error: "The page changed; nothing was done. Retry.",
		};
	if (until !== undefined && Date.now() > until)
		return { error: "The action reached the page too late, so it did not run. Check the page, then retry." };
	const run = (): PwExtPageResult => {
		switch (action.kind) {
			case "snapshot":
				return snapshot();
			case "click":
				return click(action.target);
			case "count":
				return count(action.target);
			case "fill":
				return fill(action.target, action.value, action.secret === true, action.until);
			case "press":
				return press(action.chord, action.key, action.modifiers);
			case "selection":
				return selection();
			case "upload":
				return upload(
					action.target,
					action.base64,
					action.fileName,
					action.fileType,
				);
			case "console":
				return consoleCapture();
		}
	};
	return sanitize(run());
}
