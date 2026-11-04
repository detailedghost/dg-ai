import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";

export const demosDir = (): string => join(resolveDgPaths().cacheDir, "demos");

export const legacyDemosDir = (): string =>
	join(resolveDgPaths({ homeDir: process.env.HOME || homedir(), env: {} }).legacyHome, "demos");

export const profileDir = (): string =>
	join(resolveDgPaths().stateDir, "demo-profile");

export const planFileName = (slug: string): string => `${slug}.demo.md`;
