import type { AxeReport } from "./axe";

export const VIEWPORTS = [
	{ id: "desktop", width: 1440, height: 900 },
	{ id: "tablet", width: 768, height: 1024 },
	{ id: "mobile", width: 390, height: 844 },
] as const;

export const THEMES = ["light", "dark"] as const;
export const STATES = ["default", "scrolled", "menu"] as const;
export const SIDES = ["before", "after", "target"] as const;

export type ViewportId = (typeof VIEWPORTS)[number]["id"];
export type ThemeName = (typeof THEMES)[number];
export type ShotState = (typeof STATES)[number];
export type SideName = (typeof SIDES)[number];

export interface CaptureRequest {
	url: string;
	headers: Record<string, string>;
	cookies: { name: string; value: string }[];
	width: number;
	height: number;
	theme: ThemeName;
	state: ShotState;
	menuSelector: string;
}

export interface CaptureShot {
	png: Uint8Array;
	html: string;
	finalUrl: string;
	menuFound: boolean;
	scrolled: boolean;
	engine: "http" | "playwright";
}

export interface Capturer {
	shot(request: CaptureRequest): Promise<CaptureShot>;
	close(): Promise<void>;
}

export interface ShotRecord {
	itemId: string;
	side: SideName;
	role: string;
	viewport: ViewportId;
	width: number;
	height: number;
	theme: ThemeName;
	state: ShotState;
	url: string;
	finalUrl: string;
	engine: "http" | "playwright";
	menuFound: boolean;
	scrolled: boolean;
	src: string;
	axe: AxeReport;
}

/** Add the theme and state the fixture and the live app can both honor. */
export function withCaptureQuery(raw: string, theme: ThemeName, state: ShotState): string {
	const url = new URL(raw);
	url.searchParams.set("dg-theme", theme);
	url.searchParams.set("dg-state", state);
	return url.toString();
}

export function menuIsOpen(html: string): boolean {
	return /data-verify-menu\b[^>]*aria-expanded="true"|aria-expanded="true"[^>]*data-verify-menu\b/.test(
		html,
	);
}

export function pageMarkedScrolled(html: string): boolean {
	return /data-scrolled="true"/.test(html);
}

/** Read width and height from a PNG IHDR. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
	if (
		bytes.length < 24 ||
		bytes[0] !== 0x89 ||
		bytes[1] !== 0x50 ||
		bytes[2] !== 0x4e ||
		bytes[3] !== 0x47
	)
		throw new Error("not a png");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}
