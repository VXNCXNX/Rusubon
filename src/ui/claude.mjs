import { query } from "@anthropic-ai/claude-agent-sdk";
import { pkgRoot } from "../config.mjs";
import { availableModels, canonicalClaudeModel, SPEC_MODEL_ALLOWLIST } from "./models.mjs";
import { command, inputQueue, safeText } from "./process.mjs";
import { claudePermissions } from "../permissions.mjs";

export function claudeOptions(cwd, extra = {}) {
  return {
    cwd, pathToClaudeCodeExecutable: process.env.RUSUBON_CLAUDE || "claude",
    settingSources: ["user", "project", "local"], persistSession: false,
    model: "claude-sonnet-5", permissionMode: "default",
    settings: { availableModels: ["claude-sonnet-5", "claude-opus-5"], fallbackModel: [] },
    ...extra,
  };
}

export function isOfficialPosthog(url) {
  try { const parsed = new URL(url); return parsed.origin === "https://mcp.posthog.com" && /^\/mcp\/?$/.test(parsed.pathname) && !parsed.username && !parsed.password; } catch { return false; }
}

export async function inspectClaude(cwd) {
  const auth = await command(process.env.RUSUBON_CLAUDE || "claude", ["auth", "status"], { cwd });
  let status; try { status = JSON.parse(auth.stdout); } catch { status = {}; }
  if (!status.loggedIn) return { runner: "claude", installed: true, authenticated: false, models: availableModels("claude", [], "spec"), mcp: [], detail: "Sign in to Claude Code" };
  const input = inputQueue(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const session = query({ prompt: input, options: claudeOptions(cwd, { settings: { availableModels: SPEC_MODEL_ALLOWLIST.claude.map(row => row.id), fallbackModel: [] }, abortController: controller, stderr: () => {} }) });
  try {
    const catalog = await session.supportedModels();
    let servers = await session.mcpServerStatus();
    while (servers.some(row => isOfficialPosthog(row.config?.url) && row.status === "pending") && !controller.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 500)); servers = await session.mcpServerStatus();
    }
    return { runner: "claude", installed: true, authenticated: true, billing: process.env.ANTHROPIC_API_KEY ? "API key" : "Runner login",
      serverNames: servers.map(row => row.name),
      models: availableModels("claude", catalog, "spec"),
      mcp: servers.filter(row => isOfficialPosthog(row.config?.url)).map(row => ({ name: row.name, connected: row.status === "connected" && row.tools?.length > 0, status: row.status, tools: (row.tools || []).map(tool => tool.name) })),
      detail: "Claude Code connected" };
  } finally { clearTimeout(timer); input.close(); session.close(); }
}

export function assertClaudeSelection(message, { model, effort }) {
  if (message.type === "system" && message.subtype === "model_refusal_fallback" && canonicalClaudeModel(message.fallback_model) !== model) throw new Error(`Claude fell back to ${safeText(message.fallback_model)}. This phase requires ${model}. Run stopped.`);
  const init = message.type === "system" && message.subtype === "init";
  const actualModel = init ? message.model : message.type === "assistant" && !message.parent_tool_use_id ? message.message?.model : null;
  if (actualModel && canonicalClaudeModel(actualModel) !== model) throw new Error(`Claude selected ${safeText(actualModel)} instead of ${model}. Run stopped.`);
  if (init && message.effort !== undefined && message.effort !== effort) throw new Error(`Claude selected ${safeText(message.effort)} effort instead of ${effort}. Run stopped.`);
}

export async function runClaude(prompt, { cwd, model, effort, permissionMode, signal, emit, ask, timeoutMs = 30 * 60_000, createQuery = query }) {
  const permissions = claudePermissions(permissionMode);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  let session, selectionError, modelObserved = false, effortObserved = false;
  const observeEffort = actual => {
    if (actual !== effort) throw new Error(`Claude selected ${safeText(actual)} effort instead of ${effort}. Run stopped.`);
    if (!effortObserved) emit({ type: "selection_verified", runner: "claude", model, effort });
    effortObserved = true;
  };
  const checkRuntime = async input => {
    try {
      if (["PreModelSwitch", "PostModelSwitch"].includes(input.hook_event_name) && canonicalClaudeModel(input.to_model) !== model) throw new Error(`Claude attempted to switch to ${safeText(input.to_model)}. This phase requires ${model}. Run stopped.`);
      if (!input.agent_id && input.effort !== undefined) observeEffort(input.effort?.level);
      return { continue: true };
    } catch (error) {
      selectionError = error; controller.abort();
      return { continue: false, stopReason: error.message };
    }
  };
  try {
    if (signal?.aborted) throw new Error("Run stopped");
    session = createQuery({ prompt, options: claudeOptions(cwd, {
      model, effort, ...permissions, abortController: controller, additionalDirectories: [pkgRoot()],
      settings: { availableModels: [model], fallbackModel: [] },
      env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: effort },
      hooks: Object.fromEntries(["PreToolUse", "Stop", "PreModelSwitch", "PostModelSwitch"].map(event => [event, [{ hooks: [checkRuntime] }]])),
      // Exact model ids are passed for every phase. No best/default alias or fallback chain.
      canUseTool: async (tool, input, options) => {
        const response = await ask({ kind: tool === "AskUserQuestion" ? "questions" : "permission", title: tool, input, questions: tool === "AskUserQuestion" ? input.questions : undefined }, options.signal);
        if (!response.allow) return { behavior: "deny", message: response.message || "The user declined this operation" };
        return { behavior: "allow", updatedInput: tool === "AskUserQuestion" ? { ...input, answers: response.answers || {} } : input };
      },
      onElicitation: async (request, options) => {
        const response = await ask({ kind: "elicitation", title: request.message || "Connection needs input", input: request }, options.signal);
        return response.allow ? { action: "accept", content: response.content || {} } : { action: "decline" };
      },
      stderr: () => {},
    }) });
    let result;
    for await (const message of session) {
      if (selectionError) throw selectionError;
      assertClaudeSelection(message, { model, effort });
      if (message.type === "system" && message.subtype === "init") {
        if (message.permissionMode !== undefined && message.permissionMode !== permissions.permissionMode) throw new Error("Claude did not apply the requested permission mode. Update Claude Code or review its managed settings before retrying.");
        modelObserved ||= Boolean(message.model);
        if (message.effort !== undefined) observeEffort(message.effort);
        emit({ type: "session", runner: "claude", sessionId: message.session_id, model, effort, effortVerified: message.effort === effort });
      }
      if (message.type === "assistant") for (const block of message.message?.content || []) {
        if (block.type === "text") emit({ type: "message", text: safeText(block.text) });
        if (block.type === "tool_use") emit({ type: "tool", name: block.name, text: safeText(JSON.stringify(block.input)), parentId: message.parent_tool_use_id || null });
      }
      if (message.type === "result") { result = message; emit({ type: "usage", runner: "claude", sessionId: message.session_id, model, effort, usage: message.usage, modelUsage: message.modelUsage, totalCostUsd: message.total_cost_usd, durationMs: message.duration_ms }); }
    }
    if (selectionError) throw selectionError;
    if (!result || result.is_error || result.subtype !== "success") throw new Error(safeText(result?.errors?.join("\n") || "Claude did not complete this phase"));
    if (!modelObserved || !effortObserved) throw new Error("Claude did not report its effective model and effort. Update Claude Code before retrying. This phase was not accepted as successful.");
    return { status: 0, timedOut: false };
  } catch (error) {
    if (selectionError) throw selectionError;
    if (timedOut) return { status: 1, timedOut: true };
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); session?.close(); }
}
