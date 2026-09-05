import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { localPath } from "./workspace.mjs";
import { estimateCost, pricingState } from "./usage-pricing.mjs";

const dimensions = ["input", "cacheRead", "cacheWrite", "output", "total"];
const emptyTokens = () => Object.fromEntries(dimensions.map(key => [key, 0]));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const measured = value => Number.isSafeInteger(value) && value >= 0;
const modelId = value => typeof value === "string" ? value.replace(/\[1m\]$/, "").slice(0, 120) : "unknown";
const dayOf = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : null;
const DAY_MS = 86_400_000;

/** Resolve one UTC window for both file selection and daily aggregation. */
function usageWindow({ days = 30, runner = "all", now = new Date() } = {}) {
  if (![7, 30, 90].includes(days) || !["all", "claude", "codex"].includes(runner)) throw new Error("Choose 7, 30, or 90 days and a supported runner");
  const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  if (!Number.isFinite(today.valueOf())) throw new Error("Invalid usage date");
  const to = today.valueOf() + DAY_MS;
  return { days, runner, from: to - days * DAY_MS, to, now: today };
}

/** Prune only runs whose metadata rules out overlap; PRs can use both runners. */
function matchesWindow(job, { from, to, runner }) {
  const started = Date.parse(job.startedAt), finished = Date.parse(job.finishedAt);
  if (started >= to || finished < from) return false;
  if (runner === "all") return true;
  const runners = [job.selection?.runner];
  if (job.kind === "pr") runners.push(job.specSelection?.runner);
  // Missing legacy metadata cannot prove that a runner has no usage here.
  return runners.some(value => value === runner || !["claude", "codex"].includes(value));
}

// Adapted from ccusage's CodexRawUsage deserializer (MIT), pinned at
// ea2d241976bf42f79bcc2b2ea245baf88b412cc1, rust/adapters/codex/src/types.rs.
// Codex includes cache reads/writes in input and reasoning in output.
export function codexTokens(raw) {
  const input = count(raw.inputTokens), output = count(raw.outputTokens);
  const cacheRead = Math.min(count(raw.cachedInputTokens), input);
  const cacheWrite = Math.min(count(raw.cacheWriteInputTokens), input - cacheRead);
  return { input: input - cacheRead - cacheWrite, cacheRead, cacheWrite, output, total: input + output };
}

function claudeTokens(raw, camel = false) {
  const input = count(camel ? raw.inputTokens : raw.input_tokens);
  const output = count(camel ? raw.outputTokens : raw.output_tokens);
  const cacheRead = count(camel ? raw.cacheReadInputTokens : raw.cache_read_input_tokens);
  const cacheWrite = count(camel ? raw.cacheCreationInputTokens : raw.cache_creation_input_tokens);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** Streaming reducer: session snapshots never add to earlier snapshots. */
export function usageCollector(job) {
  let session = { ...job.selection, sessionId: "legacy" }, sequence = 0, partial = Boolean(job.logTruncated);
  const codex = new Map(), claude = new Map(), records = [], sessions = new Map(), reportedSessions = new Set();
  function push(event) {
    if (event.type === "session") {
      session = { ...event, sessionId: event.sessionId || `phase-${++sequence}` };
      sessions.set(session.sessionId, { runner: session.runner, day: dayOf(event.at || job.startedAt) });
    }
    if (event.type !== "usage") return;
    const runner = event.runner || session.runner || (event.usage?.total ? "codex" : "claude");
    const sessionId = event.sessionId || session.sessionId;
    const day = dayOf(event.at || job.startedAt);
    if (!day) { partial = true; return; }
    const base = { runner, model: modelId(event.model || session.model), day, sessionId };
    if (runner === "codex") {
      const raw = event.usage?.total;
      if (!raw || !measured(raw.inputTokens) || !measured(raw.outputTokens)) { partial = true; return; }
      const current = codexTokens(raw), previous = codex.get(sessionId) || emptyTokens();
      if (current.total < previous.total) { partial = true; return; }
      if (current.total === previous.total && codex.has(sessionId)) return;
      const tokens = Object.fromEntries(dimensions.map(key => [key, Math.max(0, current[key] - previous[key])]));
      const invalid = dimensions.some(key => current[key] < previous[key]);
      partial ||= invalid;
      const last = event.usage?.last && codexTokens(event.usage.last);
      records.push({ ...base, tokens, invalid, singleRequest: Boolean(last && dimensions.every(key => tokens[key] === last[key])) });
      codex.set(sessionId, current);
    } else if (runner === "claude") {
      const entries = Object.entries(event.modelUsage || {}).filter(([, raw]) => raw && measured(raw.inputTokens) && measured(raw.outputTokens));
      if (entries.length) {
        partial ||= entries.length !== Object.keys(event.modelUsage).length;
        claude.set(sessionId, entries.map(([model, raw]) => ({
          ...base, model: modelId(raw.canonicalModel || model), tokens: claudeTokens(raw, true),
          // Unknown-provider SDK costs can be guesses at another model's rate.
          reportedCost: raw.costBasis !== "unknown" && Number.isFinite(raw.costUSD) && raw.costUSD >= 0 ? raw.costUSD : null,
          write5m: null, write1h: null,
        })));
      } else {
        const raw = event.usage;
        if (!raw || !measured(raw.input_tokens) || !measured(raw.output_tokens)) { partial = true; return; }
        partial = true; // Legacy usage excludes delegated calls and side chains.
        claude.set(sessionId, [{ ...base, tokens: claudeTokens(raw), write5m: raw.cache_creation?.ephemeral_5m_input_tokens ?? null, write1h: raw.cache_creation?.ephemeral_1h_input_tokens ?? null }]);
      }
    } else return;
    reportedSessions.add(sessionId);
  }
  return {
    push,
    malformed() { partial = true; },
    result() { return { records: [...records, ...[...claude.values()].flat()], partial, missingSessions: [...sessions].filter(([id]) => !reportedSessions.has(id)).map(([, value]) => value) }; },
  };
}

function bucket(key) { return { key, tokens: emptyTokens(), cost: 0, pricedTokens: 0, unpricedTokens: 0, runs: new Set(), bases: new Set() }; }
function add(target, record, jobId, price) {
  for (const key of dimensions) target.tokens[key] += record.tokens[key];
  target.runs.add(jobId); target.bases.add(price.basis);
  if (price.cost === null) target.unpricedTokens += record.tokens.total;
  else { target.cost += price.cost; target.pricedTokens += record.tokens.total; }
}
const serialize = value => ({ ...value, runs: value.runs.size, bases: [...value.bases], cost: value.unpricedTokens > 0 && value.pricedTokens === 0 ? null : value.cost });

export function aggregateUsage(histories, options) {
  const window = usageWindow(options), { days, runner, from, to } = window, { pricing } = options;
  const daily = new Map();
  for (let time = from; time < to; time += DAY_MS) { const day = new Date(time).toISOString().slice(0, 10); daily.set(day, { ...bucket(day), providers: { claude: bucket("claude"), codex: bucket("codex") } }); }
  const total = bucket("total"), models = new Map(), providers = new Map(["claude", "codex"].map(key => [key, bucket(key)]));
  let missingRuns = 0, partialRuns = 0;
  for (const { job, records, partial, missingSessions = [] } of histories) {
    let included = false;
    for (const record of records) {
      if (!daily.has(record.day) || (runner !== "all" && runner !== record.runner)) continue;
      included = true;
      const key = `${record.runner}:${record.model}`, price = estimateCost(record, pricing.rates);
      if (!models.has(key)) models.set(key, { ...bucket(record.model), runner: record.runner });
      const day = daily.get(record.day);
      for (const target of [total, models.get(key), providers.get(record.runner), day, day.providers[record.runner]]) add(target, record, job.id, price);
    }
    const relevant = matchesWindow(job, window);
    const missingPhase = missingSessions.some(s => daily.has(s.day) && (runner === "all" || s.runner === runner));
    if (!included && (relevant || missingPhase)) missingRuns++;
    else if (included && (partial || missingPhase)) partialRuns++;
  }
  return { days, runner, timezone: "UTC", total: serialize(total), missingRuns, partialRuns, pricing,
    providers: [...providers.values()].filter(row => runner === "all" || row.key === runner).map(serialize),
    models: [...models.values()].sort((a, b) => b.tokens.total - a.tokens.total).map(serialize),
    daily: [...daily.values()].map(row => ({ ...serialize(row), providers: Object.fromEntries(Object.entries(row.providers).map(([key, value]) => [key, serialize(value)])) })),
  };
}

export function createUsageReader(repo) {
  const cache = new Map();
  async function history(job) {
    if (!/^ui-[a-f0-9-]+$/.test(job.id)) return { job, records: [], partial: true };
    try {
      const path = localPath(repo, `.rusubon/runs/${job.id}/events.jsonl`), info = await stat(path);
      if (!info.isFile() || info.size > 35_000_000) throw new Error("Usage history is too large");
      const fingerprint = `${info.mtimeMs}:${info.size}:${job.logTruncated}`;
      if (cache.get(job.id)?.fingerprint !== fingerprint) {
        const promise = (async () => {
          const collector = usageCollector(job);
          const stream = createReadStream(path, { encoding: "utf8", end: Math.max(0, info.size - 1) });
          const lines = createInterface({ input: stream, crlfDelay: Infinity });
          try { for await (const line of lines) { if (!line.trim()) continue; try { collector.push(JSON.parse(line)); } catch { collector.malformed(); } } }
          finally { lines.close(); stream.destroy(); }
          return collector.result();
        })();
        cache.set(job.id, { fingerprint, promise });
      }
      return { job, ...await cache.get(job.id).promise };
    } catch { cache.delete(job.id); return { job, records: [], partial: true }; }
  }
  return async (jobs, options = {}) => {
    const window = usageWindow(options), histories = [];
    // Read one file at a time, retaining only usage counters, never transcript text.
    const agentJobs = jobs.filter(job => ["scout", "context", "pr"].includes(job.kind));
    const ids = new Set(agentJobs.map(job => job.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    for (const job of agentJobs) if (matchesWindow(job, window)) histories.push(await history(job));
    return aggregateUsage(histories, { ...window, pricing: pricingState(repo) });
  };
}
