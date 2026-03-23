import { createAbExtension } from "pi-ab-wip";

export default createAbExtension({
  experimentDirs: ["./experiments"],
  baseDir: import.meta.url,
});
