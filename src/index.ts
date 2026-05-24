import { main } from "./cli/main.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`solarcido: ${message}`);
  process.exitCode = 1;
});
