import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { InteractionHandler } from "../tools/specs.js";

/**
 * Build a readline-backed interaction handler, or `undefined` when there is no
 * interactive terminal (so non-interactive runs degrade gracefully with no
 * handler at all). Each method opens, uses, and closes its own readline
 * interface per call — mirroring `promptForCommandApproval`.
 */
export function createReaderInteraction(): InteractionHandler | undefined {
  if (!input.isTTY || !output.isTTY) {
    return undefined;
  }

  return {
    async askText(prompt: string): Promise<string> {
      const rl = createInterface({ input, output });
      try {
        const answer = await rl.question(`${prompt}\n> `);
        return answer.trim();
      } finally {
        rl.close();
      }
    },

    async askYesNo(question: string): Promise<boolean> {
      const rl = createInterface({ input, output });
      try {
        const answer = await rl.question(`${question} [y/N] `);
        const normalized = answer.trim().toLowerCase();
        return normalized === "y" || normalized === "yes";
      } finally {
        rl.close();
      }
    },

    async askChoice(question: string, options: string[]): Promise<string> {
      const rl = createInterface({ input, output });
      try {
        const lines = [question, ...options.map((opt, index) => `${index + 1}) ${opt}`)];
        const answer = await rl.question(`${lines.join("\n")}\n> `);
        const trimmed = answer.trim();
        const index = Number.parseInt(trimmed, 10);
        if (Number.isInteger(index) && index >= 1 && index <= options.length) {
          return options[index - 1];
        }
        return trimmed;
      } finally {
        rl.close();
      }
    },
  };
}
