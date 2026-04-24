# EXPLAIN Baselines

Captured plans for the five hot-path queries, verifying that the indexes added in F-04.7 are used as expected.

## How to reproduce

```bash
# Start Postgres
docker compose up -d

# Apply migrations
DATABASE_URL=postgres://aggregator:aggregator@127.0.0.1:5433/aggregator_dev \
  pnpm --filter @aggregator-dpg/db migrate:up

# Seed baseline data
PGPASSWORD=aggregator psql -h 127.0.0.1 -p 5433 -U aggregator -d aggregator_dev \
  -f packages/db/scripts/seed-explain.sql

# Re-capture EXPLAIN output
# (see queries below; update AGG_ID and ENTITY_ID from seed output)
```

## Dataset sizes

| Table                     | Rows   |
| ------------------------- | ------ |
| aggregator_profile_schema | 3      |
| aggregator_profile        | 10     |
| onboarding_link           | 1,000  |
| bulk_upload_batch         | 100    |
| audit_log                 | 50,000 |
| export_job                | 10,000 |
| registration_request      | 200    |

Captured on Postgres 16.13 with default `shared_buffers` and `work_mem`. Dates: 2026-04-24.

---

## Q1 — `AggregatorProfileSchemaRepo.findActive()`

Returns the newest schema where `active = true`. One row read, one row scanned.

```sql
SELECT * FROM aggregator_profile_schema
WHERE active = true
ORDER BY created_at DESC
LIMIT 1;
```

```
Limit  (cost=1.04..1.04 rows=1 width=32) (actual time=0.064..0.065 rows=1 loops=1)
  Buffers: shared hit=4
  ->  Sort  (cost=1.04..1.04 rows=1 width=32) (actual time=0.063..0.064 rows=1 loops=1)
        Sort Key: created_at DESC
        ->  Seq Scan on aggregator_profile_schema  (cost=0.00..1.03 rows=1 width=32) (actual time=0.014..0.014 rows=1 loops=1)
              Filter: active
              Rows Removed by Filter: 2
Execution Time: 0.122 ms
```

**Plan:** Seq Scan (3 total rows — planner correctly skips the partial index).
**Index:** `idx_aggregator_profile_schema_active` (partial, `WHERE active = true`).
**Expectation:** At larger row counts (e.g., 100+ schema versions), planner will switch to Index Scan on the partial index. At production scale (handful of schema versions), Seq Scan is cheaper.

---

## Q2 — `OnboardingLinkRepo.findActiveByAggregator()`

Lists non-revoked onboarding links for one aggregator, newest-first.

```sql
SELECT * FROM onboarding_link
WHERE aggregator_id = $1 AND revoked_at IS NULL
ORDER BY created_at DESC
LIMIT 20;
```

```
Limit  (cost=6.05..6.06 rows=1 width=76) (actual time=0.043..0.043 rows=0 loops=1)
  Buffers: shared hit=5
  ->  Sort  (cost=6.05..6.06 rows=1 width=76)
        Sort Key: created_at DESC
        ->  Index Scan using idx_onboarding_link_active_aggregator on onboarding_link
              (cost=0.28..6.04 rows=1 width=76) (actual time=0.026..0.026 rows=0 loops=1)
              Index Cond: (aggregator_id = '264c...'::uuid)
Execution Time: 0.084 ms
```

**Plan:** Index Scan via `idx_onboarding_link_active_aggregator` (partial, `WHERE revoked_at IS NULL`).
**Used index:** yes — partial + composite `(aggregator_id, created_at DESC)`.
**Rows:** 2 buffer hits; sub-millisecond.

---

## Q3 — `AuditLogRepo.findByAggregator()`

Audit trail listing for one aggregator, newest-first by event time.

```sql
SELECT * FROM audit_log
WHERE aggregator_id = $1
ORDER BY occurred_at DESC
LIMIT 50;
```

```
Limit  (cost=2999.18..2999.31 rows=50 width=144) (actual time=5.626..5.631 rows=50 loops=1)
  Buffers: shared hit=750
  ->  Sort  (cost=2999.18..3121.64 rows=48983 width=144)
        Sort Key: occurred_at DESC
        Sort Method: top-N heapsort  Memory: 31kB
        ->  Seq Scan on audit_log  (cost=0.00..1372.00 rows=48983 width=144)
              Filter: (aggregator_id = '264c...'::uuid)
              Rows Removed by Filter: 1000
Execution Time: 5.653 ms
```

**Plan:** Seq Scan (skews to one aggregator holding ~49k of 50k rows in the seed — 98% selectivity).
**Index:** `idx_audit_log_aggregator_occurred` present but correctly skipped by the planner because almost every row matches the filter. In production with evenly distributed aggregators (e.g., 50+ aggregators × 1k events each), selectivity drops to ~2 % and the planner will switch to Index Scan.
**Re-evaluate:** when `pg_stats.n_distinct` on `aggregator_id` grows beyond ~20, re-capture this baseline.

---

## Q4 — `AuditLogRepo.findByEntity()`

Audit records for a specific entity instance (e.g., one onboarding link).

```sql
SELECT * FROM audit_log
WHERE entity = 'onboarding_link' AND entity_id = $1
ORDER BY occurred_at DESC
LIMIT 50;
```

```
Limit  (cost=117.27..117.36 rows=33 width=144) (actual time=0.133..0.135 rows=37 loops=1)
  Buffers: shared hit=43
  ->  Sort  (cost=117.27..117.36 rows=33 width=144)
        Sort Key: occurred_at DESC
        ->  Bitmap Heap Scan on audit_log  (cost=4.75..116.44 rows=33 width=144)
              Recheck Cond: ((entity = 'onboarding_link'::text) AND (entity_id = 'entity-12'::text))
              Heap Blocks: exact=37
              ->  Bitmap Index Scan on idx_audit_log_entity_occurred
                    Index Cond: ((entity = 'onboarding_link'::text) AND (entity_id = 'entity-12'::text))
Execution Time: 0.158 ms
```

**Plan:** Bitmap Index Scan → Bitmap Heap Scan → Sort.
**Used index:** yes — `idx_audit_log_entity_occurred` on `(entity, entity_id, occurred_at DESC)`.
**Rows:** 37 matches from 50k rows; ~3 index pages + 37 heap pages; sub-millisecond.

---

## Q5 — `ExportJobRepo.findByStatus('pending')`

Worker-polling query: pending export jobs in arrival order.

```sql
SELECT * FROM export_job
WHERE status = 'pending'
ORDER BY created_at DESC
LIMIT 20;
```

```
Limit  (cost=49.61..49.66 rows=20 width=81) (actual time=0.852..0.854 rows=20 loops=1)
  Buffers: shared hit=155
  ->  Sort  (cost=49.61..51.05 rows=575 width=81)
        Sort Key: created_at DESC
        Sort Method: top-N heapsort  Memory: 27kB
        ->  Index Scan using idx_export_job_pending on export_job
              (cost=0.28..34.31 rows=575 width=81) (actual time=0.035..0.798 rows=575 loops=1)
Execution Time: 0.870 ms
```

**Plan:** Index Scan via `idx_export_job_pending` (partial, `WHERE status = 'pending'`).
**Used index:** yes — partial index reads only the 575 pending rows out of 10k total.
**Rows:** 155 buffer hits; sub-millisecond.

---

## Summary

| Query                    | Index used                              | Seq vs Index | Exec time | Notes                            |
| ------------------------ | --------------------------------------- | ------------ | --------- | -------------------------------- |
| findActive (schema)      | `idx_aggregator_profile_schema_active`  | Seq (3 rows) | 0.12 ms   | Planner correct at small scale   |
| findActiveByAggregator   | `idx_onboarding_link_active_aggregator` | Index        | 0.08 ms   | Partial index hit                |
| findByAggregator (audit) | `idx_audit_log_aggregator_occurred`     | Seq (skew)   | 5.65 ms   | Flips to Index at real fan-out   |
| findByEntity (audit)     | `idx_audit_log_entity_occurred`         | Bitmap Index | 0.16 ms   | Composite (entity, entity_id, …) |
| findByStatus (export)    | `idx_export_job_pending`                | Index        | 0.87 ms   | Partial index on pending         |

**Next review triggers:**

- `audit_log` > 500k rows, or > 50 distinct aggregators → re-capture Q3.
- `aggregator_profile_schema` > 100 rows → re-capture Q1.
- Any query added to a hot path outside these five → extend this doc.
