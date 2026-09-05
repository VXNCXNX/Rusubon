import { saveSetup } from "../../src/ui/workspace.mjs";
let input;
process.on("message", message => {
  if (message.type === "start") {
    input = message.input;
    process.send({ type: "request", request: { id: "save", kind: "permission", title: "Fixture save barrier" } });
  }
  if (message.type === "answer") {
    let result, error;
    try { result = saveSetup(process.cwd(), input.setup); } catch (failure) { error = failure.message; }
    process.send({ type: "result", result, error }, () => process.exit(error ? 1 : 0));
  }
});
