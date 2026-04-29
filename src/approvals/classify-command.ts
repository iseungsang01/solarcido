import type { CommandRisk } from "./policy.js";

const RISKY_PATTERNS = [
  /\brm\b/i,
  /\bdel\b/i,
  /\bremove-item\b/i,
  /\brmdir\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+checkout\b/i,
  /\bnpm\s+(install|publish)\b/i,
  /\bnpm\.cmd\s+(install|publish)\b/i,
  /\byarn\s+(add|remove|publish)\b/i,
  /\bpnpm\s+(add|remove|install|publish)\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\binvoke-webrequest\b/i,
  /\bset-executionpolicy\b/i,
  /\bsudo\b/i,
];

export function classifyCommand(command: string): CommandRisk {
  return RISKY_PATTERNS.some((pattern) => pattern.test(command)) ? "risky" : "low";
}
