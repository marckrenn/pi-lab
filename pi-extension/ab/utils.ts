import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  timedOut: boolean;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let timedOut = false;

    const kill = () => {
      if (killed) return;
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    };

    let timeout: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
    }

    const onAbort = () => kill();
    if (options.signal) {
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code: code ?? 0, killed, timedOut });
    });

    proc.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr: `${stderr}\n${String(err)}`, code: 1, killed, timedOut });
    });
  });
}

export function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function extractFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return safeJsonParse(text.slice(start, end + 1));
}

export function modelToCli(model: { provider?: string; id?: string } | undefined): string | undefined {
  if (!model?.provider || !model?.id) return undefined;
  return `${model.provider}/${model.id}`;
}
