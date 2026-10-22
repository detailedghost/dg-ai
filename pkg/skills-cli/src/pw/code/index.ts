import type { CommandEntry } from "../commands/index";
import spec from "./spec";

export const CODE_COMMAND: CommandEntry = { spec, load: () => import("./run") };
