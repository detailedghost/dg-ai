import { describe, expect, test } from "bun:test";

import { gradeOf } from "../src/adr/readability";

interface Sample {
	name: string;
	text: string;
	words: number;
	sentences: number;
	syllables: number;
}

const SAMPLES: Sample[] = [
	{
		name: "two plain sentences",
		text: "The city built a new library near the river. Many children visit it on weekends.",
		words: 15,
		sentences: 2,
		syllables: 23,
	},
	{
		name: "one long sentence",
		text: "Modern software teams often prefer automated testing because slow inspection delays important decisions.",
		words: 13,
		sentences: 1,
		syllables: 29,
	},
	{
		name: "three short sentences",
		text: "We chose a small database. It stores all records on disk. Backups run each night.",
		words: 15,
		sentences: 3,
		syllables: 19,
	},
];

function expectedGrade(sample: Sample): number {
	return 0.39 * (sample.words / sample.sentences) + 11.8 * (sample.syllables / sample.words) - 15.59;
}

const BASE = "We chose a small database. It stores all records on disk. Backups run each night.";

describe("adr readability gradeOf", () => {
	for (const sample of SAMPLES) {
		test(`grades ${sample.name} within 0.5 of the hand-counted Flesch-Kincaid value`, () => {
			expect(Math.abs(gradeOf(sample.text) - expectedGrade(sample))).toBeLessThan(0.5);
		});
	}

	test("grades a harder paragraph above an easier one", () => {
		expect(gradeOf(SAMPLES[1]?.text ?? "")).toBeGreaterThan(gradeOf(SAMPLES[2]?.text ?? ""));
	});

	test("returns 0 for empty text", () => {
		expect(gradeOf("")).toBe(0);
	});

	test("returns 0 when nothing but non-prose remains", () => {
		const nonProse = [
			"# Title",
			"",
			"Status: Accepted",
			"Date: 2026-01-01",
			"Topic: messaging",
			"Level: college",
			"",
			"```ts",
			"const value = compute(1, 2);",
			"```",
			"",
			"```mermaid",
			"graph TD",
			"  A --> B",
			"```",
			"",
			"| a | b |",
			"| --- | --- |",
			"| x | y |",
		].join("\n");
		expect(gradeOf(nonProse)).toBe(0);
	});

	test("ignores a fenced code block", () => {
		const withFence = `${BASE}\n\n\`\`\`ts\nconst veryComplicatedIdentifier = internationalization(configuration);\n\`\`\`\n`;
		expect(gradeOf(withFence)).toBeCloseTo(gradeOf(BASE), 5);
	});

	test("ignores a Mermaid block", () => {
		const withDiagram = `${BASE}\n\n\`\`\`mermaid\ngraph TD\n  Authentication[Authentication service] --> Infrastructure[Infrastructure]\n\`\`\`\n`;
		expect(gradeOf(withDiagram)).toBeCloseTo(gradeOf(BASE), 5);
	});

	test("ignores a table", () => {
		const withTable = `${BASE}\n\n| Characteristic | Interoperability |\n| --- | --- |\n| comprehensive | organizational |\n`;
		expect(gradeOf(withTable)).toBeCloseTo(gradeOf(BASE), 5);
	});

	test("ignores inline code", () => {
		const withInline = "We chose a small database. It stores all records on disk `bun run internationalization`. Backups run each night.";
		expect(gradeOf(withInline)).toBeCloseTo(gradeOf(BASE), 5);
	});

	test("keeps link text and ignores the link target", () => {
		const plain = "We chose a small database. The guide is short.";
		const linked = "We chose a small database. [The guide](https://example.com/internationalization/comprehensive.html) is short.";
		expect(gradeOf(linked)).toBeCloseTo(gradeOf(plain), 5);
	});

	test("ignores file paths", () => {
		const withPath = "We chose a small database. It stores all records on disk docs/adr/0001-internationalization.md. Backups run each night.";
		expect(gradeOf(withPath)).toBeCloseTo(gradeOf(BASE), 5);
	});

	test("treats and/or as prose but a slash path as a path", () => {
		const slashed = "We chose a small database. It stores all records on disk and/or tape. Backups run each night.";
		const plain = "We chose a small database. It stores all records on disk and or tape. Backups run each night.";
		expect(gradeOf(slashed)).toBeCloseTo(gradeOf(plain), 5);
		const rooted = "We chose a small database. It stores all records on disk /var/internationalization. Backups run each night.";
		expect(gradeOf(rooted)).toBeCloseTo(gradeOf(BASE), 5);
	});

	test("ignores heading and Status, Date, Topic and Level header lines", () => {
		const withHeader = `# Internationalization architecture\n\nStatus: Accepted\nDate: 2026-01-01\nTopic: infrastructure\nLevel: college\n\n## Context\n\n${BASE}\n`;
		expect(gradeOf(withHeader)).toBeCloseTo(gradeOf(BASE), 5);
	});

	test("grades a bullet-only list per item, not as one giant sentence", () => {
		const bullets = "- We chose a small database\n- It stores all records on disk\n- Backups run each night";
		expect(Math.abs(gradeOf(bullets) - expectedGrade(SAMPLES[2] as Sample))).toBeLessThan(0.5);
	});
});
