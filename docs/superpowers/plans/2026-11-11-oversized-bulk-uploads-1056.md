# Oversized bulk uploads (#1056) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Storage refuses a bulk CSV over `BULK_UPLOAD_MAX_BYTES` at upload, the api deletes every file it rejects at `/start`, the web app shows the size error before sending any bytes, and the errors download answers "no longer available" once the file is gone.

**Architecture:** Builds on the #1055 package. The S3 provider switches upload instructions from a signed PUT to a signed POST policy with `content-length-range`; the web app already follows instructions (#1055 Task 4). The api uses the `delete` and `stat` operations. Deploy only after bluedots-automation#321 (CORS `POST` + `bulk-uploads/` expiry) is applied on the instance.

**Tech Stack:** As #1055, plus `@aws-sdk/s3-presigned-post`; next-intl messages (en, hi, kn).

**Spec:** `docs/superpowers/specs/2026-11-03-object-storage-interface-design.md` section 7 and item (b) in section 8; plan `docs/superpowers/plans/2026-11-11-object-storage-interface-1055.md` for the interfaces used here.

## Global Constraints

- All Global Constraints of the #1055 plan apply.
- `BULK_UPLOAD_MAX_BYTES` (default 10 485 760) is the limit everywhere: signed policy, `/start` check, browser check. A file of exactly the limit is accepted.
- No new API and no new response field. The browser reads `max_bytes` from the existing create response.
- The POST policy pins `Content-Type` to `text/csv` and the key to the reserved one.
- Every user-facing string exists in en, hi and kn (`apps/web/src/__tests__/i18n/messages.test.ts` enforces it).

## PR

> Executed as one PR per block (`.claude/rules/pull-requests.md`); the actual stack is in section 8 of the design. The grouping below is the original proposal.

One draft PR, `fix/1056-oversized-bulk-uploads`, based on #1055 PR 3, 16 files (limit 18). Title `fix(bulk-upload): #1056 refuse oversized CSVs at upload and delete rejected files`. Body: `Closes #1056`, and that it must deploy only after bluedots-automation#321 is applied on the instance. It changes UI: after opening, list the screen for screenshots (desktop and 390×844).

## Review Focus

1. A file of exactly `max_bytes` must upload and process; `max_bytes + 1` is refused — Task 1 (contract suite).
2. If deleting a rejected file fails, the coordinator must still get the size error, not a 500 — Task 2.
3. An empty file (0 bytes) must be rejected at `/start` and deleted, like an oversized one — Task 2.
4. A coordinator on a page loaded before the deploy (no browser size check yet) sends an oversized file; storage refuses it and the neutral `File upload failed (400)` from #1055 Task 4 shows, with nothing stored — Task 1 contract suite covers the refusal; no new test.
5. Downloading errors for an upload whose errors file has expired must answer 404 with "no longer available", never sign a link to a missing file — Task 2.

---

### Task 1: S3 refuses oversized uploads (POST policy)

**Files:**

- Modify: `packages/object-storage/src/s3.ts` (`createUpload`), `src/contract-suite.ts`, `src/testing.ts`, `src/__tests__/s3.test.ts` (unit and MinIO run), `src/__tests__/index.test.ts` (fake run), `packages/object-storage/package.json` (add `@aws-sdk/s3-presigned-post` `^3.1151.0`), `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `ObjectStorageBase.createUpload(input: CreateUploadInput)` from #1055.
- Changes: the contract-suite `make()` result gains `upload(instructions: UploadInstructions, bytes: Buffer): Promise<number>` (HTTP-like status); the fake records `maxBytes` per issued instruction and its `upload` returns 400 when the bytes exceed it, 204 otherwise.
- S3 `createUpload` returns `{ method: 'POST', url, headers: {}, formFields: fields, expiresAt }` from `createPresignedPost(presignerClient, { Bucket, Key, Conditions: [['content-length-range', 0, maxBytes], ['eq', '$Content-Type', contentType]], Fields: { 'Content-Type': contentType }, Expires: expiresInSeconds })`.

- [ ] **Step 1: Write failing tests.** Contract suite: upload of exactly `maxBytes` → 2xx and `stat.size === maxBytes`; `maxBytes + 1` → 4xx and `stat` → `null`. `s3.test.ts`: `createUpload` returns `method 'POST'`, `formFields['Content-Type'] === 'text/csv'`, `formFields.key === 'bulk-uploads/a/u/raw.csv'`, URL host from `S3_PUBLIC_ENDPOINT`, and the policy (base64 `formFields.Policy`) contains `["content-length-range",0,10485760]`. The MinIO run's `upload` posts a `FormData` (fields, then `file`) with `fetch`.
- [ ] **Step 2:** Run the package tests → FAIL.
- [ ] **Step 3:** Implement the POST policy in `s3.ts` and the fake's size check.
- [ ] **Step 4:** Unit tests PASS; with local MinIO the contract suite PASSES for both fake and MinIO (MinIO's default CORS allows POST locally).
- [ ] **Step 5:** Commit `fix(object-storage): #1056 sign bulk uploads as a POST policy that caps the file size`.

### Task 2: api deletes rejected files and reports expired errors files

**Files:**

- Modify: `apps/api/src/routes/bulk-uploads.ts` (`/start` size and empty checks; errors download), `apps/api/src/routes/bulk-uploads.test.ts`

**Interfaces:**

- Consumes: `getObjectStorage().delete(ref)`, `.stat(ref)`, `FakeObjectStorage.failNext`.

- [ ] **Step 1: Write failing tests:** `/start` with a seeded object of `BULK_UPLOAD_MAX_BYTES + 1` bytes → 400 "Uploaded CSV is too large" and `fake.read(ref)` is `undefined`; seeded 0-byte object → 400 "Uploaded CSV is empty" and the object is gone; oversized object with `fake.failNext('delete', new UpstreamError('x'))` → still 400 too large, and a `warn` log with `reason: 'rejected_upload_delete_failed'` (Review Focus 2); object of exactly the limit → 200. Errors download for a completed upload whose errors file is not in storage → 404 `NOT_FOUND`, detail `This errors report is no longer available.`, and `createDownloadUrl` not called.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: in `/start`, before throwing the empty or too-large error, call `delete(ref)`; on an error result log `warn` and continue to the same 400. In the errors download, `stat(ref)` before signing; `null` → `NOT_FOUND` with that detail; an error result is thrown (500).
- [ ] **Step 4:** `pnpm --filter @aggregator-dpg/api test -- --pool=forks --maxWorkers=2 src/routes/bulk-uploads.test.ts` → PASS; typecheck clean.
- [ ] **Step 5:** Local check against MinIO: upload `~/Downloads/bulk-upload-25mb.csv` with the browser size check bypassed (curl the POST) → MinIO refuses it, nothing stored; a normal upload still works end to end.
- [ ] **Step 6:** Commit `fix(bulk-upload): #1056 delete files rejected at start and report expired errors files`.

### Task 3: Browser size check

**Files:**

- Modify: `apps/web/src/services/onboarding.service.ts` (`uploadCsv`), `apps/web/src/services/__tests__/onboarding-upload.test.ts`, `apps/web/src/app/(protected)/onboarding/_components/CSVUpload.tsx` (catch block near line 120), `apps/web/src/__tests__/app/(protected)/onboarding/CSVUpload.test.tsx`
- Modify: `apps/web/src/i18n/messages/en.json`, `hi.json`, `kn.json` (`onboarding.csv.too_large`)

**Interfaces:**

- Produces: `export class BulkUploadTooLargeError extends Error { constructor(readonly maxBytes: number) }` in `onboarding.service.ts`; `uploadCsv` throws it after the create call when `file.size > created.max_bytes`, before any upload request.
- Copy (`onboarding.csv.too_large`, ICU `{maxMb}` = `max_bytes / 1048576` rounded to 1 decimal):
  - en: `This file is larger than {maxMb} MB. Upload a smaller file.`
  - hi: `यह फ़ाइल {maxMb} MB से बड़ी है। कोई छोटी फ़ाइल अपलोड करें।` (English: This file is larger than {maxMb} MB. Upload a smaller file.)
  - kn: `ಈ ಫೈಲ್ {maxMb} MB ಗಿಂತ ದೊಡ್ಡದಾಗಿದೆ. ಚಿಕ್ಕ ಫೈಲ್ ಅಪ್‌ಲೋಡ್ ಮಾಡಿ.` (English: This file is larger than {maxMb} MB. Upload a smaller file.)

- [ ] **Step 1: Write failing tests:** service — `max_bytes: 10` and an 11-byte file → rejects with `BulkUploadTooLargeError` (`maxBytes === 10`) and `fetch` is called only for the create request; a 10-byte file uploads. `CSVUpload.test.tsx` — the mutation rejecting with `new BulkUploadTooLargeError(10485760)` shows `This file is larger than 10 MB. Upload a smaller file.` and keeps the picked file chip.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the check and the catch branch (`t('csv.too_large', { maxMb })`); add the three message keys.
- [ ] **Step 4:** `pnpm --filter @aggregator-dpg/web test -- --pool=forks --maxWorkers=2` → PASS (including `messages.test.ts`); typecheck clean.
- [ ] **Step 5:** Browser check, desktop and 390×844: pick `~/Downloads/bulk-upload-25mb.csv` → the error shows at once with no upload request in the Network tab; the message wraps, is not cut off, and the chip stays tappable on mobile; a valid CSV still uploads.
- [ ] **Step 6:** Commit `fix(web): #1056 tell the coordinator a CSV is too large before uploading it`. Push; open the draft PR (base #1055 PR 3). List the changed screen for screenshots (bulk upload page with the size error, desktop and mobile). Check ≤ 18 files.
