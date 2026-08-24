export type SupportedPlatform = {
	platform: string;
	arch: string;
	assetName: Record<"dg-skills" | "dg-server", string>;
};

export const SUPPORTED_PLATFORMS: SupportedPlatform[] = [
	{
		platform: "linux",
		arch: "x64",
		assetName: {
			"dg-skills": "dg-skills-linux-x64",
			"dg-server": "dg-server-linux-x64",
		},
	},
	{
		platform: "linux",
		arch: "arm64",
		assetName: {
			"dg-skills": "dg-skills-linux-arm64",
			"dg-server": "dg-server-linux-arm64",
		},
	},
	{
		platform: "darwin",
		arch: "x64",
		assetName: {
			"dg-skills": "dg-skills-macos-x64",
			"dg-server": "dg-server-macos-x64",
		},
	},
	{
		platform: "darwin",
		arch: "arm64",
		assetName: {
			"dg-skills": "dg-skills-macos-arm64",
			"dg-server": "dg-server-macos-arm64",
		},
	},
	{
		platform: "win32",
		arch: "x64",
		assetName: {
			"dg-skills": "dg-skills-windows-x64.exe",
			"dg-server": "dg-server-windows-x64.exe",
		},
	},
	{
		platform: "win32",
		arch: "arm64",
		assetName: {
			"dg-skills": "dg-skills-windows-arm64.exe",
			"dg-server": "dg-server-windows-arm64.exe",
		},
	},
];
