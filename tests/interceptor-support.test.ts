import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { createEditTool } from "@mariozechner/pi-coding-agent";
import { resolveFixedArgsInterceptorSupport } from "../pi-extension/lab/index.ts";

describe("resolveFixedArgsInterceptorSupport", () => {
  const tmpRoots: string[] = [];

  const createTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-interceptor-test-"));
    tmpRoots.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const dir = tmpRoots.pop();
      if (!dir) continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses existing custom tool schema and delegate when available", async () => {
    const cwd = createTempDir();
    const existing = {
      description: "custom tool",
      parameters: { type: "object", required: ["path", "value"] },
      async execute() {
        return { content: [{ type: "text", text: "custom-ok" }] };
      },
    };

    const support = resolveFixedArgsInterceptorSupport("custom-tool", cwd, existing);

    expect(support.error).toBeUndefined();
    expect(support.parameters).toEqual(existing.parameters);
    expect(support.nativeTool).toBeDefined();
    const result = await support.nativeTool!.execute("call-1", { path: "x", value: "y" });
    expect(result.content[0].text).toBe("custom-ok");
  });

  test("uses built-in delegate for built-in tools", async () => {
    const cwd = createTempDir();
    const file = join(cwd, "sample.txt");
    writeFileSync(file, "hello\n", "utf8");

    const expected = createEditTool(cwd);
    const support = resolveFixedArgsInterceptorSupport("edit", cwd);

    expect(support.error).toBeUndefined();
    expect(support.parameters).toEqual(expected.parameters);
    const result = await support.nativeTool!.execute("call-1", {
      path: "sample.txt",
      oldText: "hello",
      newText: "world",
    });
    expect(result.content[0].text).toContain("Successfully replaced text in sample.txt");
  });

  test("keeps custom tool schema even when execute delegate is not available via ToolInfo", () => {
    const cwd = createTempDir();
    const support = resolveFixedArgsInterceptorSupport("custom-tool", cwd, {
      description: "custom tool",
      parameters: { type: "object", required: ["path"] },
    });

    expect(support.error).toBeUndefined();
    expect(support.parameters).toEqual({ type: "object", required: ["path"] });
    expect(support.nativeTool).toBeUndefined();
    expect(support.warning).toContain("without a native delegate");
  });

  test("uses configured experiment schema when the custom tool is not registered in the main session", () => {
    const cwd = createTempDir();
    const support = resolveFixedArgsInterceptorSupport("custom-tool", cwd, undefined, {
      description: "configured custom tool",
      parameters: { type: "object", required: ["path", "oldText", "newText"] },
    });

    expect(support.error).toBeUndefined();
    expect(support.parameters).toEqual({ type: "object", required: ["path", "oldText", "newText"] });
    expect(support.nativeTool).toBeUndefined();
    expect(support.warning).toContain("without a native delegate");
  });

  test("fails fast for custom tools without existing schema/delegate", () => {
    const cwd = createTempDir();
    const support = resolveFixedArgsInterceptorSupport("custom-tool", cwd);

    expect(support.nativeTool).toBeUndefined();
    expect(support.parameters).toBeUndefined();
    expect(support.error).toContain("no parameter schema is available");
  });
});
