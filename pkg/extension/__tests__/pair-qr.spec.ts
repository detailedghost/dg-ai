import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import { Window } from "happy-dom";
import { renderPairQr } from "@/lib/features/pair-qr";

const QUIET_ZONE = 4;

const windows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

function withDocument<T>(run: () => T): T {
	const window = new Window();
	windows.add(window);
	const original = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: window.document,
	});
	try {
		return run();
	} finally {
		if (original) Object.defineProperty(globalThis, "document", original);
		else Reflect.deleteProperty(globalThis, "document");
	}
}

function render(text: string): SVGElement {
	return withDocument(() => renderPairQr({ text }));
}

function expectedModules(text: string): { size: number; dark: Set<string> } {
	const modules = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
	const dark = new Set<string>();
	for (let row = 0; row < modules.size; row += 1) {
		for (let col = 0; col < modules.size; col += 1) {
			if (modules.get(row, col)) dark.add(`${col},${row}`);
		}
	}
	return { size: modules.size, dark };
}

function filledCells(pathData: string): Set<string> {
	const cells = new Set<string>();
	const tokens = pathData.match(/[MmHhVvZzLl]|-?\d+(?:\.\d+)?/g) ?? [];
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	let xs: number[] = [];
	let ys: number[] = [];
	const flush = () => {
		if (xs.length === 0) return;
		const x0 = Math.min(...xs);
		const x1 = Math.max(...xs);
		const y0 = Math.min(...ys);
		const y1 = Math.max(...ys);
		for (let cx = x0; cx < x1; cx += 1) {
			for (let cy = y0; cy < y1; cy += 1) cells.add(`${cx},${cy}`);
		}
		xs = [];
		ys = [];
	};
	let command = "";
	let index = 0;
	const next = () => Number(tokens[index++]);
	const mark = () => {
		xs.push(x);
		ys.push(y);
	};
	while (index < tokens.length) {
		const token = tokens[index];
		if (/[A-Za-z]/.test(token as string)) {
			command = token as string;
			index += 1;
			if (command === "z" || command === "Z") {
				mark();
				flush();
				x = startX;
				y = startY;
			}
			continue;
		}
		if (command === "M" || command === "m") {
			flush();
			const dx = next();
			const dy = next();
			x = command === "M" ? dx : x + dx;
			y = command === "M" ? dy : y + dy;
			startX = x;
			startY = y;
			mark();
			command = command === "M" ? "L" : "l";
		} else if (command === "h" || command === "H") {
			x = command === "h" ? x + next() : next();
			mark();
		} else if (command === "v" || command === "V") {
			y = command === "v" ? y + next() : next();
			mark();
		} else {
			throw new Error(`unsupported path command ${command}`);
		}
	}
	flush();
	return cells;
}

describe("renderPairQr", () => {
	test.each(["dg-agent pair 123456", "dg-agent pair 012345"])(
		"draws exactly the dark modules of the error-correction M code for %s",
		(text) => {
			const svg = render(text);
			const expected = expectedModules(text);
			const paths = svg.querySelectorAll("path");
			expect(paths).toHaveLength(1);

			const cells = filledCells(paths[0]?.getAttribute("d") ?? "");
			const shifted = new Set(
				[...expected.dark].map((key) => {
					const [col, row] = key.split(",").map(Number);
					return `${(col as number) + QUIET_ZONE},${(row as number) + QUIET_ZONE}`;
				}),
			);

			expect(cells).toEqual(shifted);
		},
	);

	test("leading-zero and non-zero codes produce different symbols", () => {
		const first = render("dg-agent pair 123456").querySelector("path")?.getAttribute("d");
		const second = render("dg-agent pair 012345").querySelector("path")?.getAttribute("d");

		expect(first).not.toBe(second);
	});

	test("sizes the viewBox to the symbol plus a four module quiet zone on every side", () => {
		const text = "dg-agent pair 123456";
		const svg = render(text);
		const side = expectedModules(text).size + QUIET_ZONE * 2;

		expect(svg.getAttribute("viewBox")).toBe(`0 0 ${side} ${side}`);
	});

	test("paints black modules over an explicit white rect covering the whole viewBox", () => {
		const text = "dg-agent pair 123456";
		const svg = render(text);
		const side = expectedModules(text).size + QUIET_ZONE * 2;
		const background = svg.querySelector("rect");

		expect(background?.getAttribute("fill")?.toLowerCase()).toBe("#fff");
		expect(Number(background?.getAttribute("width"))).toBe(side);
		expect(Number(background?.getAttribute("height"))).toBe(side);
		expect(svg.querySelector("path")?.getAttribute("fill")?.toLowerCase()).toBe(
			"#000",
		);
	});

	test("carries the accessible name, image role and crisp edges", () => {
		const svg = render("dg-agent pair 123456");

		expect(svg.getAttribute("role")).toBe("img");
		expect(svg.getAttribute("aria-label")).toBe("Pair QR code");
		expect(svg.outerHTML).toContain("crispEdges");
		expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
	});

	test("uses no theme-dependent color in the drawing", () => {
		const markup = render("dg-agent pair 123456").outerHTML;

		expect(markup).not.toContain("currentColor");
		expect(markup).not.toContain("var(");
	});

	test("the module builds the drawing without innerHTML", () => {
		const source = readFileSync(
			new URL("../lib/features/pair-qr.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("innerHTML");
	});
});
