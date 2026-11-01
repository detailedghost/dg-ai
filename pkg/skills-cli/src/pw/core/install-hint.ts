const MISSING = /Executable doesn't exist at (.+)/;
const PRODUCT =
	/[\\/](chromium_headless_shell|chromium|firefox|webkit|ffmpeg)-\d+[\\/]/;

export function installHint(message: string): string | undefined {
	const missing = MISSING.exec(message);
	if (!missing) return undefined;
	const raw = PRODUCT.exec(missing[1] ?? "")?.[1];
	const product = raw === "chromium_headless_shell" ? "chromium" : raw;
	if (!product)
		return "A Playwright-managed binary is missing. run: bunx playwright-core install";
	return `Playwright ${product} is not installed. run: bunx playwright-core install ${product}`;
}
