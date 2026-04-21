# P-11 queue package — features

---

## F-11.1 `QueueService` interface + typed job registry

**AC**
- [ ] Interface: `register<JName, JPayload>(name, { handler, retry, backoff, concurrency })`, `enqueue(name, payload, opts?)`, `schedule(name, payload, cron)`
- [ ] Job names are a string-literal union; payloads typed per job
- [ ] `./testing` impl executes jobs synchronously for integration tests

**Tasks**
- [ ] T-11.1.1 Interface + registry types
- [ ] T-11.1.2 Testing impl

---

## F-11.2 BullMQ impl

**AC**
- [ ] `./bullmq` uses Redis connection from config (`queue.redisUrl`, falls back to `cache.redisUrl`)
- [ ] Each registered job becomes a BullMQ queue + worker
- [ ] Graceful shutdown drains in-flight jobs within `shutdownTimeoutMs`

**Tasks**
- [ ] T-11.2.1 BullMQ wiring
- [ ] T-11.2.2 Graceful shutdown
- [ ] T-11.2.3 Metrics (depth, age, processed/failed)

---

## F-11.3 Worker entrypoints

**AC**
- [ ] `apps/api/workers.ts` and (optionally) a separate worker process entrypoint
- [ ] Ops can scale workers independently of the API

**Tasks**
- [ ] T-11.3.1 In-process worker entry
- [ ] T-11.3.2 Standalone worker Dockerfile (optional, under P-01.6)

---

## F-11.4 DLQ + retry policy

**AC**
- [ ] Per-job retry count + backoff (exponential jitter, max 5)
- [ ] Terminal failures move to a DLQ queue; alert fires on DLQ depth > 10

**Tasks**
- [ ] T-11.4.1 Per-job policy schema
- [ ] T-11.4.2 DLQ routing
- [ ] T-11.4.3 Alert rule (in P-13)
