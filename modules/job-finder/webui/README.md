# Web UI

A local, professional search interface for the portal CLIs in `.agents/skills/`.
One search box queries Jobindex, Jobnet, Jobdanmark, Akademikernes Jobbank,
LinkedIn (public listings) and freehire in parallel, merges and de-duplicates the
results, and shows the full posting side by side.

## Run

```bash
python3 tools/install_portal_clis.py   # once: installs each portal CLI's deps
bun run webui/server.ts                # → http://127.0.0.1:4310
```

`PORT` and `HOST` env vars override the defaults. The server binds to loopback only.

## What's in it

| View | What it does |
|---|---|
| **Search** | Keyword + location search across all enabled portals. Results stream in per portal. Filters for date posted, work mode, relevance/newest sort, word refine, expired deadlines. Click a job for the full description, links, and a ready-to-copy `/apply <url>` command for Claude Code. |
| **Saved** | Your shortlist with per-job notes, exported to CSV on demand. Stored in `webui/data/saved.json` (gitignored). |
| **Applications** | Read-only pipeline view of `job_search_tracker.csv`, which `/apply` and `/outcome` maintain. The UI never writes to the tracker. |

Light and dark themes, responsive down to phone width.

## Open source only

- **Runtime:** [Bun](https://bun.sh) (MIT) built-in HTTP server. No npm dependencies.
- **Front end:** plain HTML, CSS and JavaScript. No framework, no build step, no CDN.
- **Font:** Lato (SIL OFL), served from the repo's `cover_letters/OpenFonts/`.
- **Data:** the existing portal CLIs, run as subprocesses. No analytics, no hosted
  search, no third-party APIs beyond the job portals themselves.

## Design notes

- Each CLI runs with an argv array (never a shell), a 30 s timeout, and a 10-minute
  in-memory cache of successful responses.
- Posting descriptions are untrusted: the server reduces them to an allowlisted
  HTML subset (`lib/render.ts`) and the page ships a strict Content-Security-Policy.
- API requests from other sites are refused (`Sec-Fetch-Site` check).
- Jobindex ignores location parameters, so the location is appended to its query
  (as its CLI README recommends). Jobnet and Jobdanmark take a 4-digit postal code
  or a municipality; freehire takes a 2-letter country code or a city.
- Akademikernes Jobbank currently blocks automated requests with Cloudflare, so it
  starts switched off (click its chip to retry). When on and blocked, the UI shows
  "Blocked by the portal" and keeps going with the others.
- Jobindex's detail command returns the whole page an ad lives on. `lib/clean.ts`
  narrows that to the ad (from its title, minus cookie banners, menus and footers)
  and falls back to the original text when it can't tell.

## Tests

```bash
cd webui && bun test
```
