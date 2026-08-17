# HogQL for a Rusubon friction run

Official PostHog MCP only: `execute-sql`, or CLI-mode `exec` → `call execute-sql`. No Composio, no HTTP client. Use the `project_id` from the harness prompt. If those tools are missing, do not run these queries — close out `no PostHog tools`.

Footguns (from PostHog's session-replay scout): time-filter `raw_session_replay_events.min_first_timestamp`, never the friendly view's `start_time`. Count sessions with `uniq(session_id)`. Upper-bound every window `<= now() + INTERVAL 1 DAY`. Normalize paths (strip ids). `$recording_observed.distinct_id` is synthetic — count `uniq(properties.session_id)`. Group scanners by `scanner_id`. Failures never write `$recording_observed`.

## Capture

```sql
SELECT uniqIf(session_id, min_first_timestamp >= now() - INTERVAL 7 DAY) AS last_7d,
       uniq(session_id) AS last_30d
FROM raw_session_replay_events
WHERE min_first_timestamp >= now() - INTERVAL 30 DAY
  AND min_first_timestamp <= now() + INTERVAL 1 DAY
```

```sql
SELECT t.day AS day, coalesce(r.recorded_sessions, 0) AS recorded_sessions,
       t.event_sessions AS event_sessions,
       round(coalesce(r.recorded_sessions, 0) / t.event_sessions, 4) AS capture_ratio
FROM (
    SELECT toStartOfDay(timestamp) AS day, uniq(properties.$session_id) AS event_sessions
    FROM events
    WHERE timestamp >= now() - INTERVAL 14 DAY AND timestamp <= now() + INTERVAL 1 DAY
      AND properties.$session_id IS NOT NULL AND event = '$pageview'
    GROUP BY day
) t
LEFT JOIN (
    SELECT toStartOfDay(min_first_timestamp) AS day, uniq(session_id) AS recorded_sessions
    FROM raw_session_replay_events
    WHERE min_first_timestamp >= now() - INTERVAL 14 DAY
      AND min_first_timestamp <= now() + INTERVAL 1 DAY
    GROUP BY day
) r ON r.day = t.day
ORDER BY day
```

## Event presence

```sql
SELECT event, count() AS c
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY AND timestamp <= now() + INTERVAL 1 DAY
  AND event IN ('$rageclick', '$dead_click', '$exception', '$pageview', '$recording_observed')
GROUP BY event
```

## Vision roster

```sql
SELECT properties.scanner_id AS scanner_id,
       argMax(properties.scanner_name, timestamp) AS scanner,
       argMax(properties.scanner_type, timestamp) AS type,
       argMax(properties.emits_signals, timestamp) AS emits_signals,
       countIf(timestamp >= now() - INTERVAL 7 DAY) AS obs_7d,
       countIf(timestamp >= now() - INTERVAL 14 DAY AND timestamp < now() - INTERVAL 7 DAY) AS obs_prior_7d,
       uniqIf(properties.session_id, timestamp >= now() - INTERVAL 7 DAY) AS sessions_7d
FROM events
WHERE event = '$recording_observed'
  AND timestamp >= now() - INTERVAL 30 DAY AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY scanner_id
ORDER BY obs_7d DESC
```

## Frustration + intent (pull path)

```sql
SELECT properties.scanner_name AS scanner,
       round(avgIf(toFloat64OrNull(toString(properties.scanner_output_score)), timestamp >= now() - INTERVAL 7 DAY), 2) AS score_7d,
       round(avgIf(toFloat64OrNull(toString(properties.scanner_output_score)), timestamp >= now() - INTERVAL 14 DAY AND timestamp < now() - INTERVAL 7 DAY), 2) AS score_prior_7d,
       countIf(timestamp >= now() - INTERVAL 7 DAY) AS n_7d
FROM events
WHERE event = '$recording_observed'
  AND timestamp >= now() - INTERVAL 14 DAY AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY scanner
```

```sql
SELECT arrayJoin(JSONExtract(ifNull(toString(properties.scanner_output_tags), '[]'), 'Array(String)')) AS tag,
       uniqIf(properties.session_id, timestamp >= now() - INTERVAL 7 DAY) AS sessions_7d,
       uniqIf(properties.session_id, timestamp >= now() - INTERVAL 14 DAY AND timestamp < now() - INTERVAL 7 DAY) AS sessions_prior
FROM events
WHERE event = '$recording_observed' AND properties.scanner_type = 'classifier'
  AND timestamp >= now() - INTERVAL 14 DAY AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY tag
ORDER BY sessions_7d DESC
```

## Qualified sessions (phase 1 candidates)

Replace the `LIKE` list with **this product's** money paths from context.md. Window: 7d. Cheap signals: `$rageclick`, `$dead_click`, `$exception`, `$recording_observed`.

```sql
SELECT
  properties.$session_id AS session_id,
  count() AS signals,
  groupUniqArray(replaceRegexpAll(properties.$pathname, '[0-9a-fA-F-]{8,}', ':id')) AS paths,
  max(timestamp) AS last_signal_at
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY AND timestamp <= now() + INTERVAL 1 DAY
  AND properties.$session_id IS NOT NULL
  AND event IN ('$rageclick', '$dead_click', '$exception', '$recording_observed')
  AND (properties.$pathname LIKE '%/checkout%'
    OR properties.$pathname LIKE '%/pricing%'
    OR properties.$pathname LIKE '%/signup%'
    OR properties.$pathname LIKE '%/billing%')
GROUP BY session_id
ORDER BY signals DESC
LIMIT 400
```

## Session events (phase 2, one id or a small IN list)

```sql
SELECT event, timestamp, properties.$pathname AS path,
       properties.$el_text AS el_text, person_id
FROM events
WHERE properties.$session_id = 'SESSION_ID'
  AND timestamp >= now() - INTERVAL 7 DAY AND timestamp <= now() + INTERVAL 1 DAY
ORDER BY timestamp
LIMIT 200
```

Console / click counts: `session-recording-get` if the MCP has it. Do not invent event names.

## Money paths

Replace the `LIKE` list with the paths this product actually cares about.

```sql
SELECT replaceRegexpAll(properties.$pathname, '[0-9a-fA-F-]{8,}', ':id') AS path,
       count() AS pageviews, uniq(properties.$session_id) AS sessions, uniq(person_id) AS persons
FROM events
WHERE event = '$pageview'
  AND timestamp >= now() - INTERVAL 7 DAY AND timestamp <= now() + INTERVAL 1 DAY
  AND (properties.$pathname LIKE '%/checkout%'
    OR properties.$pathname LIKE '%/pricing%'
    OR properties.$pathname LIKE '%/signup%'
    OR properties.$pathname LIKE '%/billing%')
GROUP BY path
ORDER BY sessions DESC
LIMIT 25
```
