const MISSING = /Executable doesn't exist at (.+)/;
const PRODUCT =
	/[\\/](chromium_headless_shell|chromium|firefox|webkit|ffmpeg)-\d+[\\/]/;

const OWN_BUILD: Record<string, string> = {
	firefox: "Firefox",
	webkit: "WebKit",
};

export function installHint(message: string): string | undefined {
	const missing = MISSING.exec(message);
	if (!missing) return undefined;
	const raw = PRODUCT.exec(missing[1] ?? "")?.[1];
	const product = raw === "chromium_headless_shell" ? "chromium" : raw;
	if (!product)
		return "A Playwright-managed binary is missing. run: bunx playwright-core install";
	const own = OWN_BUILD[product];
	const note = own
		? `A system ${own} cannot stand in: playwright-core drives only its own ${own} build. `
		: "";
	return `Playwright ${product} is not installed at ${missing[1]}. ${note}run: bunx playwright-core install ${product}`;
}
