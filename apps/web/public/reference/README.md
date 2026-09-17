# Reference datasets

Backing data for the `x-reference-source` form widget (the college/institute
picker on `itiInstitute`). Fetched by the browser from `/reference/<id>.json`.

**These are fallback copies. Do not edit them here.**

Canonical is `Blue-Dots-Economy/bluedots-schemas` at `apps/ui/public/reference/`.
A deployment fetches that copy at deploy time and mounts it as a ConfigMap over
this directory, so whatever ships in the image is shadowed by the canonical file.
Editing a list here changes local development only, and the edit is lost the
moment anyone re-syncs. Change it upstream.

They exist so local development, and any environment where the ConfigMap is
disabled, still gets a working picker instead of a bare text box.

Which file is served is chosen per deployment by `COLLEGE_DATASET` (`ka` | `up`)
— see `apps/web/src/lib/form-runtime-config.ts`. Only one region is mounted at a
time: a ConfigMap is capped at 1 MiB by etcd and the two together exceed it.

To re-sync, copy the files across verbatim:

```
cp <bluedots-schemas>/apps/ui/public/reference/colleges-*.json apps/web/public/reference/
```
