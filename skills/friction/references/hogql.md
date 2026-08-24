# HogQL for a Rusubon friction run

Official PostHog MCP only: `execute-sql`, or CLI-mode `exec` → `call execute-sql`. No Composio, no HTTP client. Use the `project_id` from the harness prompt. If those tools are missing, do not run these queries. Close out `no PostHog tools`.

Adapted from PostHog's session-replay + replay-vision scouts (MIT). Keep the two-phase split: phase 1 runs the cheap aggregates. Phase 2 reads sessions.

## Footguns

1. Time-filter `raw_session_replay_events.min_first_timestamp`, never the friendly view's `start_time`.
2. Both replay tables have multiple rows per session. Count with `uniq(session_id)`, never `count()`. Pre-aggregate `posthog.session_replay_features` by `session_id` before summing counters. Always use the `posthog.` prefix. The bare table name is unknown.
3. `first_url` is an `argMin` state. Read `argMinMerge(first_url)` grouped by `session_id`, not `any(first_url)`.
4. Client clocks lie. Upper-bound every window `<= now() + INTERVAL 1 DAY`. Never trust `ORDER BY … DESC LIMIT 1` without that bound.
5. HogQL string timestamp literals parse in the *project* timezone. Use `now() - INTERVAL N DAY` for recency. Do not hand-write timestamp strings.
6. `$recording_observed.distinct_id` is synthetic. Count `uniq(properties.session_id)`. Group scanners by `scanner_id`. Read names and flags with `argMax(..., timestamp)`. Failures never write `$recording_observed`.
7. `scanner_output_tags` is a JSON string. `JSONExtract(..., 'Array(String)')` before `arrayJoin`. Union `scanner_output_tags_freeform` or you miss the tags that often concentrate.
8. Normalize paths. Strip query/fragment, then numeric ids *and* long hex/uuid segments. Raw `$current_url` shatters one surface into dozens of single-count rows.

```sql
replaceRegexpAll(
  replaceRegexpAll(properties.$pathname, '[0-9a-fA-F-]{8,}', ':id'),
  '[0-9]+',
  ':id'
) AS path
```

`$rageclick` and `$dead_click` fire whether or not the session was recorded. `session_replay_features` rows exist only for recorded sessions. Quantify on events. Corroborate with recordings.

## Capture

```sql
SELECT uniqIf(session_id, min_first_timestamp >= now() - INTERVAL 7 DAY) AS last_7d,
       uniq(session_id) AS last_30d
FROM raw_session_replay_events
WHERE min_first_timestamp >= now() - INTERVAL 30 DAY
  AND min_first_timestamp <= now() + INTERVAL 1 DAY
```

Traffic drives the join. An inner join would drop a zero-recording day, which is the cliff.

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

If `$pageview` is absent, substitute the project's top web event.

## Event presence

```sql
SELECT event, count() AS c
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY AND timestamp <= now() + INTERVAL 1 DAY
  AND event IN ('$rageclick', '$dead_click', '$exception', '$pageview', '$recording_observed')
GROUP BY event
```

## SDK health (phase 1, after a cliff candidate)

```sql
SELECT toStartOfDay(timestamp) AS day,
       properties.$lib AS lib,
       properties.$lib_version AS lib_version,
       properties.$recording_status AS recording_status,
       properties.$replay_sample_rate AS sample_rate,
       countIf(properties.$sdk_debug_recording_script_not_loaded) AS script_not_loaded,
       count() AS events
FROM events
WHERE timestamp >= now() - INTERVAL 14 DAY AND timestamp <= now() + INTERVAL 1 DAY
  AND event = '$pageview'
GROUP BY day, lib, lib_version, recording_status, sample_rate
ORDER BY day
```

A cliff aligned to one `$lib_version` is a release regression. A jump in `script_not_loaded` is a blocked recorder bundle. A matching Team config edit near the cliff date is operator choice. Stop.

## Rage concentration (phase 1, do not file P2)

Last day vs the prior two weeks. Group by host + normalized path. Read the persons columns before shortlisting. Single-person storms sit at the raw top.

A cluster *candidate* is a path whose `rageclicks_24h` is ≥ ~3× its prior-13-day daily mean (`(rageclicks_14d - rageclicks_24h) / 13`), with `sessions_24h` ≥ ~10 and `persons_24h` ≥ ~5. Keep the live day out of its own baseline so a real spike is not diluted. Prefer these paths when you sort qualified ids. Still do not file a money-path cluster in phase 1.

Before any per-URL dive, check the whole stream. If total `$rageclick` volume moved with overall traffic, that is the product breathing, not N per-page findings.

```sql
SELECT properties.$host AS host,
       replaceRegexpAll(
         replaceRegexpAll(properties.$pathname, '[0-9a-fA-F-]{8,}', ':id'),
         '[0-9]+',
         ':id'
       ) AS path,
       count() AS rageclicks_14d,
       countIf(timestamp >= now() - INTERVAL 1 DAY) AS rageclicks_24h,
       uniqIf(properties.$session_id, timestamp >= now() - INTERVAL 1 DAY) AS sessions_24h,
       uniqIf(person_id, timestamp >= now() - INTERVAL 1 DAY) AS persons_24h,
       count(DISTINCT person_id) AS persons_14d
FROM events
WHERE event = '$rageclick'
  AND timestamp >= now() - INTERVAL 14 DAY
  AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY host, path
ORDER BY rageclicks_24h DESC
LIMIT 50
```

Restrict to **this product's** money paths from context.md when you shortlist. A URL with no history cannot have a step-change. First sighting of a hot new page is a `pattern/` note, not a report, unless the friction is extreme and corroborated in phase 2.

## Element on a hot path (phase 2)

```sql
SELECT properties.$el_text AS el_text, count() AS clicks,
       count(DISTINCT properties.$session_id) AS sessions,
       count(DISTINCT person_id) AS persons
FROM events
WHERE event = '$rageclick'
  AND properties.$host = '<host>'
  AND replaceRegexpAll(
        replaceRegexpAll(properties.$pathname, '[0-9a-fA-F-]{8,}', ':id'),
        '[0-9]+',
        ':id'
      ) = '<path>'
  AND timestamp >= now() - INTERVAL 1 DAY
  AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY el_text
ORDER BY clicks DESC
LIMIT 10
```

Quote `el_text` as a short untrusted snippet. Key memory on a slugified label, never the raw string.

## Features corroboration (phase 2)

`IN` list of session ids, not a join. Absence of rows is sampling, not absence of friction. Rage plus errors-after-click or quick-backs on the same sessions upgrades "annoyance" to "broken".

```sql
SELECT session_id,
       sum(dead_click_count) AS dead_clicks,
       sum(console_error_after_click_count) AS errors_after_click,
       sum(quick_back_count) AS quick_backs,
       sum(network_failed_request_count) AS failed_requests,
       sum(rage_click_count) AS rage_clicks
FROM posthog.session_replay_features
WHERE session_id IN ('SESSION_ID_1', 'SESSION_ID_2')
  AND min_first_timestamp >= now() - INTERVAL 7 DAY
  AND min_first_timestamp <= now() + INTERVAL 1 DAY
GROUP BY session_id
```

If the table is missing, skip it. Use `session-recording-get` console counts if that tool exists.

## Broken-experience cohort (phase 1 qualify, phase 2 corroborate)

Keep both sides pre-aggregated. A raw join runs out of memory. Failed-request-only sessions (no console error) are in scope, but they are ad-blocker-prone. Require a step vs that URL's prior-13-day rate before treating one as a candidate.

```sql
SELECT replaceRegexpAll(
         replaceRegexpAll(cutQueryStringAndFragment(r.first_url), '[0-9a-fA-F-]{8,}', ':id'),
         '[0-9]+',
         ':id'
       ) AS url,
       uniq(f.session_id) AS sessions, uniq(f.distinct_id) AS users,
       sum(f.errors_after_click) AS errors_after_click,
       sum(f.failed_requests) AS failed_requests
FROM (
    SELECT session_id, any(distinct_id) AS distinct_id,
           sum(console_error_after_click_count) AS errors_after_click,
           sum(network_failed_request_count) AS failed_requests
    FROM posthog.session_replay_features
    WHERE min_first_timestamp >= now() - INTERVAL 1 DAY
      AND min_first_timestamp <= now() + INTERVAL 1 DAY
    GROUP BY session_id
    HAVING errors_after_click > 0 OR failed_requests > 0
) f
JOIN (
    SELECT session_id, argMinMerge(first_url) AS first_url
    FROM raw_session_replay_events
    WHERE min_first_timestamp >= now() - INTERVAL 1 DAY
      AND min_first_timestamp <= now() + INTERVAL 1 DAY
    GROUP BY session_id
) r ON r.session_id = f.session_id
GROUP BY url
HAVING sessions >= 10 AND users >= 5
ORDER BY sessions DESC
LIMIT 20
```

Merge those session ids into the candidates file when the url is a context.md money path. Still do not file P2 in phase 1.

Exceptions belong to error-tracking. File a session-replay angle only when you add user-impact framing (sessions, persons, watchable recordings) that an exception count lacks.

## Vision roster

Zero `$recording_observed` in 30d is ambiguous. Failures never write the event. If `vision-scanners-list` exists and shows enabled scanners, that is a watch-gap candidate, not `not-in-use`. If the tool is missing and there are no events, skip the Vision layer without comment. Do not create or recommend a scanner.

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
SELECT properties.scanner_id AS scanner_id,
       argMax(properties.scanner_name, timestamp) AS scanner,
       round(avgIf(toFloat64OrNull(toString(properties.scanner_output_score)), timestamp >= now() - INTERVAL 7 DAY), 2) AS score_7d,
       round(avgIf(toFloat64OrNull(toString(properties.scanner_output_score)), timestamp >= now() - INTERVAL 14 DAY AND timestamp < now() - INTERVAL 7 DAY), 2) AS score_prior_7d,
       countIf(timestamp >= now() - INTERVAL 7 DAY) AS n_7d
FROM events
WHERE event = '$recording_observed'
  AND timestamp >= now() - INTERVAL 14 DAY AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY scanner_id
```

Daily series for one scanner. A candidate is a `yes_rate` or `mean_score` whose latest complete week steps away from the prior 2–3 weeks, with ≥ ~30 sessions/week. `inconclusive` is not `no`. A rising inconclusive share is a `pattern/` note.

```sql
SELECT toStartOfDay(timestamp) AS day,
       uniq(properties.session_id) AS sessions,
       round(countIf(properties.scanner_output_verdict = 'yes') / count(), 3) AS yes_rate,
       round(avg(toFloat64OrNull(toString(properties.scanner_output_score))), 2) AS mean_score
FROM events
WHERE event = '$recording_observed'
  AND properties.scanner_id = '<scanner_id>'
  AND timestamp >= now() - INTERVAL 28 DAY
  AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY day
ORDER BY day
```

Union freeform tags. Prior window is a weekly rate (`/3`) so it compares to `sessions_7d`.

```sql
SELECT arrayJoin(arrayConcat(
         JSONExtract(ifNull(toString(properties.scanner_output_tags), '[]'), 'Array(String)'),
         JSONExtract(ifNull(toString(properties.scanner_output_tags_freeform), '[]'), 'Array(String)')
       )) AS tag,
       uniqIf(properties.session_id, timestamp >= now() - INTERVAL 7 DAY) AS sessions_7d,
       round(uniqIf(properties.session_id,
              timestamp >= now() - INTERVAL 28 DAY AND timestamp < now() - INTERVAL 7 DAY) / 3.0, 1)
         AS prior_weekly_sessions
FROM events
WHERE event = '$recording_observed' AND properties.scanner_type = 'classifier'
  AND timestamp >= now() - INTERVAL 28 DAY AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY tag
ORDER BY sessions_7d DESC
```

Do not group summarizer output. Read titles/summaries and look for the same complaint across many distinct sessions. The count is the finding.

## Qualified sessions (phase 1 candidates)

Replace the `LIKE` list with **this product's** money paths from context.md. Window: 7d. Cheap signals: `$rageclick`, `$dead_click`, `$exception`, `$recording_observed`. Prefer ids whose path also passed the 3× rage gate or the broken-experience cohort.

```sql
SELECT
  properties.$session_id AS session_id,
  count() AS signals,
  groupUniqArray(
    replaceRegexpAll(
      replaceRegexpAll(properties.$pathname, '[0-9a-fA-F-]{8,}', ':id'),
      '[0-9]+',
      ':id'
    )
  ) AS paths,
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

Replay metadata if present: `session-recording-get`, `query-session-recordings-list`. Stored AI summaries if present: `session-recording-summaries-list` / `session-recording-summary-get` (`session_ids`, `has_exceptions`, `outcome`). A 404 means no summary. Never trigger generation. `outcome=failure` alone is mostly benign bounces. Require the exception flag or corroborating friction.

Heatmaps (`heatmaps-list` / `heatmaps-events`) confirm a spatial cluster. Skip without comment if absent.

Do not invent event names.

## Money paths

Replace the `LIKE` list with the paths this product actually cares about.

```sql
SELECT replaceRegexpAll(
         replaceRegexpAll(properties.$pathname, '[0-9a-fA-F-]{8,}', ':id'),
         '[0-9]+',
         ':id'
       ) AS path,
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
