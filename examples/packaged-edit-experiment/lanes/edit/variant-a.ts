import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditTool } from "@mariozechner/pi-coding-agent";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function variantLane(pi: ExtensionAPI) {
  const nativeEdit = createEditTool(process.cwd());

  pi.registerTool({
    ...nativeEdit,
    description: "Variant A lane with a tiny intentional delay for latency-based comparison.",
    async execute(toolCallId, params, signal, onUpdate) {
      await wait(180);
      return nativeEdit.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
