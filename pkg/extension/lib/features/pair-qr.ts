import QRCode from "qrcode";

const SVG_NS = "http://www.w3.org/2000/svg";
const QUIET_ZONE = 4;
const DISPLAY_SIZE = "148";

function setAttributes(
	node: Element,
	attributes: Record<string, string>,
): Element {
	for (const [name, value] of Object.entries(attributes)) {
		node.setAttribute(name, value);
	}
	return node;
}

export function renderPairQr({
	text,
	doc = document,
}: {
	text: string;
	doc?: Document;
}): SVGElement {
	const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
	const side = modules.size + QUIET_ZONE * 2;
	const runs: string[] = [];
	for (let row = 0; row < modules.size; row += 1) {
		let col = 0;
		while (col < modules.size) {
			if (!modules.get(row, col)) {
				col += 1;
				continue;
			}
			const start = col;
			while (col < modules.size && modules.get(row, col)) col += 1;
			const length = col - start;
			runs.push(
				`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${length}v1h-${length}z`,
			);
		}
	}
	const svg = setAttributes(doc.createElementNS(SVG_NS, "svg"), {
		viewBox: `0 0 ${side} ${side}`,
		width: DISPLAY_SIZE,
		height: DISPLAY_SIZE,
		role: "img",
		"aria-label": "Pair QR code",
		"shape-rendering": "crispEdges",
	});
	svg.append(
		setAttributes(doc.createElementNS(SVG_NS, "rect"), {
			width: String(side),
			height: String(side),
			fill: "#fff",
		}),
		setAttributes(doc.createElementNS(SVG_NS, "path"), {
			d: runs.join(""),
			fill: "#000",
		}),
	);
	return svg as SVGElement;
}
