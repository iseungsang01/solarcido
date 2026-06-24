import { exec } from "node:child_process";
import { promisify } from "node:util";

import { clampText, MAX_COMMAND_STREAM_CHARS } from "./output-limits.js";

const execAsync = promisify(exec);

type ExecFailure = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  signal?: NodeJS.Signals;
  killed?: boolean;
};

export function formatCommandOutput(stdout = "", stderr = "", exitCode: number | string = 0): string {
  const sections: string[] = [`exit_code: ${exitCode}`];

  const out = stdout.trim();
  if (out) {
    sections.push(`stdout:\n${clampText(out, MAX_COMMAND_STREAM_CHARS, "head-tail", "re-run with a narrower command")}`);
  }

  const err = stderr.trim();
  if (err) {
    sections.push(`stderr:\n${clampText(err, MAX_COMMAND_STREAM_CHARS, "head-tail", "re-run with a narrower command")}`);
  }

  return sections.join("\n\n");
}

export async function runCommand(root: string, command: string, timeoutMs = 60_000): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execAsync(command, {
      cwd: root,
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 4,
    });

    return {
      ok: true,
      output: formatCommandOutput(result.stdout, result.stderr),
    };
  } catch (error) {
    const failure = error as ExecFailure;
    const exitCode = failure.killed ? `timeout${failure.signal ? `:${failure.signal}` : ""}` : (failure.code ?? 1);

    return {
      ok: false,
      output: formatCommandOutput(failure.stdout, failure.stderr || failure.message, exitCode),
    };
  }
}
