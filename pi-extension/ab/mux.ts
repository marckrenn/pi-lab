import { execSync } from "node:child_process";

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function hasCommand(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isCmuxAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function runCmux(command: string): string {
  return execSync(`cmux ${command}`, { encoding: "utf8" }).trim();
}

export function createCmuxSurface(name: string, direction: "right" | "down", fromSurface?: string): string {
  const surfaceArg = fromSurface ? ` --surface ${shellEscape(fromSurface)}` : "";
  const out = runCmux(`new-split ${direction}${surfaceArg}`);
  const match = out.match(/surface:\d+/);
  if (!match) {
    throw new Error(`Unexpected cmux new-split output: ${out}`);
  }

  const surface = match[0];
  runCmux(`rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`);
  runCmux(`focus-panel --panel ${shellEscape(surface)}`);
  return surface;
}

export function sendCmuxCommand(surface: string, command: string): void {
  runCmux(`send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`);
}

export function readCmuxScreen(surface: string, lines = 80): string {
  return runCmux(`read-screen --surface ${shellEscape(surface)} --lines ${lines}`);
}

export function closeCmuxSurface(surface: string): void {
  runCmux(`close-surface --surface ${shellEscape(surface)}`);
}

function listCmuxSurfaces(): Array<{ surface: string; title: string }> {
  const out = runCmux("list-pane-surfaces");
  const surfaces: Array<{ surface: string; title: string }> = [];

  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    const idMatch = line.match(/surface:\d+/);
    if (!idMatch) continue;

    const surface = idMatch[0];
    const after = line.slice(line.indexOf(surface) + surface.length).trim();
    const title = after.replace(/\s+\[[^\]]+\]\s*$/, "").trim();
    surfaces.push({ surface, title });
  }

  return surfaces;
}

export function findCmuxSurfaceByTitle(title: string): string | undefined {
  return listCmuxSurfaces().find((s) => s.title === title)?.surface;
}

export function findCmuxSurfacesByTitlePrefix(prefix: string): string[] {
  return listCmuxSurfaces()
    .filter((s) => s.title.startsWith(prefix))
    .map((s) => s.surface);
}

export function closeCmuxSurfacesByTitlePrefix(prefix: string, maxPasses = 32): void {
  for (let pass = 0; pass < maxPasses; pass++) {
    const surfaces = findCmuxSurfacesByTitlePrefix(prefix);
    if (surfaces.length === 0) return;

    let closed = false;
    for (const surface of surfaces) {
      try {
        closeCmuxSurface(surface);
        closed = true;
        break;
      } catch {
        // surface id may have shifted after other closes; retry next pass.
      }
    }

    if (!closed) return;
  }
}

export async function waitForCmuxSentinel(
  surface: string,
  sentinelPrefix: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; screen: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) {
      throw new Error("Aborted while waiting for cmux process.");
    }

    const screen = readCmuxScreen(surface, 300);
    const re = new RegExp(`${sentinelPrefix}(\\d+)__`);
    const m = screen.match(re);
    if (m) {
      return { exitCode: parseInt(m[1], 10), screen };
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  return { exitCode: 124, screen: readCmuxScreen(surface, 300) };
}
