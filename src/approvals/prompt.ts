import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

export async function promptForCommandApproval(command: string): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    return false;
  }

  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question(`Approve command? ${command}\n[y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
