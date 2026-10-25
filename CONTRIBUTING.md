# Contributing to AIJobNinja

Thanks for your interest in contributing. AIJobNinja is built with Claude Code, and you can use it for development too.

## Before Submitting a PR

**For a new feature, a new mode or command, or an architecture change, please open an issue first.** It saves you from investing time in something we'd have to redirect, and lets us align on direction before you write code.

**Going straight to a PR is welcome — no issue needed — for:** bug fixes, new zero-auth scanner providers, docs, and translations. Don't let process slow these down; these are the contributions we most want.

A large *feature* PR that skipped this step may be asked to start with an issue if it doesn't fit the architecture or roadmap — that's a scope conversation, never a judgment on your work.

### What makes a good PR
- Fixes a bug listed in Issues
- Addresses a feature request that was discussed and approved
- Includes a clear description of what changed and why
- Follows the existing code style and project philosophy (simple, minimal, quality over quantity)

## Quick Start

1. For a new feature, a new mode or command, or an architecture change, open an issue to discuss your idea (see [Before Submitting a PR](#before-submitting-a-pr))
2. Fork the repo
3. Create a branch (`git checkout -b feature/my-feature`)
4. Make your changes
5. Test with a fresh clone (see [docs/SETUP.md](docs/SETUP.md))
6. Commit and push
7. Open a Pull Request, referencing the issue if you opened one

## What to Contribute

**Good first contributions:**
- Add companies to `templates/portals.example.yml`
- Translate modes to other languages
- Improve documentation
- Add example CVs for different roles (in `examples/`)
- Report bugs via Issues

**Bigger contributions:**
- New evaluation dimensions or scoring logic
- Dashboard TUI features (in `dashboard/`)
- New skill modes (in `modes/`)
- Script improvements (`.mjs` utilities)

## What belongs in core (the parallel-feature test)

AIJobNinja says yes to a lot: providers, languages, CLI support, fixes. Where we are deliberately picky is **parallel features**: things adjacent to the job-search path that would each be useful on their own. Every merged feature is a promise to maintain it forever (docs, tests, agent context, upgrade paths), so "is it well built?" is not the bar. Before proposing one, run it through the four questions we use ourselves:

1. **Is it on the core path?** The core path is: discover postings, evaluate, tailor, apply, track, close the loop. Infrastructure that strengthens that path is core even when invisible (dedup, atomic writes, the transition ledger). A feature that lives *next to* the path (contact management, calendaring, note-taking) starts as a plugin.
2. **Who pays the maintenance?** A feature that solves one workflow brilliantly but adds surface for everyone (a new data file, a new script, a new mode) needs either demonstrated demand (issues from several people, not one) or a plugin home.
3. **Plugin-first, with graduation.** Adjacent features start as plugins (see [docs/PLUGINS.md](docs/PLUGINS.md)): you own the release cycle, we list it in the registry. If a plugin earns real adoption, we will consider graduating it into core. Evidence-based promotion, not gatekeeping: it is how WordPress runs feature-projects.
4. **Does it match the project's shape?** A mode or API that breaks established patterns creates cognitive load for every future user and contributor, even when it works. Expect us to ask for the spelling that matches the codebase before the merge.

Failing one of these is a routing, not a rejection. Open the issue first and we will tell you which door fits: core, plugin, or separate project. The plugin registry gives real distribution, and an idea that is wrong for core today can still be the most useful thing you ship.

## Source Indexing Policy

AIJobNinja reads job listings from public sources: ATSes, job boards, company career pages, talent networks. Every source meets the same bar, whoever proposes it.

1. **What gets indexed.** Any source whose listings are real, attributed to an identifiable employer, and free for candidates to read and apply to. A source that paywalls listings or applications for candidates is not indexed.
2. **Canonical URL.** Each listing carries the shortest verifiable path to the employer the source exposes (the ATS or direct application URL when available). The source's own page may travel as secondary attribution.
3. **Paid placement doesn't reach the candidate.** Ranking happens on each user's machine, and AIJobNinja carries no sponsored placements of any kind.
4. **The source's own `robots.txt`.** Checked before a provider is written, and read the way a crawler reads it: per path, under the group that binds AIJobNinja's own client (`User-agent: *`, or a token the scanner actually sends). A `Disallow` counts only when it covers a path the provider would fetch. A `Disallow` that covers the listing paths the provider needs is a stop: the source is not indexed, and the finding goes in the [Evaluated, not supported](docs/SUPPORTED_JOB_BOARDS.md#evaluated-not-supported) table. Anything ambiguous is a maintainer decision on the proposal.

The [Source Indexing Log](docs/SOURCE_INDEXING_LOG.md) records how the rules were applied to each listed source. To propose a source, open an issue walking through these rules, or send a PR with the provider.

## Guidelines

- Keep modes language-agnostic when possible (Claude handles both EN and ES)
- Scripts should handle missing files gracefully (check `existsSync` before `readFileSync`)
- Dashboard changes require a build (`npm run build:dashboard`) — test with real data before submitting
- Changes to `dashboard/` or `templates/states.yml` need `go test ./...` run from `dashboard/`: CI runs it on every pull request, and it is the only check that the dashboard accepts every state in `templates/states.yml`; `node test-all.mjs` does not run it
- Don't commit personal data (cv.md, profile.yml, applications.md, reports/)

## What we do NOT accept

- **PRs that scrape platforms prohibiting automated access** (LinkedIn, etc.). We actively reject these to respect third-party ToS.
- **PRs that enable auto-submitting applications** without human review. AIJobNinja is a decision-support tool, not a spam bot.
- **PRs that add external API dependencies** without prior discussion in an issue.
- **Feature PRs against bundled plugins** (`plugins/apify`, `plugins/gmail`, `plugins/notion`). Bundled plugins are stable *reference seeds* — to extend one, publish your own `aijobninja-plugin-<id>` and we'll register it as the maintained successor that takes precedence once installed (see [docs/PLUGINS.md](docs/PLUGINS.md)). Bundled plugins only take security/compat fixes.
- **PRs that add centralized or hosted infrastructure to the core** (proxies, aggregation services, shared Workers). That's the separate opt-in service, not the open-core — bring it to the direction discussion first.
- **Universal aggregation indexes as a dependency** — integrating a single third-party service that unifies listings across many sources into one pipe AIJobNinja reads from. Reading individual boards where employers post is exactly what `providers/` is for and stays welcome; the *unified offers-aggregation layer itself* is first-party, the same boundary that keeps the web experience first-party (#904 / #156). This boundary applies to the plugin registry as well as core.
- **Integrations that send your data to a third-party service** — providers or sync features that require a third-party account or push your CV, pipeline, or notes out to an external service. AIJobNinja is local-first and zero-keys: your job-search data stays on your machine unless you opt into a first-party shared surface, and what leaves is stated at that opt-in. Reading *public* job-listing APIs locally is welcome (that's how the built-in providers work); routing your personal data through someone else's service is not.
- **Integrations whose primary consumer is a third-party product or service** — a module, contract or adapter whose main caller is someone else's product (a bot, a SaaS, an external orchestrator) belongs in a plugin or a separate project, never in core, even when the code itself is generic.
- **PRs that add third-party hosted entry-points or service badges to the README** — links or embeds that route users' resumes or job data through a service that is not one of the project's own.
- **PRs containing personal data** (real CVs, emails, phone numbers). Use `examples/` with fictional data instead.

## Development

```bash
# Scripts
npm run doctor                # Setup validation
node verify-pipeline.mjs     # Health check
node cv-sync-check.mjs        # Config check

# Dashboard
npm run build:dashboard       # go build with platform-correct binary name
npm run serve:dashboard       # launch the TUI against the repo root
(cd dashboard && go test ./...)  # Go tests; CI runs them next to test-all

# Tests
node test-all.mjs             # Full suite — run before pushing/opening a PR
node test-all.mjs --quick     # Full suite, skipping the dashboard build
node test-all.mjs --only providers/themuse   # Run just one provider's test(s)
node test-all.mjs --quick --jobs 4           # Run at most 4 test files at a time
```

**The test files under `tests/` run in parallel**, one process each, as many at
a time as the machine has CPUs, and the inline sections of `test-all.mjs` run
alongside them in one of those slots. `--jobs N` changes that for one run and
`AIJOBNINJA_TEST_JOBS=N` for a machine; `1` runs everything one after another
in a single process. The log comes out in the same order either way. If a test
passes alone and fails in a full run (or the reverse), rerun with `--jobs 1`
and see "Parallel runs" in [`tests/README.md`](tests/README.md) for what a
suite may not rely on.

**Any new test belongs in its own file** under `tests/`, not as a numbered
section inside `test-all.mjs`. Anything matching `tests/**/*.test.mjs` is
auto-discovered, so there is nothing to register and no section number to pick.
A new file also collides with nobody: several contributors adding sections to
`test-all.mjs` at the same time all edit its final lines, and each merge forces
a rebase on the rest.

**Adding a scanner provider?** See
[`providers/ADDING_A_PROVIDER.md`](providers/ADDING_A_PROVIDER.md) — the full
contract, the mandatory guards, and what `tests/providers/{name}.test.mjs`
must cover.

**Adding a test for the web app:** web suites live under `web/tests/`. A suite
that covers one module mirrors that module's path below `web/src/` and takes its
name (`src/lib/clean-chips.mjs` → `tests/lib/clean-chips.test.mjs`); a suite that
pins a behaviour across modules is named for the behaviour instead, which is what
roughly half of `web/tests/` does. `web/`'s own `npm test` glob-discovers them
either way, so no registration is needed there either — but keep them out of
`web/src/` (Next.js scans that tree) and write them as `.mjs`, since there is no
TypeScript loader for `node --test`. `web/README.md` has the detail;
`tests/web-test-layout.test.mjs` enforces the *discovery* half on every PR — that
the glob reaches every suite on disk and that `web/`'s engines floor can run it.
The naming is a convention, not a checked contract.

**`--only` is a dev convenience, not a PR gate:** it runs *only* the discovered
`tests/` files matching the given substring and skips every inline core
section (syntax, scripts, dashboard, data contract, personal data, paths,
etc.). A green `--only` run is **not** a green suite — always run the full
`node test-all.mjs` before pushing.

### Checking translated mode structure

Run `node i18n-drift.mjs --lang tr` (repeat `--lang` for several languages),
or omit `--lang` to check every locale. `--json` emits machine-readable results;
`--summary` prints language totals. The checker runs offline with Node alone and
reports drift without failing.
It checks existing mode files, including nested interview modes, and files
promised in each locale's README. Languages shipping only the core subset are
not penalized for modes they have not translated.

Coverage compares Markdown heading levels and order, not translated words or
prose. Fenced examples and comments are excluded. Missing structural slots are
listed with canonical names and line numbers; when several alignments are
possible, the report lists candidate locations instead of claiming which title
is absent. **100% is structural coverage, not proof of translation completeness**:
an unrelated section with the same shape can hide an omission. Translation
review and the separate evaluation-template parity checks still apply.

## Need Help?

- Open an [issue](https://github.com/mannysinghx/AIJOBNINJA/issues)
- [Read the architecture docs](docs/ARCHITECTURE.md)
