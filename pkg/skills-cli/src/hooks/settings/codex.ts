import { join } from "node:path";
import type { SettingsWriter } from "../types";
import { hookGroupsWriter } from "./claude";

export const codexWriter = (home: string): SettingsWriter =>
	hookGroupsWriter(join(home, ".codex"), join(home, ".codex", "hooks.json"));
