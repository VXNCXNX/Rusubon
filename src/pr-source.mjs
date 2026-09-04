import { showReport } from "./inbox.mjs";
import { reportSlug } from "./decline.mjs";

const ISSUE_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i;
const ISSUE_REF = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/;
const ISSUE_HASH = /^#(\d+)$/;
const ISSUE_DIGITS = /^\d+$/;

function parseJsonOut(out, what) {
  const text = String(out || "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m ? m[0] : text);
  } catch {
    throw new Error(`${what}: ${text || "empty"}`);
  }
}

export function parseIssue(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const url = s.match(ISSUE_URL);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  const ref = s.match(ISSUE_REF);
  if (ref) return { owner: ref[1], repo: ref[2], number: Number(ref[3]) };
  const hash = s.match(ISSUE_HASH);
  if (hash) return { number: Number(hash[1]) };
  if (ISSUE_DIGITS.test(s)) return { number: Number(s) };
  return null;
}

export function formatIssueRef(issue) {
  if (issue?.owner && issue?.repo) return `${issue.owner}/${issue.repo}#${issue.number}`;
  return `#${issue?.number}`;
}

export function parseSource(raw, flags = {}) {
  const wantIssue = Boolean(flags.issue);
  const wantReport = Boolean(flags.report);
  if (wantIssue && wantReport) {
    throw new Error("use --issue or --report, not both");
  }
  const s = String(raw || "").trim();
  if (!s) throw new Error("usage: rusubon pr <slug|#N|url> [--issue|--report]");

  if (wantReport) {
    return { kind: "report", slug: reportSlug(s) };
  }

  const issue = parseIssue(s);
  if (wantIssue) {
    if (!issue) throw new Error(`not an issue ref: ${s}`);
    return { kind: "issue", ...issue };
  }
  if (issue) return { kind: "issue", ...issue };
  return { kind: "report", slug: reportSlug(s) };
}

export function currentRepoName(probes) {
  if (typeof probes?.ghRepo !== "function") {
    throw new Error("gh repo view failed");
  }
  const r = probes.ghRepo();
  if (!r || r.status !== 0) {
    throw new Error(`gh repo view failed${r?.out ? `: ${r.out}` : ""}`);
  }
  const data = parseJsonOut(r.out, "gh repo view failed");
  const name = String(data.nameWithOwner || "").trim();
  if (!name.includes("/")) throw new Error("gh repo view failed: no nameWithOwner");
  return name;
}

export function resolveIssue(issue, probes) {
  const here = currentRepoName(probes);
  const [hereOwner, hereRepo] = here.split("/");
  const owner = issue.owner || hereOwner;
  const repo = issue.repo || hereRepo;
  const nameWithOwner = `${owner}/${repo}`;
  if (nameWithOwner !== here) {
    throw new Error(
      `${formatIssueRef({ owner, repo, number: issue.number })} is ${nameWithOwner}; this checkout is ${here}. run from that checkout.`,
    );
  }
  if (typeof probes.ghIssue !== "function") {
    throw new Error("gh issue view failed");
  }
  const r = probes.ghIssue(issue.number, nameWithOwner);
  if (!r || r.status !== 0) {
    throw new Error(`gh issue view failed${r?.out ? `: ${r.out}` : ""}`);
  }
  const data = parseJsonOut(r.out, "gh issue view failed");
  return {
    kind: "issue",
    owner,
    repo,
    number: Number(data.number || issue.number),
    title: data.title || "",
    body: data.body || "",
    url: data.url || "",
    state: data.state || "",
    labels: data.labels || [],
  };
}

export function resolveSource(parsed, probes = {}) {
  if (parsed.kind === "report") {
    const report = showReport(parsed.slug);
    return {
      kind: "report",
      slug: report.slug,
      path: report.path,
      where: report.where,
      body: report.body,
      title: ((report.body.match(/^#\s+(.+)/m) || [])[1] || report.slug).trim(),
    };
  }
  return resolveIssue(parsed, probes);
}
