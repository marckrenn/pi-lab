import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditTool } from "@mariozechner/pi-coding-agent";

export default function laneEditPermA(pi: ExtensionAPI) {
  pi.registerTool({
    ...createEditTool(process.cwd()),
    description: "Lane A: baseline edit implementation (fast path)",
  });
}
