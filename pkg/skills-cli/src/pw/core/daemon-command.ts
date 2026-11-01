import { selfCommand } from "@dg/common/node";

export const daemonCommand = (): string[] => selfCommand(["pw", "__daemon"]);
