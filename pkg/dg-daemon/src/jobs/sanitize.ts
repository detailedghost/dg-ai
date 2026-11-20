const UNSAFE_RANGES: [number, number][] = [
	[0x0000, 0x001f],
	[0x007f, 0x009f],
	[0x061c, 0x061c],
	[0x180e, 0x180e],
	[0x200b, 0x200f],
	[0x2028, 0x2029],
	[0x202a, 0x202e],
	[0x2060, 0x2064],
	[0x2066, 0x2069],
	[0xfeff, 0xfeff],
	[0xfff9, 0xfffb],
	[0xe0000, 0xe007f],
];

const hex = (code: number) => `\\u{${code.toString(16)}}`;
const UNSAFE = new RegExp(
	`[${UNSAFE_RANGES.map(([from, to]) => `${hex(from)}-${hex(to)}`).join("")}]`,
	"gu",
);

export const sanitize = (text: string): string =>
	text.replace(UNSAFE, (char) => `\\u{${(char.codePointAt(0) as number).toString(16)}}`);
