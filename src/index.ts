import { runCli } from "./cli.js";

runCli().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
