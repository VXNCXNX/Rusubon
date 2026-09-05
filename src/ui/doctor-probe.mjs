// Bounded by the CLI doctor's process supervisor. Emit only the connection verdict.
import { inspectCodex } from "./codex.mjs";
try {
  const connection = await inspectCodex(process.cwd());
  console.log(connection.mcp.some(row => row.connected) ? "posthog: connected" : "posthog: not connected");
} catch { console.log("posthog: not connected"); process.exitCode = 1; }
