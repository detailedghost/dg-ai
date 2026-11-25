export function buildVersion(): string {
	return process.env.DG_BUILD_VERSION || "dev";
}
