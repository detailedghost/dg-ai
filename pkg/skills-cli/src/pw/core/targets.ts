import type { Locator, Page } from "playwright-core";
import { assertSafeGetBy } from "./get-by";

const REF = /^(?:f\d+)?e\d+$/;
const GET_BY = /^getBy\w+\(/;

export class RefNotFoundError extends Error {
	constructor(ref: string) {
		super(`Ref not found: ${ref}. Take a new snapshot.`);
	}
}

export const isRef = (target: string): boolean => REF.test(target);

export const toSelector = (target: string): string =>
	isRef(target) ? `aria-ref=${target}` : target;

function isLocator(value: unknown): value is Locator {
	return typeof (value as Locator | undefined)?.count === "function";
}

export async function resolveTarget(
	page: Page,
	target: string,
): Promise<Locator> {
	if (GET_BY.test(target)) {
		assertSafeGetBy(target);
		const located: unknown = new Function("page", `return page.${target}`)(
			page,
		);
		if (!isLocator(located))
			throw new Error(`Target must evaluate to a locator: ${target}`);
		return located;
	}
	const locator = page.locator(toSelector(target));
	if (isRef(target) && (await locator.count()) === 0)
		throw new RefNotFoundError(target);
	return locator;
}

export const locatorCode = (locator: Locator): string =>
	`page.${String(locator)}`;
