import { createAbExtension } from "@marckrenn/pi-lab";

export default createAbExtension({
  experimentDirs: ["./experiments"],
  baseDir: import.meta.url,
});
