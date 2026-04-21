# P-05 auth package — features

---

## F-05.1 JWT issuer/verifier

**AC**
- [ ] Access JWT (15 min), refresh JWT (7 days, rotating)
- [ ] Signing key loaded from `${JWT_SIGNING_KEY}` via config
- [ ] Verifier enforces issuer/audience claims
- [ ] Clock skew tolerated ≤ 30 s

**Tests:** unit + negative cases (expired, wrong signature, tampered claims).

**Tasks**
- [ ] T-05.1.1 Issuer
- [ ] T-05.1.2 Verifier
- [ ] T-05.1.3 Key rotation doc

---

## F-05.2 OTP generation/verification

**AC**
- [ ] 6-digit numeric OTP, 10-min TTL, single-use
- [ ] Stored hashed (argon2id) in `otp_challenge` table (add migration here or under P-04)
- [ ] Verify is constant-time; 5 failed attempts locks the challenge

**Tasks**
- [ ] T-05.2.1 `otp_challenge` migration
- [ ] T-05.2.2 Generator
- [ ] T-05.2.3 Verifier + attempt counter

---

## F-05.3 `OtpProvider` email impl

**AC**
- [ ] `./otp` submodule binds to `EmailService` to send OTP via template `otp-login`
- [ ] Rendered content honours locale from `features.yaml`

**Tasks**
- [ ] T-05.3.1 Email-OTP adapter
- [ ] T-05.3.2 Template `otp-login`

---

## F-05.4 `OtpProvider` SMS stub

Labels: `needs:decision`

**AC**
- [ ] Interface extension for SMS provider
- [ ] A `noop-sms` impl that throws `NotImplementedError` with a config-flag gate

**Tasks**
- [ ] T-05.4.1 SMS interface
- [ ] T-05.4.2 Noop impl + config flag

---

## F-05.5 Session middleware + aggregator scoping

**AC**
- [ ] Every protected route runs middleware that extracts JWT, verifies, loads session, attaches `session.aggregator_id` to request context
- [ ] Any handler accessing `aggregator_id` from the request body/query is blocked by lint rule
- [ ] 401 on missing/invalid; 403 on scope mismatch

**Tasks**
- [ ] T-05.5.1 Middleware
- [ ] T-05.5.2 Request context type
- [ ] T-05.5.3 ESLint rule forbidding client-supplied `aggregator_id`

---

## F-05.6 Rate limits on OTP endpoints

**AC**
- [ ] `POST /v1/auth/otp/request`: 5/min per email+IP; 20/hour per IP
- [ ] `POST /v1/auth/otp/verify`: 10/min per challenge
- [ ] Counters backed by `CacheService`

**Tasks**
- [ ] T-05.6.1 Rate-limit middleware
- [ ] T-05.6.2 Config keys + defaults

---

## F-05.7 Refresh-token rotation + revocation

**AC**
- [ ] Each refresh issues a new refresh + invalidates the old (one-time use)
- [ ] Revocation store in DB; logout revokes all
- [ ] Reuse of an invalidated refresh triggers session-wide revocation + alert

**Tasks**
- [ ] T-05.7.1 Revocation store migration
- [ ] T-05.7.2 Rotation logic
- [ ] T-05.7.3 Reuse-detection alert hook
