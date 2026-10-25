# Progress

## Where it stopped (2026-10-24)

- Branch `webui`, branched from `master` at `e16acee`, pushed to https://github.com/mannysinghx/AIJOBNINJA as `main` (remote `aijobninja`).
- Added `webui/` (local search UI) and `docs/`. The only existing file changed is `README.md` (a short Web UI section and one file-tree line).
- Nothing uncommitted.

## Done and verified

| Piece | Proof |
|---|---|
| Portal CLIs install | `python3 tools/install_portal_clis.py` → "All 6 portal CLI(s) installed." |
| Server API: search fans out to 6 CLIs, merges, dedupes | `curl '127.0.0.1:4310/api/search?q=data+analyst'` → jobindex, jobnet, jobdanmark, linkedin, freehire `ok`; jobbank `error` (Cloudflare block, upstream) |
| Detail endpoint renders sanitized HTML | `curl '127.0.0.1:4310/api/detail?portal=jobnet&id=…'` returns `descriptionHtml` |
| UI: search, streaming results, detail pane, save/notes, saved page, applications pipeline, light/dark, mobile 375px, desktop 1440px | Checked in a browser; no console errors |
| UI unit tests | `cd webui && bun test` → 8 pass |
| Repo suite still green | `python3 -m unittest discover -s tests` → 836 OK (37 skipped); `python3 tools/security_guards.py` → OK |

## In flight

None.

## Open findings and decisions

Resolved on 2026-10-24:
- **Akademikernes Jobbank blocked** (Cloudflare, upstream): now off by default in the UI, chip explains why.
- **Jobindex detail text had page chrome**: cleaned UI-side by `webui/lib/clean.ts` (CLI untouched); verified on 10 live ads.
- **Main README link**: added under Quick start step 4 and in the file tree.

Still open:
- Ads hosted behind an application form (e.g. Garuda) have no ad text to show; the UI shows what little exists. Low severity, nothing to fix UI-side.

## Next steps

None pending.

## How to resume

```bash
git clone https://github.com/mannysinghx/AIJOBNINJA.git && cd AIJOBNINJA
python3 tools/install_portal_clis.py
bun run webui/server.ts          # http://127.0.0.1:4310
cd webui && bun test
```
