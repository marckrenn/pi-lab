import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditTool } from "@mariozechner/pi-coding-agent";

export default function baselineLane(pi: ExtensionAPI) {
  const nativeEdit = createEditTool(process.cwd());

  pi.registerTool({
    ...nativeEdit,
    description: "Baseline edit lane used by the packaged edit-fast sample experiment.",
  });
}
