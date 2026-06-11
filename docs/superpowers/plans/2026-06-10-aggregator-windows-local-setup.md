# Cross-platform local setup (native Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer on native Windows (Docker Desktop, no WSL2) run the full aggregator-dpg local stack with the same ergonomics as Mac/Linux, via a single cross-platform Node orchestrator.

**Architecture:** One dependency-free Node script `scripts/stack.mjs` becomes the source of truth for host-side stack operations (setup/up/down/...). Root `package.json` exposes it as `stack:*` pnpm scripts (the cross-platform entrypoint). The `Makefile` keeps its target names but delegates their recipe bodies to the pnpm scripts, so the POSIX-sh logic that previously lived in `env:`/`hosts:`/`up:` exists in exactly one place. OS differences (hosts-file path, `chmod`) are three small `process.platform` branches inside the script.

**Tech Stack:** Node ≥ 24 (`node:*` builtins only — `child_process`, `fs`, `path`, `url`), `node:test` + `node:assert` for unit tests (the script is not a Turbo/Vitest workspace package, so built-in test runner keeps it dependency-free), pnpm scripts, GNU Make (Unix-side alias only), Docker Compose v2.

**Spec:** `docs/superpowers/specs/2026-06-10-aggregator-windows-local-setup-design.md`

---

## File Structure

- **Create `scripts/stack.mjs`** — the orchestrator. Pure helpers (exported, unit-tested) + impure command implementations + a `main()` dispatcher guarded so importing the module for tests does not execute it.
- **Create `scripts/stack.test.mjs`** — `node:test` unit tests for the pure helpers (platform branches, env-source precedence, hosts parsing, command parsing).
- **Modify `package.json`** — add `test:scripts` + `stack:*` scripts.
- **Modify `Makefile`** — repoint `setup`/`up`/`down`/`reset`/`logs`/`ps`/`psql`/`rebuild-web` recipe bodies to `pnpm stack:*`; delete the now-duplicated `env:`/`hosts:` targets; leave Helm/SPI/`mc`/`kc`/`redis-cli` targets untouched (Unix/WSL-only).
- **Modify `QUICKSTART.md`** — add a Windows section, drop the BSD-only `sed -i ''`, repoint `make hosts` troubleshooting to `make setup`.
- **Modify `SETUP.md` and `CLAUDE.md`** — note the `pnpm stack:*` entrypoint and the native-Windows path.

---

## Task 1: Pure helpers in `scripts/stack.mjs` (TDD)

**Files:**

- Create: `scripts/stack.mjs`
- Test: `scripts/stack.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/stack.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostsFilePath,
  shouldChmod,
  chooseEnvSource,
  missingHostEntries,
  windowsHostsInstructions,
  parseCommand,
  UsageError,
  HOST_ENTRIES,
} from './stack.mjs';

test('hostsFilePath returns the Windows path on win32', () => {
  assert.equal(hostsFilePath('win32'), 'C:\\Windows\\System32\\drivers\\etc\\hosts');
});

test('hostsFilePath returns /etc/hosts on unix', () => {
  assert.equal(hostsFilePath('darwin'), '/etc/hosts');
  assert.equal(hostsFilePath('linux'), '/etc/hosts');
});

test('shouldChmod is true on unix, false on windows', () => {
  assert.equal(shouldChmod('darwin'), true);
  assert.equal(shouldChmod('linux'), true);
  assert.equal(shouldChmod('win32'), false);
});

test('chooseEnvSource respects precedence', () => {
  assert.equal(
    chooseEnvSource({ envExists: true, localExists: true, templateExists: true }),
    'skip',
  );
  assert.equal(
    chooseEnvSource({ envExists: false, localExists: true, templateExists: true }),
    'env.local',
  );
  assert.equal(
    chooseEnvSource({ envExists: false, localExists: false, templateExists: true }),
    'env.template',
  );
  assert.equal(
    chooseEnvSource({ envExists: false, localExists: false, templateExists: false }),
    'none',
  );
});

test('missingHostEntries finds absent entries and ignores present ones', () => {
  assert.deepEqual(missingHostEntries(''), HOST_ENTRIES);
  assert.deepEqual(missingHostEntries('127.0.0.1 keycloak\n127.0.0.1 minio\n'), []);
  assert.deepEqual(missingHostEntries('127.0.0.1   keycloak\n'), [['127.0.0.1', 'minio']]);
});

test('missingHostEntries does not partial-match a longer hostname', () => {
  assert.deepEqual(missingHostEntries('127.0.0.1 keycloak2\n127.0.0.1 minio\n'), [
    ['127.0.0.1', 'keycloak'],
  ]);
});

test('windowsHostsInstructions includes the path and the missing lines', () => {
  const out = windowsHostsInstructions([['127.0.0.1', 'minio']], 'win32');
  assert.match(out, /System32\\drivers\\etc\\hosts/);
  assert.match(out, /127\.0\.0\.1 minio/);
});

test('parseCommand returns a valid command', () => {
  assert.equal(parseCommand(['node', 'stack.mjs', 'up']), 'up');
  assert.equal(parseCommand(['node', 'stack.mjs', 'rebuild-web']), 'rebuild-web');
});

test('parseCommand throws UsageError on unknown or missing command', () => {
  assert.throws(() => parseCommand(['node', 'stack.mjs', 'bogus']), UsageError);
  assert.throws(() => parseCommand(['node', 'stack.mjs']), UsageError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/stack.test.mjs`
Expected: FAIL — `Cannot find module './stack.mjs'` (or import resolution error), because `scripts/stack.mjs` does not exist yet.

- [ ] **Step 3: Write the minimal implementation (pure helpers only)**

Create `scripts/stack.mjs`:

```js
#!/usr/bin/env node
// scripts/stack.mjs
//
// Cross-platform host-side orchestrator for the aggregator-dpg local stack.
// Single source of truth for setup/up/down/reset/logs/ps/psql/rebuild-web —
// replaces the POSIX-only Makefile recipe bodies. Uses only node: builtins.
// Belongs to the aggregator-dpg local-dev tooling (host-side, not shipped code).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root (parent of scripts/). */
export const repoRoot = join(__dirname, '..');

/** Host entries the browser + containers must resolve to the local machine. */
export const HOST_ENTRIES = [
  ['127.0.0.1', 'keycloak'],
  ['127.0.0.1', 'minio'],
];

/** Subcommands the orchestrator accepts. */
export const COMMANDS = [
  'setup',
  'up',
  'dev',
  'down',
  'reset',
  'logs',
  'ps',
  'psql',
  'rebuild-web',
];

/** Thrown when argv contains no command or an unknown one. */
export class UsageError extends Error {
  /** @param {string | undefined} cmd - The offending command token. */
  constructor(cmd) {
    super(cmd ? `Unknown command: ${cmd}` : 'No command given');
    this.name = 'UsageError';
  }
}

export const USAGE = `Usage: node scripts/stack.mjs <${COMMANDS.join('|')}>`;

/**
 * Returns the OS-correct path to the hosts file.
 *
 * @param {NodeJS.Platform} platform - process.platform value.
 * @returns The hosts-file path for that platform.
 */
export function hostsFilePath(platform) {
  return platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
}

/**
 * Whether `.env` should be chmod-ed to 600.
 *
 * @param {NodeJS.Platform} platform - process.platform value.
 * @returns true on Unix, false on Windows (NTFS perms differ).
 */
export function shouldChmod(platform) {
  return platform !== 'win32';
}

/**
 * Decides which source file (if any) to copy into `.env`.
 *
 * @param {{ envExists: boolean, localExists: boolean, templateExists: boolean }} state
 * @returns 'skip' | 'env.local' | 'env.template' | 'none'.
 */
export function chooseEnvSource({ envExists, localExists, templateExists }) {
  if (envExists) return 'skip';
  if (localExists) return 'env.local';
  if (templateExists) return 'env.template';
  return 'none';
}

/**
 * Returns the HOST_ENTRIES not already present in the given hosts-file content.
 *
 * @param {string} content - Raw hosts-file text.
 * @param {Array<[string, string]>} entries - Entries to check (defaults to HOST_ENTRIES).
 * @returns The [ip, host] pairs that are missing.
 */
export function missingHostEntries(content, entries = HOST_ENTRIES) {
  return entries.filter(([ip, host]) => {
    const escapedIp = ip.replace(/\./g, '\\.');
    const re = new RegExp(`^\\s*${escapedIp}\\s+${host}(\\s|$)`, 'm');
    return !re.test(content);
  });
}

/**
 * Builds the manual-edit instructions printed on Windows when hosts entries are missing.
 *
 * @param {Array<[string, string]>} missing - Missing [ip, host] pairs.
 * @param {NodeJS.Platform} platform - process.platform value (defaults to 'win32').
 * @returns Multi-line instruction text.
 */
export function windowsHostsInstructions(missing, platform = 'win32') {
  const lines = missing.map(([ip, host]) => `${ip} ${host}`).join('\n');
  return [
    `Add these lines to ${hostsFilePath(platform)} (open Notepad as Administrator):`,
    '',
    lines,
    '',
    'Required so the browser and containers resolve the OIDC issuer to the same host.',
  ].join('\n');
}

/**
 * Extracts and validates the subcommand from process.argv.
 *
 * @param {string[]} argv - Full argv array (argv[2] is the command).
 * @returns The validated command string.
 * @throws {UsageError} If the command is missing or unrecognized.
 */
export function parseCommand(argv) {
  const cmd = argv[2];
  if (!cmd || !COMMANDS.includes(cmd)) {
    throw new UsageError(cmd);
  }
  return cmd;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/stack.test.mjs`
Expected: PASS — all tests green (9 tests, 0 failures).

- [ ] **Step 5: Add the `test:scripts` script and commit**

Add this line to the `"scripts"` block in `package.json` (after `"dep-check"`, with a comma on the preceding line):

```json
    "test:scripts": "node --test scripts/stack.test.mjs"
```

Run to confirm: `pnpm test:scripts`
Expected: PASS.

```bash
git add scripts/stack.mjs scripts/stack.test.mjs package.json
git commit -m "feat(scripts): add stack.mjs pure helpers + node:test coverage"
```

---

## Task 2: Command dispatch + impure operations in `scripts/stack.mjs`

No new unit test (these touch the real filesystem, Docker, and `sudo` — verified manually on macOS in Task 6 and on Windows in the acceptance gate). The pure logic they call is already covered by Task 1.

**Files:**

- Modify: `scripts/stack.mjs` (append the impure layer + dispatcher)

- [ ] **Step 1: Append the impure operations and dispatcher**

Add these imports to the top of `scripts/stack.mjs`, alongside the existing `node:url`/`node:path` imports:

```js
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
```

Then append the following to the **end** of `scripts/stack.mjs`:

```js
// ---- impure operations ----

/**
 * Runs a child process inheriting stdio; throws on failure.
 *
 * @param {string} cmd - Executable name.
 * @param {string[]} args - Arguments.
 * @param {object} [opts] - Extra spawnSync options (merged over defaults).
 * @throws {Error} If the process cannot start or exits non-zero.
 */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${res.status}`);
  }
  return res;
}

/** @returns true if the Docker daemon is reachable. */
function dockerRunning() {
  const res = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return !res.error && res.status === 0;
}

/** Exits with an actionable message if Docker is not running. */
function ensureDocker() {
  if (!dockerRunning()) {
    console.error(
      'Docker daemon not reachable. Start Docker Desktop (Windows/Mac) or the docker service (Linux), then retry.',
    );
    process.exit(1);
  }
}

const envFile = join(repoRoot, '.env');

/** Bootstraps .env, file perms, and hosts entries. Idempotent. */
function setup() {
  const platform = process.platform;

  // 1. Resolve .env
  const choice = chooseEnvSource({
    envExists: existsSync(envFile),
    localExists: existsSync(join(repoRoot, 'infra/env.local')),
    templateExists: existsSync(join(repoRoot, 'infra/env.template')),
  });
  if (choice === 'skip') {
    console.log('.env already exists — leaving untouched.');
  } else if (choice === 'env.local') {
    copyFileSync(join(repoRoot, 'infra/env.local'), envFile);
    console.log('Created .env from infra/env.local. Ready to run: pnpm stack:up');
  } else if (choice === 'env.template') {
    copyFileSync(join(repoRoot, 'infra/env.template'), envFile);
    console.log('Created .env from infra/env.template.');
    console.log('Fill change-me-* placeholders. Generate a secret with:');
    console.log(
      "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"",
    );
  } else {
    console.error('No infra/env.local or infra/env.template found — cannot create .env.');
    process.exit(1);
  }

  // 2. Permissions (Unix only)
  if (shouldChmod(platform) && existsSync(envFile)) {
    chmodSync(envFile, 0o600);
  }

  // 3. Hosts entries
  const hostsPath = hostsFilePath(platform);
  let content = '';
  try {
    content = readFileSync(hostsPath, 'utf8');
  } catch {
    content = ''; // unreadable hosts file → treat as empty, all entries "missing"
  }
  const missing = missingHostEntries(content);
  if (missing.length === 0) {
    console.log(`${hostsPath} already maps keycloak + minio — skipping.`);
  } else if (platform === 'win32') {
    console.log('');
    console.log(windowsHostsInstructions(missing, platform));
    console.log('');
  } else {
    console.log(`Adding host entries to ${hostsPath} (sudo required)...`);
    const lines = missing.map(([ip, host]) => `${ip} ${host}`).join('\n') + '\n';
    const res = spawnSync('sudo', ['tee', '-a', hostsPath], {
      input: lines,
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    if (res.error || res.status !== 0) {
      console.warn('Could not edit the hosts file automatically. Add these lines manually:');
      console.warn(lines);
    }
  }

  // 4. Final hint
  console.log('');
  console.log('Setup complete. Run: pnpm stack:up   (or: make up)');
}

/** Brings the full stack up after a Docker preflight + .env check. */
function up() {
  ensureDocker();
  if (!existsSync(envFile)) {
    console.error('No .env found — run: pnpm stack:setup');
    process.exit(1);
  }
  run('docker', ['compose', 'up', '-d', '--build']);
}

const down = () => run('docker', ['compose', 'down']);
const reset = () => run('docker', ['compose', 'down', '-v']);
const logs = () => run('docker', ['compose', 'logs', '-f']);
const ps = () => run('docker', ['compose', 'ps']);
const psql = () =>
  run('docker', ['compose', 'exec', 'postgres', 'psql', '-U', 'aggregator', '-d', 'aggregator']);

/** Rebuilds the web image (with NEXT_PUBLIC_* baked at compile time) and restarts it. */
function rebuildWeb() {
  run('pnpm', ['--filter', '@aggregator-dpg/web', 'build']);
  run('docker', ['compose', 'build', 'web']);
  run('docker', ['compose', 'up', '-d', 'web']);
}

const HANDLERS = {
  setup,
  up,
  dev: up, // `dev` is an alias for `up`
  down,
  reset,
  logs,
  ps,
  psql,
  'rebuild-web': rebuildWeb,
};

/** Parses argv and runs the matching handler. */
function main() {
  let cmd;
  try {
    cmd = parseCommand(process.argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      console.error(USAGE);
      process.exit(2);
    }
    throw err;
  }
  HANDLERS[cmd]();
}

// Only run when invoked directly (`node scripts/stack.mjs ...`), not when
// imported by the test module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 2: Verify the import guard did not break the unit tests**

Run: `node --test scripts/stack.test.mjs`
Expected: PASS — still 9 tests green. (Importing `stack.mjs` from the test must NOT trigger `main()`; the `import.meta.url` guard ensures this.)

- [ ] **Step 3: Verify the usage path**

Run: `node scripts/stack.mjs`
Expected: prints `No command given` then the `Usage: ...` line; exit code 2.

Run: `node scripts/stack.mjs bogus`
Expected: prints `Unknown command: bogus` then usage; exit code 2.

Verify the exit code: `node scripts/stack.mjs; echo "exit=$?"`
Expected: `exit=2`.

- [ ] **Step 4: Verify `setup` is idempotent against the existing repo `.env`**

(The repo already has a committed-ignored `.env` — `setup` must not clobber it.)

Run: `node scripts/stack.mjs setup`
Expected output includes `.env already exists — leaving untouched.`, a hosts line (either `already maps keycloak + minio — skipping.` or a sudo prompt to add them), and `Setup complete.`

- [ ] **Step 5: Commit**

```bash
git add scripts/stack.mjs
git commit -m "feat(scripts): implement stack.mjs command dispatch + docker/setup ops"
```

---

## Task 3: Expose `stack:*` pnpm scripts

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add the stack scripts**

In `package.json`, add these entries to the `"scripts"` block (after `"test:scripts"` from Task 1; ensure trailing commas are correct):

```json
    "stack:setup": "node scripts/stack.mjs setup",
    "stack:up": "node scripts/stack.mjs up",
    "stack:down": "node scripts/stack.mjs down",
    "stack:reset": "node scripts/stack.mjs reset",
    "stack:logs": "node scripts/stack.mjs logs",
    "stack:ps": "node scripts/stack.mjs ps",
    "stack:psql": "node scripts/stack.mjs psql",
    "stack:rebuild-web": "node scripts/stack.mjs rebuild-web"
```

- [ ] **Step 2: Verify the scripts resolve through pnpm**

Run: `pnpm stack:setup`
Expected: same output as `node scripts/stack.mjs setup` in Task 2 Step 4 (`.env already exists`, hosts handling, `Setup complete.`).

Run: `pnpm stack:ps`
Expected: `docker compose ps` output (table of services, or empty if nothing is up; if Docker is down it errors from compose — acceptable, `ps` has no preflight).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add cross-platform stack:* pnpm scripts"
```

---

## Task 4: Delegate Makefile recipes to the pnpm scripts

**Files:**

- Modify: `Makefile`

- [ ] **Step 1: Update the `.PHONY` line**

Replace line 1's `.PHONY` list — remove `hosts` and `env` (those targets are being deleted; their logic now lives in `stack.mjs`). Change:

```make
.PHONY: help setup hosts env dev up down logs ps reset psql redis-cli mc kc rebuild-web rebuild-keycloak kc-plugin kc-logs \
```

to:

```make
.PHONY: help setup dev up down logs ps reset psql redis-cli mc kc rebuild-web rebuild-keycloak kc-plugin kc-logs \
```

- [ ] **Step 2: Replace the `setup` target**

Replace the current `setup` target (lines 13-15) AND delete the entire `env:` target (lines 17-29) AND the entire `hosts:` target (lines 31-45). Replace all of that with this single block:

```make
setup: ## One-shot: bootstrap .env + add keycloak/minio host entries (delegates to scripts/stack.mjs).
	pnpm stack:setup
```

- [ ] **Step 3: Replace the `up`/`dev` targets**

Replace the current `dev` (line 47) and `up` (lines 49-51) targets with:

```make
dev: up ## Alias for `up`. Brings the full local stack up.

up: ## Start all foundations + apps in the background.
	pnpm stack:up
```

- [ ] **Step 4: Replace `down`, `reset`, `logs`, `ps`, `psql`**

Replace the current `down` (53-54), `reset` (56-57), `logs` (59-60), `ps` (62-63), and `psql` (65-66) target bodies so each delegates:

```make
down: ## Stop and remove all containers (data volumes preserved).
	pnpm stack:down

reset: ## Stop everything and wipe data volumes. Destructive.
	pnpm stack:reset

logs: ## Tail logs for all services.
	pnpm stack:logs

ps: ## Show service status.
	pnpm stack:ps

psql: ## Open psql against the local Postgres.
	pnpm stack:psql
```

- [ ] **Step 5: Replace the `rebuild-web` target**

Replace the current `rebuild-web` target (lines 79-82) with:

```make
rebuild-web: ## Rebuild the web image and restart only the web container.
	pnpm stack:rebuild-web
```

Leave `redis-cli`, `mc`, `kc`, `kc-plugin`, `rebuild-keycloak`, `kc-logs`, all `helm-*`, and `keycloak-image` targets unchanged — they are Unix/WSL-only and out of scope.

- [ ] **Step 6: Verify the Makefile still parses and delegates**

Run: `make help`
Expected: the help table renders, listing `setup`, `up`, `down`, `reset`, `logs`, `ps`, `psql`, `rebuild-web` (and the untouched Helm/kc targets); NO `env` or `hosts` rows.

Run: `make setup`
Expected: identical output to `pnpm stack:setup` (`.env already exists`, hosts handling, `Setup complete.`).

- [ ] **Step 7: Commit**

```bash
git add Makefile
git commit -m "refactor(makefile): delegate stack targets to pnpm stack:* (single source of truth)"
```

---

## Task 5: Documentation — Windows path + drop BSD `sed`

**Files:**

- Modify: `QUICKSTART.md`
- Modify: `SETUP.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Fix the QUICKSTART TL;DR (drop `sed -i ''`)**

In `QUICKSTART.md`, replace the TL;DR code block (lines 5-11) with:

````markdown
```bash
git clone <repo-url> aggregator-dpg && cd aggregator-dpg
pnpm install
pnpm stack:setup                     # bootstraps .env + host entries (or: make setup)
# open .env and set: ADMIN_EMAILS=you@yourorg.com
pnpm stack:up                        # boots the full stack (or: make up)
open http://localhost:3100
```
````

- [ ] **Step 2: Replace the prereq platform note with a Windows subsection**

In `QUICKSTART.md`, replace line 37 (`Mac/Linux. Windows: WSL2.`) with:

```markdown
**Supported hosts:** macOS, Linux, and **native Windows** (Docker Desktop — no WSL2 required). See the Windows note in §3.
```

Then, immediately after the `## 3. Bring everything up` section (after its last code block / before `## 4. Smoke test`), insert:

````markdown
### Windows note

`make` is not required on Windows — use the pnpm scripts, which run the same cross-platform `scripts/stack.mjs`:

```powershell
pnpm install
pnpm stack:setup     # creates .env; PRINTS the two host lines to add (see below)
pnpm stack:up        # boots the stack
```

The one manual step on Windows: `pnpm stack:setup` cannot edit the hosts file for you (it needs Administrator). It prints two lines like:

```
127.0.0.1 keycloak
127.0.0.1 minio
```

Open `C:\Windows\System32\drivers\etc\hosts` in Notepad **run as Administrator**, paste those two lines, save, then run `pnpm stack:up`. Re-running `pnpm stack:setup` is safe — it never duplicates entries.

Keycloak OTP-plugin rebuilds (`make kc-plugin` / `make rebuild-keycloak`) and the Helm targets remain Unix/WSL-only; the prebuilt OTP JAR is committed, so a normal Windows run does not need them.
````

- [ ] **Step 3: Repoint the hosts troubleshooting row**

In `QUICKSTART.md`, in the troubleshooting table, change the fix for "Browser can't reach http://keycloak:8080" from:

```
`/etc/hosts` missing entry. Re-run `make hosts`.
```

to:

```
Hosts entry missing. Re-run `make setup` (or `pnpm stack:setup`); on Windows, re-paste the printed lines into `C:\Windows\System32\drivers\etc\hosts` as Administrator.
```

- [ ] **Step 4: Note the entrypoint in SETUP.md**

In `SETUP.md`, find the section describing the docker-only / `make up` run mode and add this note (place it directly after the first mention of `make setup`/`make up`):

```markdown
> **Cross-platform / Windows:** every `make <target>` for the local stack has a `pnpm stack:<target>` equivalent (`setup`, `up`, `down`, `reset`, `logs`, `ps`, `psql`, `rebuild-web`), both driven by `scripts/stack.mjs`. On native Windows (no WSL2) use the pnpm form; `make` is not required. See QUICKSTART.md §3 "Windows note".
```

- [ ] **Step 5: Note the entrypoint in CLAUDE.md**

In `aggregator-dpg/CLAUDE.md`, in the "Local stack" fenced command block (the one listing `make setup` / `make up` / ...), add these lines at the top of that block:

```bash
# Cross-platform entrypoint (Windows-friendly; make not required):
pnpm stack:setup        # = make setup  (env + hosts via scripts/stack.mjs)
pnpm stack:up           # = make up
# stack:down | stack:reset | stack:logs | stack:ps | stack:psql | stack:rebuild-web
```

- [ ] **Step 6: Verify the README link checker still passes**

Run: `node scripts/check-readme-links.mjs` (if the repo wires it; otherwise skip)
Expected: no broken links reported. If the script is not standalone-runnable, skip this step.

- [ ] **Step 7: Commit**

```bash
git add QUICKSTART.md SETUP.md CLAUDE.md
git commit -m "docs: document native-Windows local setup via pnpm stack:* scripts"
```

---

## Task 6: Unix end-to-end verification (acceptance on macOS)

This task runs no new code; it confirms the Unix path is intact and records the Windows acceptance gate. No commit unless a fix is needed.

**Files:** none (verification only)

- [ ] **Step 1: Unit tests green**

Run: `pnpm test:scripts`
Expected: PASS — 9 tests, 0 failures.

- [ ] **Step 2: Repo-wide checks unaffected**

Run: `pnpm -w lint && pnpm -w typecheck`
Expected: PASS. (`.mjs` is not eslinted by the workspace config and `scripts/` is not a typecheck target, so these should be unaffected; if either fails, the failure must be pre-existing and unrelated — confirm with `git stash` + re-run before proceeding.)

- [ ] **Step 3: Full boot smoke test (macOS, Docker running)**

Run:

```bash
pnpm stack:setup
pnpm stack:up
pnpm stack:ps
```

Expected: `stack:up` builds + starts containers; `stack:ps` shows services, with `keycloak` reaching `healthy` after 60-90s. Then complete the QUICKSTART §4 smoke test (register at http://localhost:3100 → approve in MailHog at :8025 → login). Then `pnpm stack:down`.

- [ ] **Step 4: Makefile parity spot-check**

Run: `make setup && make ps`
Expected: same behavior as the pnpm equivalents (delegation works).

- [ ] **Step 5: Record the Windows acceptance gate**

The native-Windows path (`win32` branch + Notepad hosts edit) cannot be executed on macOS. Before merging, a Windows + Docker Desktop run must pass: `pnpm install` → `pnpm stack:setup` → paste the two printed lines into the hosts file as Administrator → `pnpm stack:up` → smoke test at http://localhost:3100. Note this as the PR's manual-QA checkbox (QUICKSTART §3 "Windows note" is the script).

---

## Self-Review

**Spec coverage:**

- Single Node orchestrator `scripts/stack.mjs` → Tasks 1-2. ✓
- pnpm `stack:*` entrypoint → Task 3. ✓
- Makefile delegates, Helm/SPI untouched → Task 4. ✓
- Three `process.platform` branches (hosts path, chmod, [docker preflight is platform-agnostic]) → Task 1 (`hostsFilePath`, `shouldChmod`) + Task 2 (`ensureDocker`, hosts win32 branch). ✓
- Hosts: auto on Unix, instruct on Windows → Task 2 `setup()`. ✓
- Docker-only preflight → Task 2 `ensureDocker`/`up`. ✓
- Idempotent setup, no `.env` clobber, no duplicate hosts lines → Task 1 `chooseEnvSource`/`missingHostEntries`, verified Task 2 Step 4. ✓
- Drop BSD `sed -i ''` → Task 5 Step 1. ✓
- Platform logic unit-tested on any OS → Task 1 (deviation: `node:test` instead of Vitest, because `scripts/` is not a Turbo/Vitest workspace package; keeps the script dependency-free and outside Turbo). ✓
- Windows docs / acceptance gate → Task 5 + Task 6 Step 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command shows expected output. ✓

**Type/name consistency:** `HOST_ENTRIES`, `hostsFilePath`, `shouldChmod`, `chooseEnvSource`, `missingHostEntries`, `windowsHostsInstructions`, `parseCommand`, `UsageError`, `USAGE`, `COMMANDS`, `repoRoot` are defined in Task 1 and used with identical names in Task 2's test/dispatch. Handler keys (`setup`/`up`/`dev`/`down`/`reset`/`logs`/`ps`/`psql`/`rebuild-web`) match `COMMANDS` and the pnpm/Makefile target names. ✓
