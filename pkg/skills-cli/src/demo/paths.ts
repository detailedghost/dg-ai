import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { guardedDest } from "../utils/layout-guard";

export const demosDir = (): string => join(resolveDgPaths().cacheDir, "demos");

export const demosWriteDir = (): string => guardedDest("demos", demosDir());

export const legacyDemosDir = (): string =>
	join(resolveDgPaths({ homeDir: process.env.HOME || homedir(), env: {} }).legacyHome, "demos");

export const profileDir = (): string =>
	join(resolveDgPaths().stateDir, "demo-profile");

export const planFileName = (slug: string): string => `${slug}.demo.md`;
