import { writeFileSync } from "node:fs";
import { draftContext } from "../../src/context-draft.mjs";

process.on("message", async message => {
  if (message.type !== "start") return;
  process.send({ type: "started" });
  try {
    await draftContext({ config: { runner: "claude" }, run: async () => {
      writeFileSync(".rusubon/context.md", "# Product\nUnreviewed agent draft\n# Money paths\n/checkout\n# Intentional friction\nNone\n# Out of scope\nStaging\n");
      process.send({ type: "event", event: { type: "message", text: "draft written" } });
      if (message.input.about === "complete") return { status: 0 };
      if (message.input.about === "exit") process.exit(7);
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    } });
    process.send({ type: "result", result: {} }, () => process.exit(0));
  } catch (error) { process.send({ type: "result", error: error.message }, () => process.exit(1)); }
});
// Stop and disconnect are deliberately ignored to exercise supervisor recovery.
