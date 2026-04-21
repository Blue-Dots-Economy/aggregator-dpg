# P-12 cache package — features

---

## F-12.1 `CacheService` interface

**AC**
- [ ] Interface: `get<T>(key)`, `set<T>(key, value, { ttlSec })`, `del(key)`, `incr(key, by?)`, `ttl(key)`
- [ ] Keys namespaced by caller-provided prefix; builder helper available
- [ ] `./memory` impl for tests

**Tasks**
- [ ] T-12.1.1 Interface
- [ ] T-12.1.2 Memory impl

---

## F-12.2 Redis impl (`./redis`)

**AC**
- [ ] Uses `ioredis`; connection URL from config
- [ ] JSON values serialised via `shared-primitives` helper
- [ ] Metrics: cache-hit ratio exported

**Tasks**
- [ ] T-12.2.1 Redis client wrapper
- [ ] T-12.2.2 Metrics

---

## F-12.3 Key schemes + TTL conventions documented

**AC**
- [ ] `docs/cache.md` documents: key prefix per package, TTL guidance per use case (rate limits 60 s, upstream lookup 60–300 s, SPS results 30–60 s)
- [ ] Every `cache.set` call in the repo uses a helper that enforces a prefix

**Tasks**
- [ ] T-12.3.1 Doc
- [ ] T-12.3.2 Prefix helper + lint rule
