import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function runCommand(root: string, command: string, timeoutMs = 60_000): Promise<{ ok: boolean; output: string }> {
  const result = await execAsync(command, {
    cwd: root,
    shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

  return {
    ok: true,
    output: output || "<no output>",
  };
}
