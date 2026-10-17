import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { channelReviewPaths } from "../src/paths";

const seamsFor = (platform: "linux" | "win32") => ({
	platform,
	homeDir: platform === "win32" ? "C:\\Users\\dev" : "/home/dev",
	env: {},
});

describe("channelReviewPaths", () => {
	test("names the per-env state, pid and log files for prod", () => {
		const paths = channelReviewPaths("prod", seamsFor("linux"));
		expect(posix.basename(paths.statePath)).toBe("state.prod.json");
		expect(posix.basename(paths.pidPath)).toBe("daemon.prod.pid");
		expect(posix.basename(paths.logPath)).toBe("daemon.prod.log");
	});

	test("shares one config.json between both envs", () => {
		const dev = channelReviewPaths("dev", seamsFor("linux"));
		const prod = channelReviewPaths("prod", seamsFor("linux"));
		expect(posix.basename(dev.configPath)).toBe("config.json");
		expect(dev.configPath).toBe(prod.configPath);
	});

	test("derives every path from the channel-review dir under the dg state dir", () => {
		const seams = seamsFor("linux");
		const dir = posix.join(resolveDgPaths(seams).stateDir, "channel-review");
		expect(channelReviewPaths("dev", seams)).toMatchObject({
			configPath: posix.join(dir, "config.json"),
			statePath: posix.join(dir, "state.dev.json"),
			pidPath: posix.join(dir, "daemon.dev.pid"),
			logPath: posix.join(dir, "daemon.dev.log"),
			jobsDir: posix.join(dir, "jobs", "dev"),
			workDir: posix.join(dir, "work"),
		});
	});

	test("keeps jobs per env and work shared", () => {
		const dev = channelReviewPaths("dev", seamsFor("linux"));
		const prod = channelReviewPaths("prod", seamsFor("linux"));
		expect(dev.jobsDir).not.toBe(prod.jobsDir);
		expect(dev.workDir).toBe(prod.workDir);
	});

	test("moves every path under DG_HOME", () => {
		const paths = channelReviewPaths("dev", {
			platform: "linux",
			homeDir: "/home/dev",
			env: { DG_HOME: "/data/dg" },
		});
		expect(paths.env).toBe("dev");
		expect(paths.dbPath).toBe("/data/dg/daemon/daemon.db");
		const localPaths = Object.entries(paths).filter(
			([key]) => key !== "env" && key !== "dbPath",
		);
		for (const [, value] of localPaths) {
			expect(String(value).startsWith("/data/dg/channel-review")).toBe(true);
		}
	});

	test("joins with the win32 separator when the platform seam says win32", () => {
		const seams = seamsFor("win32");
		const dir = win32.join(resolveDgPaths(seams).stateDir, "channel-review");
		expect(channelReviewPaths("dev", seams).statePath).toBe(
			win32.join(dir, "state.dev.json"),
		);
	});
});
