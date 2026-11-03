export type SupportedPlatform = {
	platform: string;
	arch: string;
	assetName: Record<"dg-skills" | "dg-daemon" | "dg-agent", string>;
	runtimeKey: string;
	runners: string[];
};

export const SUPPORTED_PLATFORMS: SupportedPlatform[] = [
	{
		platform: "linux",
		arch: "x64",
		runtimeKey: "linux-x64",
		runners: ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"],
		assetName: {
			"dg-skills": "dg-skills-linux-x64",
			"dg-daemon": "dg-daemon-linux-x64",
			"dg-agent": "dg-agent-linux-x64",
		},
	},
	{
		platform: "linux",
		arch: "arm64",
		runtimeKey: "linux-arm64",
		runners: ["ubuntu-24.04-arm", "ubuntu-22.04-arm", "ubuntu-latest-arm"],
		assetName: {
			"dg-skills": "dg-skills-linux-arm64",
			"dg-daemon": "dg-daemon-linux-arm64",
			"dg-agent": "dg-agent-linux-arm64",
		},
	},
	{
		platform: "darwin",
		arch: "x64",
		runtimeKey: "darwin-x64",
		runners: ["macos-15-intel"],
		assetName: {
			"dg-skills": "dg-skills-macos-x64",
			"dg-daemon": "dg-daemon-macos-x64",
			"dg-agent": "dg-agent-macos-x64",
		},
	},
	{
		platform: "darwin",
		arch: "arm64",
		runtimeKey: "darwin-arm64",
		runners: ["macos-14", "macos-15", "macos-latest"],
		assetName: {
			"dg-skills": "dg-skills-macos-arm64",
			"dg-daemon": "dg-daemon-macos-arm64",
			"dg-agent": "dg-agent-macos-arm64",
		},
	},
	{
		platform: "win32",
		arch: "x64",
		runtimeKey: "windows-x64",
		runners: ["windows-latest", "windows-2022", "windows-2025"],
		assetName: {
			"dg-skills": "dg-skills-windows-x64.exe",
			"dg-daemon": "dg-daemon-windows-x64.exe",
			"dg-agent": "dg-agent-windows-x64.exe",
		},
	},
	{
		platform: "win32",
		arch: "arm64",
		runtimeKey: "windows-arm64",
		runners: ["windows-11-arm"],
		assetName: {
			"dg-skills": "dg-skills-windows-arm64.exe",
			"dg-daemon": "dg-daemon-windows-arm64.exe",
			"dg-agent": "dg-agent-windows-arm64.exe",
		},
	},
];
