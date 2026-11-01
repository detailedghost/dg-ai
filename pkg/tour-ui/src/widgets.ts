import { createEl as el, SANS } from "./ui-helpers";

/** A labeled input/textarea; writes back via `onInput` on every keystroke. */
export function labeled(
	labelText: string,
	value: string,
	placeholder: string,
	onInput: (v: string) => void,
	multiline = false,
): HTMLElement {
	const wrap = el("div", { marginTop: "0.625rem" });
	const label = el("label", {
		display: "block",
		fontSize: "0.6875rem",
		textTransform: "uppercase",
		letterSpacing: "0.12em",
		color: "var(--muted)",
		marginBottom: "0.25rem",
	});
	label.textContent = labelText;
	const input = multiline
		? el("textarea", { minHeight: "3rem", resize: "vertical" })
		: el("input");
	input.className = "dg-field";
	Object.assign(input.style, {
		width: "100%",
		boxSizing: "border-box",
		background: "var(--code-bg)",
		color: "var(--ink)",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.375rem 0.5rem",
		font: `0.8125rem ${SANS}`,
	});
	(input as HTMLInputElement).value = value;
	(input as HTMLInputElement).placeholder = placeholder;
	input.addEventListener("input", () =>
		onInput((input as HTMLInputElement).value),
	);
	wrap.append(label, input);
	return wrap;
}

export function pillButton(label: string, primary: boolean): HTMLButtonElement {
	const b = el("button", {
		cursor: "pointer",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.4375rem 0.75rem",
		textTransform: "uppercase",
		letterSpacing: "0.06em",
		font: `0.75rem ${SANS}`,
		background: primary ? "var(--accent)" : "transparent",
		color: primary ? "#000" : "var(--ink)",
		borderColor: primary ? "var(--accent)" : "var(--line)",
	});
	b.className = "dg-btn";
	b.type = "button";
	b.textContent = label;
	return b;
}

/** A square chevron nav button; muted + inert when `enabled` is false. */
export function arrowButton(
	glyph: string,
	enabled: boolean,
	onClick: () => void,
	ariaLabel?: string,
	/** Theme var (e.g. "var(--accent)") tinting the glyph and its border. */
	accent?: string,
): HTMLButtonElement {
	const b = el("button", {
		cursor: enabled ? "pointer" : "default",
		border: `0.125rem solid ${accent ?? "var(--line)"}`,
		borderRadius: "0",
		padding: "0.25rem 0.625rem",
		font: `0.9375rem ${SANS}`,
		background: "transparent",
		color: accent ?? "var(--ink)",
		opacity: enabled ? "1" : "0.4",
	});
	if (enabled) b.className = "dg-btn";
	b.type = "button";
	b.textContent = glyph;
	if (ariaLabel) b.setAttribute("aria-label", ariaLabel);
	if (enabled) b.addEventListener("click", onClick);
	else b.disabled = true;
	return b;
}

/** A labelled select row for the start screen, wired to persist on change. */
export function settingRow(
	labelText: string,
	options: { value: string; label: string }[],
	selected: string,
	onPick: (value: string) => void,
): HTMLElement {
	const row = el("label", {
		display: "flex",
		alignItems: "center",
		gap: "0.5rem",
		marginBottom: "0.5rem",
		color: "var(--muted)",
	});
	const text = el("span", { flex: "0 0 5rem", fontSize: "0.8125rem" });
	text.textContent = labelText;
	const sel = el("select", {
		flex: "1",
		background: "var(--code-bg)",
		color: "var(--ink)",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.1875rem 0.375rem",
		font: `0.8125rem ${SANS}`,
	}) as HTMLSelectElement;
	for (const o of options) {
		const opt = document.createElement("option");
		opt.value = o.value;
		opt.textContent = o.label;
		if (o.value === selected) opt.selected = true;
		sel.appendChild(opt);
	}
	sel.addEventListener("change", () => onPick(sel.value));
	row.append(text, sel);
	return row;
}

export type Panel = (headerText: string) => HTMLElement;

/** A draggable fixed card that remembers where the user dropped it across rebuilds. */
export function createPanel(): Panel {
	let panelPos: { left: number; top: number } | null = null;

	const makeDraggable = (card: HTMLElement, handle: HTMLElement): void => {
		handle.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const rect = card.getBoundingClientRect();
			const offX = e.clientX - rect.left;
			const offY = e.clientY - rect.top;
			const onMove = (ev: MouseEvent): void => {
				const left = Math.max(0, ev.clientX - offX);
				const top = Math.max(0, ev.clientY - offY);
				panelPos = { left, top };
				Object.assign(card.style, {
					left: `${left}px`,
					top: `${top}px`,
					right: "auto",
					transform: "none",
				});
			};
			const onUp = (): void => {
				document.removeEventListener("mousemove", onMove, true);
				document.removeEventListener("mouseup", onUp, true);
			};
			document.addEventListener("mousemove", onMove, true);
			document.addEventListener("mouseup", onUp, true);
		});
	};

	return (headerText) => {
		const card = el("div", {
			position: "fixed",
			top: "50%",
			right: "1.25rem",
			transform: "translateY(-50%)",
			width: "20rem",
			maxHeight: "90vh",
			overflowY: "auto",
			background: "var(--panel)",
			color: "var(--ink)",
			border: "0.125rem solid var(--line)",
			borderRadius: "0",
			padding: "1rem 1.125rem",
			boxShadow: "0.375rem 0.375rem 0 var(--accent)",
			font: `0.8125rem/1.5 ${SANS}`,
			pointerEvents: "auto",
			zIndex: "2147483647",
		});
		if (panelPos)
			Object.assign(card.style, {
				top: `${panelPos.top}px`,
				left: `${panelPos.left}px`,
				right: "auto",
				transform: "none",
			});
		const header = el("div", {
			display: "flex",
			alignItems: "center",
			gap: "0.5rem",
			cursor: "move",
			userSelect: "none",
			marginBottom: "0.625rem",
			paddingBottom: "0.5rem",
			borderBottom: "0.125rem solid var(--line)",
		});
		const grip = el("span", { color: "var(--muted)", letterSpacing: "0.1em" });
		grip.textContent = "⠿";
		const label = el("div", {
			fontSize: "0.6875rem",
			textTransform: "uppercase",
			letterSpacing: "0.18em",
			fontWeight: "600",
			color: "var(--accent)",
		});
		label.textContent = headerText;
		header.append(grip, label);
		card.appendChild(header);
		makeDraggable(card, header);
		return card;
	};
}
