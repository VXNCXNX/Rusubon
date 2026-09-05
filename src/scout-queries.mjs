import { pathPattern } from "./scout-scope.mjs";

const literal = value => `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
// PostHog's querying-canvas-data skill uses numeric toDateTime bounds to avoid
// interpreting string timestamps in the project's timezone.
const instant = iso => `toDateTime(${Math.floor(Date.parse(iso) / 1000)})`;

export function scopedQueries(scope, phase = 1) {
  const { window: w, paths, options } = scope;
  const start = instant(w.start), end = instant(w.end), baseline = instant(w.baselineStart), history = instant(w.historyStart);
  const range = (column = "timestamp", from = start) => `${column} >= ${from} AND ${column} < ${end}`;
  const focus = `(${paths.map(path => { const rule = pathPattern(path); return `(${rule.host ? `properties.$host = ${literal(rule.host)} AND ` : ""}match(cutQueryStringAndFragment(properties.$pathname), ${literal(rule.pattern)}))`; }).join(" OR ")})`;
  // Group the same surface across IDs before ranking it. Keep raw paths in
  // scope predicates and candidate evidence so the handoff can validate them.
  const surface = "replaceRegexpAll(replaceRegexpAll(cutQueryStringAndFragment(properties.$pathname), '[0-9a-fA-F-]{8,}', ':id'), '[0-9]+', ':id')";
  const sessionFocus = from => `toString(session_id) IN (SELECT toString(properties.$session_id) FROM events WHERE ${range("timestamp", from)} AND properties.$session_id IS NOT NULL AND ${focus})`;
  const checks = new Set(options.checks), queries = [];
  const add = (id, title, sql) => queries.push({ id, title, sql });
  const signalEvents = [checks.has("clicks") && "'$rageclick', '$dead_click'", checks.has("errors") && "'$exception'"].filter(Boolean).join(", ");
  const focusedSessions = `SELECT toString(properties.$session_id) AS session_id,
groupUniqArray(coalesce(properties.$current_url, properties.$pathname)) AS paths
FROM events WHERE ${range()} AND properties.$session_id IS NOT NULL AND ${focus}
GROUP BY session_id`;

  if (phase === 2) {
    add("session-events", "Events for validated session IDs only", `SELECT event, timestamp, properties.$pathname AS path, properties.$el_text AS el_text, person_id
FROM events
WHERE ${range()} AND properties.$session_id IN ('VALIDATED_SESSION_ID')
ORDER BY timestamp LIMIT 200`);
    if (checks.has("clicks") || checks.has("errors")) add("session-features", "Corroborating features for validated session IDs only", `SELECT session_id, ${[
      checks.has("clicks") && "sum(rage_click_count) AS rage_clicks, sum(dead_click_count) AS dead_clicks",
      checks.has("errors") && "sum(console_error_after_click_count) AS errors_after_click, sum(network_failed_request_count) AS failed_requests, sum(quick_back_count) AS quick_backs",
    ].filter(Boolean).join(", ")}
FROM posthog.session_replay_features
WHERE ${range("min_first_timestamp")} AND session_id IN ('VALIDATED_SESSION_ID')
GROUP BY session_id`);
    return queries;
  }

  add("traffic", "Traffic baseline on the selected paths", `SELECT toStartOfDay(toTimeZone(timestamp, 'UTC')) AS day, count() AS pageviews,
uniq(properties.$session_id) AS sessions, uniq(person_id) AS persons
FROM events WHERE event = '$pageview' AND ${range("timestamp", baseline)} AND ${focus}
GROUP BY day ORDER BY day`);
  if (checks.has("clicks")) add("clicks", "Rage and dead clicks, selected period vs previous period", `SELECT properties.$host AS host, ${surface} AS path, event,
countIf(timestamp >= ${start}) AS signals_current, countIf(timestamp < ${start}) AS signals_baseline,
uniqIf(properties.$session_id, timestamp >= ${start}) AS sessions_current,
uniqIf(person_id, timestamp >= ${start}) AS persons_current
FROM events WHERE event IN ('$rageclick', '$dead_click') AND ${range("timestamp", baseline)} AND ${focus}
GROUP BY host, path, event ORDER BY signals_current DESC LIMIT 50`);
  if (checks.has("errors")) {
    add("exceptions", "Exceptions, selected period vs previous period", `SELECT properties.$host AS host, ${surface} AS path,
countIf(timestamp >= ${start}) AS errors_current, countIf(timestamp < ${start}) AS errors_baseline,
uniqIf(properties.$session_id, timestamp >= ${start}) AS sessions_current,
uniqIf(person_id, timestamp >= ${start}) AS persons_current
FROM events WHERE event = '$exception' AND ${range("timestamp", baseline)} AND ${focus}
GROUP BY host, path ORDER BY errors_current DESC LIMIT 50`);
    add("broken-sessions", "Failed requests and errors after clicks, per recorded session", `SELECT session_id,
sum(console_error_after_click_count) AS errors_after_click,
sum(network_failed_request_count) AS failed_requests,
min(min_first_timestamp) AS session_started_at
FROM posthog.session_replay_features
WHERE ${range("min_first_timestamp", baseline)} AND ${sessionFocus(baseline)}
GROUP BY session_id HAVING errors_after_click > 0 OR failed_requests > 0
ORDER BY errors_after_click DESC LIMIT 400`);
  }
  if (checks.has("coverage")) {
    add("capture-presence", "Recording presence, with disclosed diagnostic history", `SELECT uniqIf(session_id, min_first_timestamp >= ${start}) AS recordings_current,
uniqIf(session_id, min_first_timestamp >= ${baseline} AND min_first_timestamp < ${start}) AS recordings_baseline,
uniq(session_id) AS recordings_history
FROM raw_session_replay_events
WHERE ${range("min_first_timestamp", history)} AND ${sessionFocus(history)}`);
    add("capture-ratio", "Recording coverage, including days with zero recordings", `SELECT t.day AS day, t.event_sessions, coalesce(r.recorded_sessions, 0) AS recorded_sessions,
round(coalesce(r.recorded_sessions, 0) / t.event_sessions, 4) AS capture_ratio
FROM (
 SELECT toStartOfDay(toTimeZone(timestamp, 'UTC')) AS day, uniq(properties.$session_id) AS event_sessions
 FROM events WHERE event = '$pageview' AND properties.$session_id IS NOT NULL AND ${range("timestamp", baseline)} AND ${focus}
 GROUP BY day
) t LEFT JOIN (
 SELECT toStartOfDay(toTimeZone(min_first_timestamp, 'UTC')) AS day, uniq(session_id) AS recorded_sessions
 FROM raw_session_replay_events WHERE ${range("min_first_timestamp", baseline)} AND ${sessionFocus(baseline)}
 GROUP BY day
) r ON r.day = t.day ORDER BY day`);
  }
  if (checks.has("replay")) add("replay-signals", "Existing replay analysis, selected period vs previous period", `SELECT properties.scanner_id AS scanner_id,
argMax(properties.scanner_name, timestamp) AS scanner,
countIf(timestamp >= ${start}) AS observations_current,
countIf(timestamp >= ${baseline} AND timestamp < ${start}) AS observations_baseline,
uniqIf(properties.session_id, timestamp >= ${start}) AS sessions_current
FROM events WHERE event = '$recording_observed' AND ${range("timestamp", history)}
AND (toString(properties.session_id) IN (SELECT toString(properties.$session_id) FROM events WHERE ${range("timestamp", history)} AND ${focus}))
GROUP BY scanner_id ORDER BY observations_current DESC`);
  if (signalEvents) add("candidates", "Qualified session signals within the selected period and focus", `SELECT properties.$session_id AS session_id, count() AS signals,
groupUniqArray(coalesce(properties.$current_url, properties.$pathname)) AS paths,
groupUniqArray(event) AS signal_types, max(timestamp) AS last_signal_at
FROM events WHERE ${range()} AND properties.$session_id IS NOT NULL
AND event IN (${signalEvents}) AND ${focus}
GROUP BY session_id ORDER BY signals DESC LIMIT 400`);
  // Synthetic observations carry session_id, not $session_id or a path. Join
  // only after aggregating each side to one row per current, focused session.
  if (checks.has("replay")) add("replay-candidates", "Existing replay signals for current, focused sessions", `SELECT r.session_id, r.signals, p.paths, r.last_signal_at
FROM (
 SELECT toString(properties.session_id) AS session_id, count() AS signals, max(timestamp) AS last_signal_at
 FROM events WHERE event = '$recording_observed' AND ${range()} AND properties.session_id IS NOT NULL
 GROUP BY session_id
) r INNER JOIN (${focusedSessions}) p ON r.session_id = p.session_id
ORDER BY r.signals DESC LIMIT 400`);
  if (checks.has("errors")) add("feature-candidates", "Recorded failures for current, focused sessions", `SELECT r.session_id, r.signals, p.paths, r.last_signal_at
FROM (
 SELECT toString(session_id) AS session_id,
 sum(console_error_after_click_count) + sum(network_failed_request_count) AS signals,
 max(min_first_timestamp) AS last_signal_at
 FROM posthog.session_replay_features WHERE ${range("min_first_timestamp")}
 GROUP BY session_id HAVING signals > 0
) r INNER JOIN (${focusedSessions}) p ON r.session_id = p.session_id
ORDER BY r.signals DESC LIMIT 400`);
  return queries;
}

export function queryMarkdown(scope, phase) {
  return scopedQueries(scope, phase).map(row => `## ${row.title}\n\n\`\`\`sql\n${row.sql}\n\`\`\``).join("\n\n");
}
