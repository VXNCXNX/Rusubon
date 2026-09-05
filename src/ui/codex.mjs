import { CodexRpc } from "./codex-rpc.mjs";
import { availableModels } from "./models.mjs";
import { command, safeText } from "./process.mjs";
import { isOfficialPosthog } from "./claude.mjs";
import { codexPermissions } from "../permissions.mjs";
import { CodexToolActivity } from "./codex-tools.mjs";

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
    const toolApproval = params._meta?.codex_approval_kind === "mcp_tool_call";
    const response = await ask(toolApproval
      ? { kind: "permission", title: params.message || "Allow MCP tool", input: { server: params.serverName, tool: params._meta.tool_title, arguments: params._meta.tool_params } }
      : { kind: "elicitation", title: params.message || "Connection needs input", input: params }, signal);
    return { action: response.allow ? "accept" : "decline", content: response.allow ? response.content || {} : null };
  }
  if (method === "item/permissions/requestApproval") {
    const response = await ask({ kind: "permission", title: params.reason || "Additional permissions", input: params }, signal);
    return { permissions: response.allow ? params.permissions : {}, scope: "turn" };
  }
  throw new Error(`Unsupported Codex request: ${method}. Update Rusubon before continuing.`);
}

export async function runCodex(prompt, { cwd, model, effort, permissionMode, signal, emit, ask, timeoutMs = 30 * 60_000, createRpc = options => new CodexRpc(options) }) {
  const permissions = codexPermissions(permissionMode);
  const rpc = createRpc({ cwd });
  let timer, threadId, timedOut = false, pendingRequests = 0;
  let finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  // Register immediately so startup disconnects cannot leave unhandled rejections.
  completed.catch(() => {});
  const stop = error => { activity.close(); fail(error); rpc.close(error); };
  const activity = new CodexToolActivity(emit, stop);
  const abort = () => stop(new Error("Run stopped"));
  signal?.addEventListener("abort", abort, { once: true });
  rpc.on("disconnected", stop);
  rpc.on("request", async message => {
    if (activity.closed) return;
    pendingRequests++; activity.pause();
    try { const result = await answerCodexRequest(message, ask, signal); if (!activity.closed) rpc.send({ id: message.id, result }); }
    catch (error) { stop(error); }
    finally { if (--pendingRequests === 0) activity.resume(); }
  });
  rpc.on("notification", ({ method, params }) => {
    if (activity.closed) return;
    if (params.threadId && threadId && params.threadId !== threadId) return;
    if (method === "model/rerouted" && params.toModel !== model) { stop(new Error(`Codex rerouted to ${safeText(params.toModel)}. This run requires ${model}.`)); return; }
    if (method === "item/completed" || method === "item/started") {
      const item = params.item;
      if (item?.type === "agentMessage" && method === "item/completed") emit({ type: "message", text: safeText(item.text) });
      else if (item?.type === "mcpToolCall") activity.item(item, method === "item/started");
      else if (item && !["reasoning", "userMessage", "agentMessage"].includes(item.type)) emit({ type: "tool", name: item.type, status: method === "item/started" ? "running" : item.status || "completed", text: safeText(item.command || item.tool || item.aggregatedOutput || "") });
    }
    if (method === "item/mcpToolCall/progress") activity.progress(params);
    if (method === "thread/tokenUsage/updated") emit({ type: "usage", runner: "codex", sessionId: params.threadId || threadId, model, effort, usage: params.tokenUsage });
    if (method === "turn/completed") {
      activity.close();
      if (params.turn?.status === "completed") finish({ status: 0, timedOut: false });
      else fail(new Error(safeText(params.turn?.error?.message || `Codex turn ${params.turn?.status || "failed"}`)));
    }
  });
  try {
    if (signal?.aborted) throw new Error("Run stopped");
    timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    await rpc.initialize();
    const thread = await rpc.request("thread/start", { cwd, model, ...permissions, config: { model_reasoning_effort: effort }, serviceName: "rusubon" });
    threadId = thread.thread.id;
    if (thread.approvalPolicy !== permissions.approvalPolicy || thread.approvalsReviewer !== permissions.approvalsReviewer || thread.sandbox?.type !== (permissions.sandbox === "danger-full-access" ? "dangerFullAccess" : "workspaceWrite")) throw new Error("Codex did not apply the requested permission mode. Update Codex or review its managed settings before retrying.");
    if (thread.model && thread.model !== model) throw new Error("Codex changed the requested model");
    if (thread.reasoningEffort && thread.reasoningEffort !== effort) throw new Error(`Codex selected ${thread.reasoningEffort} effort instead of ${effort}`);
    emit({ type: "session", runner: "codex", sessionId: threadId, model, effort });
    await rpc.request("turn/start", { threadId, model, effort, input: [{ type: "text", text: prompt, text_elements: [] }] });
    return await completed;
  } catch (error) { if (timedOut) return { status: 1, timedOut: true }; throw error; }
  finally { clearTimeout(timer); activity.close(); signal?.removeEventListener("abort", abort); rpc.close(); }
}
