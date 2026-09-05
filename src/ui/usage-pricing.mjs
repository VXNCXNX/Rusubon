import { createHash } from "node:crypto";
import { readRawLocal, writeLocal } from "./workspace.mjs";

export const PRICING_CHECKED_AT = "2026-09-05";
const claudeSource = "https://platform.claude.com/docs/en/about-claude/pricing";
const claude = (model, input, output, cacheRead, cacheWrite, cacheWrite1h) => ({ runner: "claude", model, input, output, cacheRead, cacheWrite, cacheWrite1h, source: claudeSource });
const codex = (model, input, output, cacheRead) => ({ runner: "codex", model, input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: null, longContext: 272_000, source: `https://developers.openai.com/api/docs/models/${model}` });
// USD per million tokens. Exact model keys only, never substitute a nearby model.
export const MODEL_RATES = [
  claude("claude-sonnet-5", 2, 10, 0.2, 2.5, 4),
  claude("claude-opus-5", 5, 25, 0.5, 6.25, 10),
  claude("claude-fable-5-1", 10, 50, 0.25, 12.5, 20),
  claude("claude-fable-5", 10, 50, 1, 12.5, 20),
  codex("gpt-5.6-luna", 0.2, 1.2, 0.02),
  codex("gpt-5.6-terra", 2, 12, 0.2),
  codex("gpt-5.6-sol", 4, 20, 0.4),
  codex("gpt-6-astra", 10, 50, 1),
];
const keys = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];
const path = ".rusubon/usage-rates.json";
const revision = text => createHash("sha256").update(text).digest("hex");

export function pricingState(repo) {
  const raw = readRawLocal(repo, path, "{}");
  const overrides = JSON.parse(raw);
  if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") throw new Error("Invalid usage-rates.json");
  const rates = MODEL_RATES.map(row => ({ ...row }));
  for (const row of Object.values(overrides)) {
    validateRate(row);
    const index = rates.findIndex(rate => rate.runner === row.runner && rate.model === row.model);
    const entry = { ...(index < 0 ? {} : rates[index]), runner: row.runner, model: row.model, ...Object.fromEntries(keys.map(key => [key, row[key]])), custom: true };
    if (index < 0) rates.push(entry); else rates[index] = entry;
  }
  return { rates, revision: revision(raw), checkedAt: PRICING_CHECKED_AT };
}

function validateRate(row) {
  if (!row || !["claude", "codex"].includes(row.runner) || typeof row.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,119}$/.test(row.model)) throw new Error("Enter an exact model ID and runner");
  for (const key of keys) {
    if (key === "cacheWrite1h" && row[key] === null) continue;
    if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > 100_000) throw new Error("Rates must be numbers from 0 to 100,000 USD per million tokens");
  }
}

export function saveUsageRate(repo, input) {
  const raw = readRawLocal(repo, path, "{}");
  if (input.revision !== revision(raw)) { const error = new Error("Usage rates changed. Reload Usage before saving."); error.statusCode = 409; throw error; }
  validateRate(input);
  const overrides = JSON.parse(raw), key = `${input.runner}:${input.model}`;
  if (input.reset === true) delete overrides[key];
  else overrides[key] = { runner: input.runner, model: input.model, ...Object.fromEntries(keys.map(key => [key, input[key]])) };
  writeLocal(repo, path, JSON.stringify(overrides, null, 2) + "\n");
  return pricingState(repo);
}

export function estimateCost(record, rates) {
  if (Number.isFinite(record.reportedCost) && record.reportedCost >= 0) return { cost: record.reportedCost, basis: "runner" };
  const rate = rates.find(row => row.runner === record.runner && row.model === record.model);
  if (!rate || record.invalid) return { cost: null, basis: "unavailable" };
  const t = record.tokens;
  let inputMultiplier = 1, outputMultiplier = 1;
  if (rate.longContext && t.input + t.cacheRead + t.cacheWrite > rate.longContext) {
    // A cumulative catch-up can contain several requests with different tiers.
    if (!record.singleRequest) return { cost: null, basis: "unavailable" };
    inputMultiplier = 2; outputMultiplier = 1.5;
  }
  let writes = t.cacheWrite * rate.cacheWrite;
  if (record.runner === "claude" && t.cacheWrite) {
    if (record.write5m + record.write1h !== t.cacheWrite || (record.write1h && rate.cacheWrite1h === null)) return { cost: null, basis: "unavailable" };
    writes = record.write5m * rate.cacheWrite + record.write1h * (rate.cacheWrite1h || 0);
  }
  return { cost: ((t.input * rate.input + t.cacheRead * rate.cacheRead + writes) * inputMultiplier + t.output * rate.output * outputMultiplier) / 1_000_000, basis: rate.custom ? "custom" : "catalog" };
}
