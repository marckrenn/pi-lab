import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditTool } from "@mariozechner/pi-coding-agent";

export default function laneEditPermB(pi: ExtensionAPI) {
  const native = createEditTool(process.cwd());
  pi.registerTool({
    ...native,
    description: "Lane B: slower edit implementation (artificial delay)",
    async execute(toolCallId, params, signal, onUpdate) {
      await new Promise((r) => setTimeout(r, 300));
      return native.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
