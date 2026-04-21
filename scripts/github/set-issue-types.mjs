#!/usr/bin/env node
// Assign GitHub Issue Types (Feature/Task/Bug/Epic) to every issue in the
// repo, inferring from the `type:*` label. Distinct from the label — this
// populates GitHub's native Issue Type field.
//
// - If Epic type doesn't exist in the org, logs a warning and skips epics.
// - Creating Epic type needs admin:org scope: gh auth refresh -h github.com -s admin:org
//
// Usage: node scripts/github/set-issue-types.mjs [--org sanketika-labs] [--repo sanketika-labs/aggregator-dpg] [--dry-run]

import { execSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name) => process.argv.includes(name);

const ORG = flag("--org") ?? "sanketika-labs";
const REPO = flag("--repo") ?? "sanketika-labs/aggregator-dpg";
const DRY = has("--dry-run");

function graphqlFile(query) {
  const p = join(tmpdir(), `gql-${process.pid}-${Date.now()}.graphql`);
  writeFileSync(p, query);
  const out = execSync(`gh api graphql -F query=@${p}`, { encoding: "utf8" });
  execSync(`rm -f ${p}`);
  return JSON.parse(out);
}

// 1. Fetch org issue types
const typesRes = graphqlFile(`{
  organization(login:"${ORG}") {
    issueTypes(first:20) { nodes { id name isEnabled } }
  }
}`);
const types = {};
for (const t of typesRes.data.organization.issueTypes.nodes) {
  if (t.isEnabled) types[t.name] = t.id;
}
console.log("Available issue types:", Object.keys(types).join(", ") || "(none)");
if (!types.Epic) {
  console.warn(
    "No Epic type. Epics will be skipped. Create one with:\n  gh auth refresh -h github.com -s admin:org\n  gh api -X POST /orgs/" +
      ORG +
      "/issue-types -f name=Epic -f description='Large body of work' -F is_enabled=true"
  );
}

// 2. Label -> type name mapping
const labelToType = {
  "type:epic": "Epic",
  "type:feature": "Feature",
  "type:task": "Task",
  "type:bug": "Bug",
  "type:spike": "Task",
};

// 3. Fetch all issues in the repo with their labels + node IDs (paginated)
async function fetchAllIssues() {
  const [owner, name] = REPO.split("/");
  const all = [];
  let cursor = null;
  while (true) {
    const cursorArg = cursor ? `, after: "${cursor}"` : "";
    const res = graphqlFile(`{
      repository(owner:"${owner}", name:"${name}") {
        issues(first: 100${cursorArg}, states: [OPEN, CLOSED]) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            number
            issueType { name }
            labels(first: 20) { nodes { name } }
          }
        }
      }
    }`);
    const page = res.data.repository.issues;
    all.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return all;
}

const issues = await fetchAllIssues();
console.log(`Found ${issues.length} issues.`);

// 4. Update each
let updated = 0;
let skipped = 0;
let alreadySet = 0;
let warned = 0;
for (const issue of issues) {
  const labels = issue.labels.nodes.map((l) => l.name);
  const typeLabel = labels.find((l) => l.startsWith("type:"));
  if (!typeLabel) {
    warned++;
    if (warned < 6) console.warn(`  #${issue.number}: no type: label`);
    continue;
  }
  const targetTypeName = labelToType[typeLabel];
  if (!targetTypeName) {
    warned++;
    if (warned < 6) console.warn(`  #${issue.number}: unknown label ${typeLabel}`);
    continue;
  }
  if (!types[targetTypeName]) {
    skipped++;
    continue; // e.g. Epic not yet created
  }
  if (issue.issueType?.name === targetTypeName) {
    alreadySet++;
    continue;
  }

  if (DRY) {
    console.log(`  [DRY] #${issue.number} -> ${targetTypeName}`);
    updated++;
    continue;
  }

  const mutation = `mutation{updateIssueIssueType(input:{issueId:"${issue.id}",issueTypeId:"${types[targetTypeName]}"}){issue{number}}}`;
  try {
    execSync(`gh api graphql -f query='${mutation}'`, { encoding: "utf8" });
    updated++;
    if (updated % 25 === 0) console.log(`  ${updated} updated …`);
  } catch (e) {
    warned++;
    if (warned < 6)
      console.warn(`  #${issue.number}: ${e.message?.slice(0, 200) ?? e}`);
  }
}

console.log(
  `\nDone. Updated: ${updated}. Already-correct: ${alreadySet}. Skipped (type missing): ${skipped}. Warnings: ${warned}.`
);
