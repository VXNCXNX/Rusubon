import { CodexRpc } from "./codex-rpc.mjs";
import { availableModels } from "./models.mjs";
import { command, safeText } from "./process.mjs";
import { isOfficialPosthog } from "./claude.mjs";

export async function inspectCodex(cwd) {
  const rpc = new CodexRpc({ cwd });
  try {
    await rpc.initialize();
    const [account, catalog, config] = await Promise.all([rpc.request("account/read", {}), rpc.list("model/list", { includeHidden: false }), command("codex", ["mcp", "list", "--json"], { cwd })]);
    let entries; try { entries = JSON.parse(config.stdout); } catch { entries = []; }
    const official = entries.filter(row => row.enabled !== false && isOfficialPosthog(row.transport?.url));
    const servers = await rpc.list("mcpServerStatus/list", { detail: "toolsAndAuthOnly" });
    return { runner: "codex", installed: true, authenticated: Boolean(account.account), models: availableModels("codex", catalog), billing: account.account?.type === "apiKey" ? "API key" : "Runner login",
      serverNames: entries.map(row => row.name),
      mcp: official.map(row => { const live = servers.find(server => server.name === row.name); const tools = Object.keys(live?.tools || {}); return { name: row.name, connected: tools.length > 0, status: tools.length ? "connected" : live?.authStatus || "not connected", tools }; }), detail: account.account ? "Codex connected" : "Sign in to Codex" };
  } finally { rpc.close(); }
}

export async function answerCodexRequest(message, ask, signal) {
  const { method, params } = message;
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    const response = await ask({ kind: "questions", title: "Codex needs your input", questions: params.questions, input: params }, signal);
    const answers = {};
    for (const question of params.questions || []) answers[question.id] = { answers: [response.allow ? String(response.answers?.[question.id] || "") : "The user declined to answer"] };
    return { answers };
  }
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    const response = await ask({ kind: "permission", title: params.reason || (method.includes("commandExecution") ? "Run command" : "Change files"), input: params }, signal);
    return { decision: response.allow ? "accept" : "decline" };
  }
  if (method === "mcpServer/elicitation/request") {
    const response = await ask({ kind: "elicitation", title: params.message || "Connection needs input", input: params }, signal);
    return { action: response.allow ? "accept" : "decline", content: response.allow ? response.content || {} : null };
  }
  if (method === "item/permissions/requestApproval") {
    const response = await ask({ kind: "permission", title: params.reason || "Additional permissions", input: params }, signal);
    return { permissions: response.allow ? params.permissions : {}, scope: "turn" };
  }
  throw new Error(`Unsupported Codex request: ${method}. Update Rusubon before continuing.`);
}

export async function runCodex(prompt, { cwd, model, effort, signal, emit, ask, timeoutMs = 30 * 60_000 }) {
  const rpc = new CodexRpc({ cwd });
  let timer, threadId, timedOut = false;
  let finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  // Register immediately so startup disconnects cannot leave unhandled rejections.
  completed.catch(() => {});
  const abort = () => { fail(new Error("Run stopped")); rpc.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  rpc.on("disconnected", fail);
  rpc.on("request", async message => {
    try { const result = await answerCodexRequest(message, ask, signal); rpc.send({ id: message.id, result }); }
    catch (error) { fail(error); rpc.close(); }
  });
  rpc.on("notification", ({ method, params }) => {
    if (params.threadId && threadId && params.threadId !== threadId) return;
    if (method === "model/rerouted" && params.toModel !== model) { fail(new Error(`Codex rerouted to ${safeText(params.toModel)}. This run requires ${model}.`)); rpc.close(); return; }
    if (method === "item/completed" || method === "item/started") {
      const item = params.item;
      if (item?.type === "agentMessage" && method === "item/completed") emit({ type: "message", text: safeText(item.text) });
      else if (item && !["reasoning", "userMessage", "agentMessage"].includes(item.type)) emit({ type: "tool", name: item.type, status: method === "item/started" ? "running" : item.status || "completed", text: safeText(item.command || item.tool || item.aggregatedOutput || "") });
    }
    if (method === "thread/tokenUsage/updated") emit({ type: "usage", usage: params.tokenUsage });
    if (method === "turn/completed") {
      if (params.turn?.status === "completed") finish({ status: 0, timedOut: false });
      else fail(new Error(safeText(params.turn?.error?.message || `Codex turn ${params.turn?.status || "failed"}`)));
    }
  });
  try {
    if (signal?.aborted) throw new Error("Run stopped");
    timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    await rpc.initialize();
    const thread = await rpc.request("thread/start", { cwd, model, approvalPolicy: "on-request", sandbox: "workspace-write", config: { model_reasoning_effort: effort }, serviceName: "rusubon" });
    threadId = thread.thread.id;
    if (thread.model && thread.model !== model) throw new Error("Codex changed the requested model");
    if (thread.reasoningEffort && thread.reasoningEffort !== effort) throw new Error(`Codex selected ${thread.reasoningEffort} effort instead of ${effort}`);
    emit({ type: "session", runner: "codex", sessionId: threadId, model, effort });
    await rpc.request("turn/start", { threadId, model, effort, input: [{ type: "text", text: prompt, text_elements: [] }] });
    return await completed;
  } catch (error) { if (timedOut) return { status: 1, timedOut: true }; throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); rpc.close(); }
}
