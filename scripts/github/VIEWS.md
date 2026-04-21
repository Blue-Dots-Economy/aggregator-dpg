# Project views — manual setup

GitHub's Projects v2 API does not expose a public mutation to create views; they must be added through the web UI. Open the project (https://github.com/orgs/sanketika-labs/projects/3) and create the following views via the **+ New view** button.

## 1. Board by Status *(default, already exists)*

- Layout: **Board**
- Group by: **Status**
- Columns: the default Status options (Todo / In Progress / Done). Extend in Project settings if you want the richer set from the spec (`Backlog`, `Ready`, `In Progress`, `In Review`, `Blocked`, `Done`, `Deferred`).

## 2. Table by Phase

- Layout: **Table**
- Slice by: **Phase**
- Fields visible: Title · Status · Area · Priority · Milestone · Assignees
- Sort: Phase ascending, then Priority ascending

## 3. Roadmap by Milestone

- Layout: **Roadmap**
- Date source: **Milestone** (start = created; end = due date once set)
- Group by: **Milestone**

## 4. Board by Area *(the "block by block" lens you asked for)*

- Layout: **Board**
- Group by: **Area**
- Filter: `type:feature OR type:task` (hide epics for a focused per-team lane view)

## 5. Table by Epic *(hierarchy view)*

- Layout: **Table**
- Group by: **Epic**
- Sort: Epic ascending, then Title
- Fields visible: Title · Phase · Area · Priority · Status · Assignees

## 6. Blocked items

- Layout: **Table**
- Filter: `label:blocked OR label:needs:decision OR label:needs:upstream-confirmation`
- Fields visible: Title · Epic · Area · Phase · Priority · Assignees
- Sort: Priority ascending

## Status-option extension (optional, one-time)

The default Status field has `Todo / In Progress / Done`. To match the spec's richer lifecycle, in **Project settings → Fields → Status**, replace with:

- `Backlog`
- `Ready`
- `In Progress`
- `In Review`
- `Blocked`
- `Done`
- `Deferred`

Existing items will stay on whatever option they had; recategorise as needed.
