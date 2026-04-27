#!/usr/bin/env node
/**
 * Verifies that every service package README links to docs/config.md.
 *
 * Run: node scripts/check-readme-links.mjs
 * Exits 1 if any README is missing the link.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Service packages whose READMEs must link to docs/config.md. */
const SERVICE_PACKAGES = ['config-loader', 'schema-service'];

const TARGET_LINK = 'docs/config.md';

let failed = false;

for (const pkg of SERVICE_PACKAGES) {
  const readmePath = join(ROOT, 'packages', pkg, 'README.md');

  if (!existsSync(readmePath)) {
    console.error(`FAIL  packages/${pkg}/README.md — file does not exist`);
    failed = true;
    continue;
  }

  const content = readFileSync(readmePath, 'utf8');
  if (!content.includes(TARGET_LINK)) {
    const rel = relative(ROOT, readmePath);
    console.error(`FAIL  ${rel} — missing link to ${TARGET_LINK}`);
    failed = true;
  } else {
    const rel = relative(ROOT, readmePath);
    console.log(`OK    ${rel}`);
  }
}

if (failed) {
  console.error(`\nFix: add a link to ${TARGET_LINK} in each failing README.`);
  process.exit(1);
}

console.log('\nAll service READMEs link to docs/config.md.');
