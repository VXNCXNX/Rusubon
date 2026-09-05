import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture" } });
  else if (message.method === "model/list") send({ id: message.id, result: { data: [{ model: message.params.cursor ? "second" : "first" }], nextCursor: message.params.cursor ? null : "next" } });
  else if (message.method === "fixture/error") send({ id: message.id, error: { message: "Bearer credential" } });
  else if (message.method === "fixture/exit") process.exit(2);
  else if (message.method === "fixture/notify") { send({ method: "item/started", params: { item: { type: "commandExecution" } } }); send({ id: message.id, result: {} }); }
  else if (message.method === "fixture/approval") { send({ id: "request-1", method: "item/fileChange/requestApproval", params: { reason: "Edit file" } }); send({ id: message.id, result: {} }); }
  else if (message.method === "fixture/wait") { /* Exercise request timeout. */ }
  else send({ id: message.id, result: {} });
});
