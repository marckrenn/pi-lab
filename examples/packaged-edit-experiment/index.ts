import { createAbExtension } from "@marckrenn/pi-ab";

export default createAbExtension({
  experimentDirs: ["./experiments"],
  baseDir: import.meta.url,
});
