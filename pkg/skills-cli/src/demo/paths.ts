import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";

export const demosDir = (): string => join(resolveDgPaths().stateDir, "demos");

export const legacyDemosDir = (): string =>
	join(process.env.HOME || homedir(), ".dg", "demos");

export const profileDir = (): string =>
	join(resolveDgPaths().stateDir, "demo-profile");

export const planFileName = (slug: string): string => `${slug}.demo.md`;
