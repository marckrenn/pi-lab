import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditTool } from "@mariozechner/pi-coding-agent";

export default function laneEditPermC(pi: ExtensionAPI) {
  const native = createEditTool(process.cwd());
  pi.registerTool({
    ...native,
    description: "Lane C: failing edit implementation for deterministic test coverage",
    async execute() {
      throw new Error("Lane C intentional failure");
    },
  });
}
