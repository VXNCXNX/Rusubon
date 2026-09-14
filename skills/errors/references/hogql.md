# HogQL for a Rusubon errors run

Official PostHog MCP only: `execute-sql`, or CLI-mode `exec` → `call execute-sql`. Use the `project_id` from the harness prompt. Missing tools → close out `no PostHog tools`.

Adapted from PostHog's error-tracking scout (MIT). Phase 1 runs the cheap aggregates. Phase 2 reads sessions.

## Footguns

1. Quantify `$exception` on events. `session_replay_features` exists only for recorded sessions.
2. Pre-aggregate `posthog.session_replay_features` by `session_id` before summing counters. Always use the `posthog.` prefix.
3. Normalize paths. Strip query/fragment, then numeric ids and long hex/uuid segments.
4. HogQL string timestamp literals parse in the project timezone. Prefer the harness query plan's `toDateTime(<unix>)` bounds. Do not hand-write timestamp strings in scoped runs.
5. `$exception_type` / `$exception_message` may be absent. Confirm with `read-data-schema`. If the type column is missing, group by path only.
6. Failed-request-only rows are ad-blocker-prone. Require a step vs that URL's prior window, or an `$exception` / error-after-click corroboration.

```sql
replaceRegexpAll(
  replaceRegexpAll(cutQueryStringAndFragment(properties.$pathname), '[0-9a-fA-F-]{8,}', ':id'),
  '[0-9]+',
  ':id'
) AS path
```

## Event presence

```sql
SELECT event, count() AS c
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY AND timestamp <= now() + INTERVAL 1 DAY
  AND event IN ('$exception', '$pageview')
GROUP BY event
```

Zero `$exception` in 30d, after schema confirms the event exists, is quiet — not a report. If the event is unknown, write `not-in-use/exceptions`.

## Exception types (phase 1)

Prefer the harness query plan when a scope is present. Unscoped follow-up:

```sql
SELECT properties.$exception_type AS exception_type,
       replaceRegexpAll(replaceRegexpAll(cutQueryStringAndFragment(properties.$pathname), '[0-9a-fA-F-]{8,}', ':id'), '[0-9]+', ':id') AS path,
       count() AS errors,
       uniq(properties.$session_id) AS sessions,
       uniq(person_id) AS persons
FROM events
WHERE event = '$exception'
  AND timestamp >= now() - INTERVAL 7 DAY
  AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY exception_type, path
ORDER BY errors DESC
LIMIT 50
```
