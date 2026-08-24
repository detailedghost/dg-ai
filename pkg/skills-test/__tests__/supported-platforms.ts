export type SupportedPlatform = {
	platform: string;
	arch: string;
	assetName: Record<"dg-skills" | "dg-daemon", string>;
};

export const SUPPORTED_PLATFORMS: SupportedPlatform[] = [
	{
		platform: "linux",
		arch: "x64",
		assetName: {
			"dg-skills": "dg-skills-linux-x64",
			"dg-daemon": "dg-daemon-linux-x64",
		},
	},
	{
		platform: "linux",
		arch: "arm64",
		assetName: {
			"dg-skills": "dg-skills-linux-arm64",
			"dg-daemon": "dg-daemon-linux-arm64",
		},
	},
	{
		platform: "darwin",
		arch: "x64",
		assetName: {
			"dg-skills": "dg-skills-macos-x64",
			"dg-daemon": "dg-daemon-macos-x64",
		},
	},
	{
		platform: "darwin",
		arch: "arm64",
		assetName: {
			"dg-skills": "dg-skills-macos-arm64",
			"dg-daemon": "dg-daemon-macos-arm64",
		},
	},
	{
		platform: "win32",
		arch: "x64",
		assetName: {
			"dg-skills": "dg-skills-windows-x64.exe",
			"dg-daemon": "dg-daemon-windows-x64.exe",
		},
	},
	{
		platform: "win32",
		arch: "arm64",
		assetName: {
			"dg-skills": "dg-skills-windows-arm64.exe",
			"dg-daemon": "dg-daemon-windows-arm64.exe",
		},
	},
];
