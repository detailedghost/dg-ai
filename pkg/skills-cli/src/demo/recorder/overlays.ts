import type { TourChapter } from "@dg/common";
import type { Page } from "playwright-core";

export const THEME = {
	panel: "#111111",
	ink: "#e8e8e8",
	muted: "#8a8a8a",
	line: "#e8e8e8",
	accent: "#00f0ff",
	setupAccent: "#ff8c1a",
	sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
} as const;

export type Theme = typeof THEME;

export const OVERLAY_IDS = {
	chapter: "dg-demo-chapter",
	caption: "dg-demo-caption",
	focus: "dg-demo-focus",
	arrow: "dg-demo-arrow",
} as const;

export type Box = { x: number; y: number; width: number; height: number };

export type ArrowSide = "left" | "right" | "top" | "bottom";

const ARROW_LENGTH = 112;
const FOCUS_GAP = 6;
const CAPTION_ZONE = 180;

/** The side of the target with room for the arrow, in preference order left, right, top, bottom. */
export function arrowSide(box: Box, viewport: { width: number; height: number }): ArrowSide {
	const room = ARROW_LENGTH + FOCUS_GAP + 16;
	if (box.x >= room) return "left";
	if (viewport.width - (box.x + box.width) >= room) return "right";
	if (box.y >= room) return "top";
	return "bottom";
}

/** Whether the caption moves to the top so it does not cover the target. */
export function captionOnTop(box: Box | null, viewport: { height: number }): boolean {
	return box !== null && box.y + box.height > viewport.height - CAPTION_ZONE;
}

export async function showChapter(
	page: Page,
	chapter: TourChapter,
	theme: Theme = THEME,
): Promise<void> {
	await page.evaluate(
		({ chapter, theme, id }) => {
			document.getElementById(id)?.remove();
			const overlay = document.createElement("div");
			overlay.id = id;
			overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:${theme.panel};font-family:${theme.sans}`;
			const card = document.createElement("div");
			card.style.cssText = `width:900px;padding:52px 64px;background:${theme.panel};border:3px solid ${theme.line};border-radius:0;box-shadow:12px 12px 0 ${theme.accent};color:${theme.ink}`;
			const eyebrow = document.createElement("div");
			eyebrow.textContent = chapter.eyebrow;
			eyebrow.style.cssText = `font-size:15px;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;color:${theme.accent};margin-bottom:18px`;
			const title = document.createElement("div");
			title.textContent = chapter.title;
			title.style.cssText = "font-size:46px;line-height:1.1;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:18px";
			const detail = document.createElement("div");
			detail.textContent = chapter.detail;
			detail.style.cssText = `font-size:23px;line-height:1.45;color:${theme.ink}`;
			card.append(eyebrow, title, detail);
			overlay.append(card);
			document.documentElement.append(overlay);
		},
		{ chapter, theme, id: OVERLAY_IDS.chapter },
	);
}

export async function hideChapter(page: Page): Promise<void> {
	await page.evaluate((id) => document.getElementById(id)?.remove(), OVERLAY_IDS.chapter);
}

export type CaptionInput = {
	eyebrow: string;
	body: string;
	accent: string;
	top: boolean;
};

export async function showCaption(
	page: Page,
	caption: CaptionInput,
	theme: Theme = THEME,
): Promise<void> {
	await page.evaluate(
		({ caption, theme, id }) => {
			document.getElementById(id)?.remove();
			const bar = document.createElement("div");
			bar.id = id;
			const edge = caption.top ? "top:28px" : "bottom:28px";
			bar.style.cssText = `position:fixed;left:50%;${edge};transform:translateX(-50%);z-index:2147483646;width:min(1100px,90vw);box-sizing:border-box;padding:16px 24px;background:${theme.panel};color:${theme.ink};border:2px solid ${theme.line};border-radius:0;box-shadow:6px 6px 0 ${caption.accent};font-family:${theme.sans};pointer-events:none`;
			const eyebrow = document.createElement("div");
			eyebrow.textContent = caption.eyebrow;
			eyebrow.style.cssText = `font-size:14px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:${caption.accent};margin-bottom:6px`;
			const body = document.createElement("div");
			body.textContent = caption.body;
			body.style.cssText = "font-size:22px;line-height:1.4";
			bar.append(eyebrow, body);
			document.documentElement.append(bar);
		},
		{ caption, theme, id: OVERLAY_IDS.caption },
	);
}

export type FocusInput = { box: Box; side: ArrowSide; accent: string };

export async function showFocus(page: Page, focus: FocusInput): Promise<void> {
	await page.evaluate(
		({ focus, ids, gap, length }) => {
			for (const id of [ids.focus, ids.arrow]) document.getElementById(id)?.remove();
			const { box, side, accent } = focus;
			const ring = document.createElement("div");
			ring.id = ids.focus;
			ring.style.cssText = `position:fixed;left:${box.x - gap}px;top:${box.y - gap}px;width:${box.width + gap * 2}px;height:${box.height + gap * 2}px;box-sizing:border-box;border:3px solid ${accent};border-radius:0;box-shadow:3px 3px 0 #111111,inset 2px 2px 0 #111111;z-index:2147483645;pointer-events:none`;
			const svgNs = "http://www.w3.org/2000/svg";
			const svg = document.createElementNS(svgNs, "svg");
			svg.id = ids.arrow;
			const vertical = side === "top" || side === "bottom";
			const w = vertical ? 36 : length;
			const h = vertical ? length : 36;
			svg.setAttribute("width", String(w));
			svg.setAttribute("height", String(h));
			svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
			const cx = box.x + box.width / 2;
			const cy = box.y + box.height / 2;
			const left =
				side === "left" ? box.x - gap - 8 - w : side === "right" ? box.x + box.width + gap + 8 : cx - w / 2;
			const top =
				side === "top" ? box.y - gap - 8 - h : side === "bottom" ? box.y + box.height + gap + 8 : cy - h / 2;
			svg.style.cssText = `position:fixed;left:${left}px;top:${top}px;z-index:2147483645;pointer-events:none;overflow:visible;filter:drop-shadow(3px 3px 0 #111111)`;
			const tip = { left: [w, h / 2], right: [0, h / 2], top: [w / 2, h], bottom: [w / 2, 0] }[side];
			const tail = { left: [0, h / 2], right: [w, h / 2], top: [w / 2, 0], bottom: [w / 2, h] }[side];
			const [tx, ty] = tip as [number, number];
			const [sx, sy] = tail as [number, number];
			const ux = Math.sign(tx - sx);
			const uy = Math.sign(ty - sy);
			const head = 16;
			const line = document.createElementNS(svgNs, "line");
			line.setAttribute("x1", String(sx));
			line.setAttribute("y1", String(sy));
			line.setAttribute("x2", String(tx - ux * head));
			line.setAttribute("y2", String(ty - uy * head));
			line.setAttribute("stroke", accent);
			line.setAttribute("stroke-width", "6");
			line.setAttribute("stroke-linecap", "square");
			const arrowHead = document.createElementNS(svgNs, "polygon");
			const bx = tx - ux * head * 1.6;
			const by = ty - uy * head * 1.6;
			const px = uy * head;
			const py = ux * head;
			arrowHead.setAttribute("points", `${tx},${ty} ${bx + px},${by + py} ${bx - px},${by - py}`);
			arrowHead.setAttribute("fill", accent);
			svg.append(line, arrowHead);
			document.documentElement.append(ring, svg);
		},
		{ focus, ids: OVERLAY_IDS, gap: FOCUS_GAP, length: ARROW_LENGTH },
	);
}

export async function clearOverlays(page: Page): Promise<void> {
	await page.evaluate((ids) => {
		for (const id of Object.values(ids)) document.getElementById(id)?.remove();
	}, OVERLAY_IDS);
}
