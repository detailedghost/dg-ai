const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
	plus: "M12 5v14M5 12h14",
	canvas: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
	vim: "M4 17l5-5-5-5M12 19h8",
	sun: "M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
	moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	settings:
		"M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M13 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
} as const;

export type IconName = keyof typeof ICONS;

export function createIcon(doc: Document, name: IconName): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "chat-icon");
	const path = doc.createElementNS(SVG_NS, "path");
	path.setAttribute("d", ICONS[name]);
	svg.append(path);
	return svg;
}
