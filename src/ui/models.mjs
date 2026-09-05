const COMMON = ["low", "medium", "high", "xhigh", "max"];
export const canonicalClaudeModel = value => String(value || "").replace(/\[1m\]$/, "");
export const MODEL_ALLOWLIST = {
  claude: [
    { id: "claude-sonnet-5", label: "Sonnet 5", defaultEffort: "high", efforts: COMMON },
    { id: "claude-opus-5", label: "Opus 5", defaultEffort: "high", efforts: COMMON },
  ],
  codex: [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", defaultEffort: "medium", efforts: COMMON },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", defaultEffort: "medium", efforts: [...COMMON, "ultra"] },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", defaultEffort: "low", efforts: [...COMMON, "ultra"] },
    { id: "gpt-6-astra", label: "GPT-6 Astra", defaultEffort: "low", efforts: [...COMMON, "ultra"] },
  ],
};

export const SPEC_MODEL_ALLOWLIST = {
  claude: [...MODEL_ALLOWLIST.claude, { id: "claude-fable-5-1", label: "Fable 5.1", defaultEffort: "high", efforts: COMMON }],
  codex: MODEL_ALLOWLIST.codex,
};
export const ROLE_MODELS = { scout: MODEL_ALLOWLIST, spec: SPEC_MODEL_ALLOWLIST, implementation: MODEL_ALLOWLIST };
export const DEFAULT_SPEC_SELECTION = { runner: "codex", model: "gpt-5.6-sol", effort: "high" };

function roleModels(role) {
  if (!Object.hasOwn(ROLE_MODELS, role)) throw new Error("Unknown agent role");
  return ROLE_MODELS[role];
}

/** Account capabilities narrow the product allowlist, never expand it. */
export function availableModels(runner, catalog, role = "scout") {
  return (roleModels(role)[runner] || []).map(spec => {
    const live = catalog.find(row => (runner === "claude" ? canonicalClaudeModel(row.resolvedModel || row.value) : row.model) === spec.id);
    const supported = runner === "claude" ? live?.supportedEffortLevels : live?.supportedReasoningEfforts?.map(row => row.reasoningEffort);
    const efforts = Array.isArray(supported) ? spec.efforts.filter(effort => supported.includes(effort)) : [];
    const preferred = live?.defaultReasoningEffort || spec.defaultEffort;
    return { ...spec, efforts, available: efforts.length > 0, defaultEffort: efforts.includes(preferred) ? preferred : efforts[0] || null };
  });
}

export function validateSelection(selection, catalog, role = "scout") {
  validateSavedSelection(selection, role);
  const model = catalog.find(row => row.id === selection.model && row.available);
  if (!model) throw new Error("This model is not available on the connected runner. Refresh the connection.");
  if (!model.efforts.includes(selection.effort)) throw new Error("This effort is not supported by the selected model");
  return { runner: selection.runner, model: model.id, effort: selection.effort };
}

export function validateSavedSelection(value, role = "scout") {
  const spec = roleModels(role)[value?.runner]?.find(row => row.id === value.model);
  if (!spec || !spec.efforts.includes(value.effort)) throw new Error("Choose a supported model and effort");
  return { runner: value.runner, model: spec.id, effort: value.effort };
}
