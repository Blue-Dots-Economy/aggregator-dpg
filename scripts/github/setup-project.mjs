#!/usr/bin/env node
// Create (or find) the "Aggregator DPG — MVP" Projects v2 board, add custom
// fields, and ensure a default view exists. Idempotent.
//
// Requires: gh CLI authenticated with `project` scope.
//   gh auth refresh -s project
//
// Usage: node scripts/github/setup-project.mjs [--owner sanketika-labs]

import { execSync } from "node:child_process";

const OWNER = argFlag("--owner") ?? "sanketika-labs";
const PROJECT_TITLE = "Aggregator DPG — MVP";
const PROJECT_DESC =
  "MVP delivery tracker for the Aggregator DPG — platform + product + post-MVP.";

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function gh(args, { json = false } = {}) {
  const out = execSync(`gh ${args}`, { stdio: ["ignore", "pipe", "inherit"] });
  const s = out.toString("utf8").trim();
  return json ? JSON.parse(s) : s;
}

// 1) Find or create the project
const existing = gh(
  `project list --owner ${OWNER} --format json --limit 100`,
  { json: true }
);

let project = existing.projects.find((p) => p.title === PROJECT_TITLE);

if (!project) {
  console.log(`Creating project "${PROJECT_TITLE}" under ${OWNER} …`);
  project = gh(
    `project create --owner ${OWNER} --title "${PROJECT_TITLE}" --format json`,
    { json: true }
  );
  gh(
    `project edit --owner ${OWNER} ${project.number} --description "${PROJECT_DESC}"`
  );
} else {
  console.log(`Project exists: #${project.number} "${project.title}"`);
}

const projectNumber = project.number;
const projectId = project.id;
console.log(`Project URL: ${project.url ?? `https://github.com/orgs/${OWNER}/projects/${projectNumber}`}`);

// 2) List existing fields
const fieldList = gh(
  `project field-list --owner ${OWNER} ${projectNumber} --format json --limit 50`,
  { json: true }
);

function hasField(name) {
  return fieldList.fields.some((f) => f.name === name);
}

// Status already exists by default ("Todo" / "In Progress" / "Done"). We'll
// leave it as-is; the Project's Status options can be edited in the UI if you
// want the full set from the spec.

// 3) Add single-select fields
async function addSingleSelect(name, options) {
  if (hasField(name)) {
    console.log(`  field exists: ${name}`);
    return;
  }
  const optsArg = options.map((o) => `--single-select-option "${o}"`).join(" ");
  gh(
    `project field-create ${projectNumber} --owner ${OWNER} --name "${name}" --data-type SINGLE_SELECT ${optsArg}`
  );
  console.log(`  created field: ${name}`);
}

async function addTextField(name) {
  if (hasField(name)) {
    console.log(`  field exists: ${name}`);
    return;
  }
  gh(
    `project field-create ${projectNumber} --owner ${OWNER} --name "${name}" --data-type TEXT`
  );
  console.log(`  created field: ${name}`);
}

async function addNumberField(name) {
  if (hasField(name)) {
    console.log(`  field exists: ${name}`);
    return;
  }
  gh(
    `project field-create ${projectNumber} --owner ${OWNER} --name "${name}" --data-type NUMBER`
  );
  console.log(`  created field: ${name}`);
}

console.log("Ensuring custom fields …");
await addSingleSelect("Phase", ["0", "1", "2", "3", "4", "Post-MVP"]);
await addSingleSelect("Area", [
  "backend",
  "frontend",
  "db",
  "auth",
  "observability",
  "config",
  "security",
  "qa",
  "devex",
  "sps",
]);
await addSingleSelect("Priority", ["P0", "P1", "P2"]);
await addTextField("JTBD");
await addNumberField("Estimate (days)");
await addTextField("Epic");

// 4) Write project metadata to a file so push-issues can read it
import { writeFileSync } from "node:fs";
const meta = {
  owner: OWNER,
  number: projectNumber,
  id: projectId,
  title: PROJECT_TITLE,
};
writeFileSync("scripts/github/.project.json", JSON.stringify(meta, null, 2));
console.log("Wrote scripts/github/.project.json");

console.log("\nDone. Visit the project URL to customise views (Board by Status, Table by Phase, Roadmap, etc.).");
