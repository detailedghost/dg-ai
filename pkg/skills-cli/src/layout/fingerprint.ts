import type { ThemeName, ViewportId } from "../verify/capture-model";

export const PROTOTYPE_CHROME_SELECTOR =
	'[aria-label="Prototype decision"], #protobar, #proto-toast, #prototype-switcher, #proto-decision-bar, #proto-decision-toast, #_proto_changes_pill';

export const DEFAULT_ROOT_SELECTOR = "[data-verify-root]";

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ControlRow {
	i: number;
	role: string;
	name: string;
	testid: string | null;
	path: string;
	box: Box;
	band: "top" | "middle" | "bottom";
	hband: "left" | "center" | "right";
	visible: boolean;
	occluded: boolean;
	occluder: string | null;
}

export type ThemeApplied = ThemeName | "unknown";

export interface LayoutFound {
	root: Box;
	controls: ControlRow[];
	themeApplied: ThemeApplied;
}

export interface LayoutError {
	error: string;
}

export type LayoutResult = LayoutFound | LayoutError;

export interface Reading {
	viewport: ViewportId;
	width: number;
	height: number;
	theme: ThemeName;
	themeApplied: ThemeApplied;
	root: Box | null;
	controls: ControlRow[];
}

export interface Fingerprint {
	version: 1;
	root: string;
	readings: Reading[];
}

export function isLayoutError(result: LayoutResult): result is LayoutError {
	return "error" in result;
}

/** Key each control by test id, else role and normalized name, numbering repeats in DOM order. */
export function identityKeys(
	controls: readonly Pick<ControlRow, "role" | "name" | "testid">[],
): string[] {
	const seen = new Map<string, number>();
	return controls.map((control) => {
		const base =
			control.testid ??
			`${control.role}|${control.name
				.toLowerCase()
				.replace(/\s+/g, " ")
				.replace(/(\.\.\.|…)$/, "")
				.trim()}`;
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return count === 1 ? base : `${base}#${count}`;
	});
}

/** Runs in the page, so it stays self-contained; it hides prototype chrome before reading. */
export function collectLayout(selectors: {
	root: string;
	chrome: string;
}): LayoutResult {
	const CONTROLS =
		'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=textbox], [role=combobox], [role=searchbox], [role=option], [role=slider], [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
	const squash = (text: string | null | undefined): string =>
		(text ?? "").replace(/\s+/g, " ").trim();
	const shown = (el: Element): boolean =>
		el.closest("[hidden]") === null &&
		el.checkVisibility({ checkOpacity: true, visibilityProperty: true });

	for (const el of Array.from(document.querySelectorAll(selectors.chrome)))
		(el as HTMLElement).style.setProperty("display", "none", "important");

	const roots = Array.from(document.querySelectorAll(selectors.root)).filter(
		shown,
	);
	if (roots.length !== 1)
		return {
			error: `root: found ${roots.length} visible ${selectors.root}`,
		};
	const root = roots[0] as Element;

	const scrollX = window.scrollX;
	const scrollY = window.scrollY;
	const rootRect = root.getBoundingClientRect();
	const rootBox = {
		x: Math.round(rootRect.left + scrollX),
		y: Math.round(rootRect.top + scrollY),
		w: Math.round(rootRect.width),
		h: Math.round(rootRect.height),
	};

	const implicitRole = (el: Element): string => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		const type = (el.getAttribute("type") ?? "text").toLowerCase();
		if (tag === "a") return "link";
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "select") return "combobox";
		if (tag === "textarea") return "textbox";
		if (tag === "input") {
			if (type === "submit" || type === "button" || type === "reset")
				return "button";
			if (type === "checkbox" || type === "radio") return type;
			if (type === "range") return "slider";
			if (type === "search") return "searchbox";
			return "textbox";
		}
		const editable = el.getAttribute("contenteditable");
		if (editable === "" || editable === "true") return "textbox";
		return "generic";
	};

	const nameOf = (el: Element): string => {
		const label = squash(el.getAttribute("aria-label"));
		if (label) return label;
		const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
			.split(/\s+/)
			.map((id) => squash(document.getElementById(id)?.textContent))
			.filter(Boolean)
			.join(" ");
		if (labelledBy) return labelledBy;
		const wrapper = el.id
			? document.querySelector(`label[for="${el.id}"]`)
			: null;
		const labelEl = wrapper ?? el.closest("label");
		if (labelEl) {
			const copy = labelEl.cloneNode(true) as Element;
			for (const nested of Array.from(copy.querySelectorAll("select")))
				nested.remove();
			const associated = squash(copy.textContent);
			if (associated) return associated;
		}
		const placeholder = squash(el.getAttribute("placeholder"));
		if (placeholder) return placeholder;
		const isSelect = el.tagName.toLowerCase() === "select";
		const text = isSelect ? "" : squash(el.textContent);
		if (text) return text;
		const title = squash(el.getAttribute("title"));
		if (title) return title;
		if (isSelect) return squash(el.getAttribute("name") || el.id);
		const alt = squash(el.querySelector("img[alt]")?.getAttribute("alt"));
		if (alt) return alt;
		return squash(el.getAttribute("value"));
	};

	const brief = (el: Element, limit: number): string => {
		const tag = el.tagName.toLowerCase();
		const first = (el.getAttribute("class") ?? "").split(/\s+/).find(Boolean);
		const text = el.id ? `${tag}#${el.id}` : first ? `${tag}.${first}` : tag;
		return text.slice(0, limit);
	};

	const pathOf = (el: Element): string => {
		if (el.id || el.getAttribute("class")?.trim()) return brief(el, 120);
		const parts: string[] = [];
		for (
			let node: Element | null = el;
			node && node !== root;
			node = node.parentElement
		) {
			const siblings: Element[] = node.parentElement
				? Array.from(node.parentElement.children)
				: [];
			parts.unshift(
				`${node.tagName.toLowerCase()}:nth-child(${siblings.indexOf(node) + 1})`,
			);
		}
		return parts.join(" > ").slice(0, 120);
	};

	const relative = (rect: DOMRect): Box => ({
		x: Math.round(rect.left + scrollX - rootBox.x),
		y: Math.round(rect.top + scrollY - rootBox.y),
		w: Math.round(rect.width),
		h: Math.round(rect.height),
	});

	const third = (center: number, size: number): 0 | 1 | 2 => {
		if (size <= 0) return 1;
		const fraction = center / size;
		return fraction < 1 / 3 ? 0 : fraction >= 2 / 3 ? 2 : 1;
	};

	const elements = Array.from(root.querySelectorAll(CONTROLS)).filter(
		(el) => el.closest(selectors.chrome) === null,
	);
	const controls: ControlRow[] = elements.map((el, i) => {
		const box = relative(el.getBoundingClientRect());
		const vertical = third(box.y + box.h / 2, rootBox.h);
		const horizontal = third(box.x + box.w / 2, rootBox.w);
		return {
			i,
			role: implicitRole(el),
			name: nameOf(el).slice(0, 80),
			testid: el.getAttribute("data-testid"),
			path: pathOf(el),
			box,
			band: (["top", "middle", "bottom"] as const)[vertical],
			hband: (["left", "center", "right"] as const)[horizontal],
			visible: shown(el),
			occluded: false,
			occluder: null,
		};
	});

	const scrollSnapshot = (el: Element): (() => void) => {
		const saved: [Element, number, number][] = [];
		for (let node = el.parentElement; node; node = node.parentElement)
			if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
				saved.push([node, node.scrollTop, node.scrollLeft]);
		return () => {
			for (const [node, top, left] of saved)
				node.scrollTo({ top, left, behavior: "instant" });
		};
	};

	const occluderOf = (el: Element, rect: DOMRect): Element | null => {
		const inset = Math.min(2, rect.width / 2, rect.height / 2);
		const points: [number, number][] = [
			[rect.left + rect.width / 2, rect.top + rect.height / 2],
			[rect.left + inset, rect.top + inset],
			[rect.right - inset, rect.top + inset],
			[rect.left + inset, rect.bottom - inset],
			[rect.right - inset, rect.bottom - inset],
		];
		const centerMustHit = getComputedStyle(el).pointerEvents !== "none";
		for (const [index, [x, y]] of points.entries()) {
			const hit = document.elementFromPoint(x, y);
			if (!hit || hit === el || el.contains(hit)) continue;
			if (!hit.contains(el) || (index === 0 && centerMustHit)) return hit;
		}
		return null;
	};

	elements.forEach((el, index) => {
		const row = controls[index] as ControlRow;
		if (!row.visible) return;
		let rect = el.getBoundingClientRect();
		if (rect.width * rect.height === 0) return;
		const outside =
			rect.top < 0 ||
			rect.left < 0 ||
			rect.bottom > window.innerHeight ||
			rect.right > window.innerWidth;
		const restore = outside ? scrollSnapshot(el) : null;
		if (outside) {
			el.scrollIntoView({
				block: "nearest",
				inline: "nearest",
				behavior: "instant",
			});
			rect = el.getBoundingClientRect();
		}
		const hit = occluderOf(el, rect);
		restore?.();
		if (hit) {
			row.occluded = true;
			row.occluder = brief(hit, 60);
		}
	});
	window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });

	const html = document.documentElement;
	const attribute = html.getAttribute("data-theme");
	const themeApplied: ThemeApplied =
		attribute === "light" || attribute === "dark"
			? attribute
			: html.classList.contains("dark")
				? "dark"
				: html.classList.contains("light")
					? "light"
					: window.matchMedia("(prefers-color-scheme: dark)").matches
						? "dark"
						: window.matchMedia("(prefers-color-scheme: light)").matches
							? "light"
							: "unknown";

	return { root: rootBox, controls, themeApplied };
}
