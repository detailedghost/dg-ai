const RealDate = Date;
const fixed = RealDate.parse(
	process.env.DG_TEST_NOW ?? "2026-01-15T09:30:45.000Z",
);

class FixedDate extends RealDate {
	constructor(...args: unknown[]) {
		if (args.length === 0) super(fixed);
		else super(...(args as [number]));
	}

	static override now(): number {
		return fixed;
	}
}

globalThis.Date = FixedDate as unknown as DateConstructor;
