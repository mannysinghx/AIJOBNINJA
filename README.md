<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/wordmark-dark.svg"><img src="docs/wordmark-light.svg" alt="AIJobNinja" width="300" height="64"></picture></p>

<p align="center"><strong>Your AI job search, on your machine.</strong></p>

<p align="center">
Paste a job. AIJobNinja checks it is still open, scores it against your real CV,<br>
tailors your CV and drafts your answers. <strong>You press Submit.</strong>
</p>

AIJobNinja is an open-source job search agent that runs inside the AI coding CLI you already use (Claude Code, Codex, OpenCode, Gemini/Antigravity, Qwen, Grok and more). It scans job boards, evaluates every listing into a structured report with a 1-5 score, generates ATS-ready CVs and cover letters, and tracks every application, all from local files you own.

It also ships the **Job Finder** module: a search UI and portal tools for the Nordic job boards (Jobindex, Jobnet, Jobdanmark, Akademikernes Jobbank) plus LinkedIn and freehire, with a LaTeX application workflow. See [Job Finder](#job-finder).

## What AIJobNinja does for you

Paste a job. It tells you whether that night is worth it.

- **Still open?** It checks that the posting is still live before you write a word.
- **Not you?** It scores the role against your real CV and tells you to skip a weak fit. You can override it.
- **Worth it?** It drafts the CV, the cover letter and the answers. You read them. You send them.
- **Who do I talk to?** It finds the person and drafts the note. It never sends it.
- **Where does it all go?** Every application stays on your machine. Nothing is uploaded to us.
- **What should I learn?** After a run of noes, it names the gap.

The first runs are rough. It does not know you yet. Talk to it: your CV, what you want, what you refuse. Think of it as a recruiter's first week.

On first launch it asks for all that in chat. Nothing to configure by hand.

## What AIJobNinja will not do

- **Auto-submit an application.** It drafts the answer to every field; you review and click Submit. The script never POSTs (`prepare-application.mjs`).
- **Send an email.** Drafts only. There is no mail transport anywhere in this codebase.
- **Phone home.** No telemetry, no backend of ours. Your CV goes from your machine to the AI provider you chose, and nowhere else.
- **Push you to apply below 4.0/5.** It will tell you not to. You can override it, and it will say so.

It reformulates your CV; it must never fabricate it. A check in code stops a PDF whose numbers or facts appear in neither your CV nor your article digest, but it cannot judge every rewording yet. Read every CV before you send it. Details in the [FAQ](#faq).

## Features

| Feature                  | Description                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **A-H Evaluation**       | Role summary, CV match (with how much each requirement matters for this posting, and whether that weight came from the JD's own wording, its structure, or an estimate, labelled per requirement; an estimate can never be top-band), level strategy, comp research, personalization, interview prep (STAR+R) -- plus a Block G posting-legitimacy check (is it still open, is it a repost: observations, not verdicts), and a Work-Auth signal that flags an explicit no-sponsorship JD as a hard blocker |
| **Human-in-the-Loop**    | AI evaluates and recommends, you decide and act. The system never submits an application -- you always have the final call <!-- hitl: absolute guarantee. Do not add "automatically", "by itself", "without your permission" or any other hedge when translating this row. -->               |
| **ATS PDF Generation**   | ATS-readable CVs tailored to each JD from your own experience, in Space Grotesk + DM Sans design                                                                                 |
| **Cover Letter Generator** | Research-backed cover letters with keyword mirroring, four interactive angle prompts (why/problems/approach/tone), draft-in-chat approval gate, and A4 PDF via the same HTML + Playwright pipeline as CVs. Auto-drafts on every evaluation; complete and generate on demand via `/aijobninja cover` |
| **Beyond the CV**        | Company research ([`deep`](modes/deep.md)) surfaces AI strategy, recent moves, engineering culture, and the angle your profile should take. Contact discovery ([`contacto`](modes/contacto.md)) identifies the hiring manager, recruiter, or team peer worth reaching out to and drafts a ≤300-character LinkedIn message tuned to each contact type. Formal application email drafts ([`email`](modes/email.md)) turn an evaluated report or pasted JD into a subject line, body, and attachment checklist without sending, submitting, or clicking anything. Applications get you in the queue; research gets you a conversation. |
| **Pattern Analysis**     | Rejection patterns and per-ATS-channel advance rates (`analyze-patterns.mjs`), lifetime funnel stats (`stats.mjs`), repost detection, a possible sign of a ghost job (`detect-reposts.mjs`) |

<details>
<summary><b>Everything else it does</b></summary>

| Feature                  | Description                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto-Pipeline**        | Paste a URL, get a full evaluation + PDF + tracker entry                                                                                 |
| **Interview Story Bank** | Accumulates STAR+Reflection stories across evaluations -- 5-10 master stories you can adapt to the behavioral questions you get                        |
| **Negotiation Scripts**  | Salary negotiation frameworks, geographic discount pushback, competing offer leverage                                                    |
| **Application Email Drafts** | Formal recruiter/referral/cold application emails from a report or pasted JD, with subject line, attachment checklist, source-backed fit points, and a profile-driven contact block. Draft-only -- AIJobNinja never sends, submits, or clicks anything. |
| **Portal Scanner**       | 100+ companies pre-configured (Anthropic, OpenAI, ElevenLabs, Retool, n8n...) + custom web-search queries across Ashby, Greenhouse, Lever, Wellfound |
| **Funded Company Discovery** | Review-first `company:funded` command surfaces recently funded companies and source diagnostics from structured public feeds without editing your data |
| **Batch Processing**     | Parallel evaluation with headless CLI workers (`claude -p` / `opencode run`)                                                             |
| **Dashboard TUI**        | Terminal UI to browse, filter, and sort your pipeline                                                                                    |
| **Pipeline Integrity**   | Automated merge, dedup, status normalization, health checks                                                                              |
| **Interview Suite**      | Time-blocked prep plans, practice sessions with feedback, post-interview debriefs ([`interview/`](modes/interview/README.md)), and a company red-flag detector ([`interview-redflag`](modes/interview-redflag.md)) |
| **Offer Stage**          | Contract reading companion -- clause walk plus a lawyer question list ([`offer-prep`](modes/offer-prep.md)) -- and a desired/advertised/actual salary-gap analyzer (`salary-gap.mjs`) |
| **Follow-ups & Replies** | Follow-up cadence calculator and seeded reminders (`followup-cadence.mjs`, `followup-seed.mjs`); turn them off with `follow_ups.enabled: false` in `config/profile.yml`; employer reply classification into tracker updates ([`reply-watch`](modes/reply-watch.md)) |
| **Plugin System**        | Opt-in integrations (Gmail, Notion, Apify, and your own), disabled by default -- see [docs/PLUGINS.md](docs/PLUGINS.md)        |

</details>

## Quick Start

```bash
git clone https://github.com/mannysinghx/AIJOBNINJA.git
cd AIJOBNINJA && npm install
npx playwright install chromium   # only needed for PDF generation
claude   # or codex / opencode / qwen / agy / grok: open your AI CLI here
```

**On first launch, AIJobNinja walks you through setup (your CV, profile and target roles) just by chatting. Nothing to edit by hand.**

Then ask your CLI to adapt the system to you:

- "Change the archetypes to backend engineering roles"
- "Add these 5 companies to portals.yml"
- "Update my profile with this CV I'm pasting"

Paste a job URL or JD text to run the full pipeline. If your CLI supports slash commands, use `/aijobninja`; in Codex, ask for a mode in plain language ("Run the AIJobNinja scan mode").

On a non-Debian/Ubuntu Linux distro, install Chromium's system libraries with your package manager if PDF generation fails to launch the browser.

### Scanning through an outbound proxy

Node's ordinary `fetch()` may ignore `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` in a proxy-only sandbox. Provider requests can use those variables with `AIJOBNINJA_TRUST_PROXY_EGRESS=1 node scan.mjs`. This uses a request-scoped proxy dispatcher; unrelated requests are unaffected, and `NO_PROXY` destinations still use the local private-address guard.

Set this flag **only when the configured proxy itself blocks connections to private, loopback and metadata addresses**. When a proxy resolves the destination remotely, AIJobNinja cannot verify that final address locally; the proxy must enforce that part of the SSRF boundary. Without this explicit trust setting, provider requests keep their normal direct transport and a DNS failure names the proxy setup needed. Proxy URLs containing credentials must use HTTPS; credential-free HTTP proxies remain supported. Existing installations keep direct transport after a system update; proxy environment variables alone do not enable it. Before enabling the flag, run `npm install` in the AIJobNinja directory to install the added `undici` dependency. It is loaded only for an opted-in request with a configured proxy, so direct scanning continues to work even before that dependency is installed.

> **The system is designed to be customized by your AI coding CLI itself.** Modes, archetypes, scoring weights, negotiation scripts: just ask it to change them. It reads the same files it uses, so it knows exactly what to edit.

See [docs/SETUP.md](docs/SETUP.md) for the full setup guide, [docs/RUNNING_ON_A_BUDGET.md](docs/RUNNING_ON_A_BUDGET.md) for running on custom or local models, [docs/AUTOMATION.md](docs/AUTOMATION.md) for scheduled scans, [docs/KEEPING_PORTALS_LIVE.md](docs/KEEPING_PORTALS_LIVE.md) for keeping your company list current, and [docs/FAQ.md](docs/FAQ.md) for common questions. Design principles live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Job Finder

`modules/job-finder/` is a self-contained module with three parts:

| Part | What it does |
|------|--------------|
| **Search UI** | One search box across Jobindex, Jobnet, Jobdanmark, Akademikernes Jobbank, LinkedIn (public listings) and freehire. Merges and de-duplicates results, shows full postings, keeps a saved-jobs shortlist and a view of your applications. Zero dependencies beyond Bun. |
| **Portal CLIs** | One CLI per board under `modules/job-finder/.agents/skills/`, with JSON output and offline tests. |
| **LaTeX workflow** | `/setup`, `/scrape`, `/apply`, `/interview`, `/outcome`: drafts a tailored CV and cover letter in LaTeX, has a second agent review them, and verifies the compiled PDFs. |

```bash
cd modules/job-finder
python3 tools/install_portal_clis.py   # once
bun run webui/server.ts                # then open http://127.0.0.1:4310
```

Details in [modules/job-finder/README.md](modules/job-finder/README.md).

## Usage

AIJobNinja uses a shared command router. In CLIs that register slash commands, it looks like this:

```
/aijobninja           → Show all available commands
/aijobninja {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker (paste text or URL)
/aijobninja pipeline  → Process pending URLs from inbox (data/pipeline.md)
/aijobninja oferta    → Evaluation only, blocks A to H (no auto PDF)
/aijobninja ofertas   → Compare and rank multiple offers
/aijobninja contacto  → LinkedIn power move: find contacts + draft message
/aijobninja deep      → Deep research prompt about company
/aijobninja interview-prep → Generate company-specific interview prep doc
/aijobninja interview    → Interactive profile/CV onboarding interview
/aijobninja master-profile → Import, review, validate, and prepare selected Profile facts as CV bullets
/aijobninja eu-swe    → Calibrate a European SWE application before CV/apply/interview
/aijobninja interview/plan → Time-blocked prep plan for an upcoming interview
/aijobninja interview/practice → Practice interview, one question at a time with feedback
/aijobninja interview/debrief → Post-interview debrief: close gaps, predict next round
/aijobninja interview-redflag → Analyze employer warning signs before joining a company
/aijobninja pdf       → PDF only, ATS-optimized CV
/aijobninja text      → Tailored markdown CV (mirrors cv.md, no PDF)
/aijobninja latex     → Export CV as LaTeX/Overleaf .tex
/aijobninja latex-tex → Tailor your own resume.tex in place (opt-in; cv.md stays default)
/aijobninja cover     → Cover letter: standalone JD paste or /aijobninja cover {slug}
/aijobninja email     → Formal application email draft (draft-only; never sends, submits, or clicks)
/aijobninja add       → Add a project/paper/role to your CV (fetch + preview + confirm)
/aijobninja expand    → Auto-discover and add missing competencies from profile links
/aijobninja training  → Evaluate course/cert against North Star
/aijobninja project   → Evaluate portfolio project idea
/aijobninja tracker   → Application status overview
/aijobninja agent-inbox → Queue/drain requests for the next session (data/agent-inbox.md)
/aijobninja apply     → Live application assistant (Playwright from this checkout, does not submit)
/aijobninja scan      → Scan portals and discover new offers
/aijobninja discover  → Resolve a company list to scannable ATS boards + append to portals.yml (zero-token)
/aijobninja batch     → Batch processing with parallel workers
/aijobninja patterns  → Analyze rejection patterns and improve targeting
/aijobninja offer-prep → Read a received offer/contract with the candidate: clause walk + lawyer questions (not legal advice)
/aijobninja titles    → Suggest adjacent job titles from your CV to broaden the search
/aijobninja upskill   → Aggregate skill-gap analysis from your evaluated reports
/aijobninja followup  → Follow-up cadence tracker: flag overdue, generate drafts
/aijobninja reply-watch → Classify employer replies and suggest tracker updates
/aijobninja outcome   → Record application outcome & archive artifacts
/aijobninja calibrate → Advisory report: do your evaluation scores predict your real outcomes? Reads /outcome data; never changes scoring
/aijobninja update    → Update AIJobNinja system files with diff preview + compat check
```

Or just paste a job URL or description directly -- AIJobNinja auto-detects it and runs the full pipeline.

In Codex, slash commands are not guaranteed. Use the same mode names in a prompt instead, or call them from `codex exec`.

## How It Works

```
You paste a job URL or description
        │
        ▼
┌──────────────────┐
│  Archetype       │  Classifies: LLMOps / Agentic / PM / SA / FDE / Transformation
│  Detection       │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  A-H Evaluation  │  Match, gaps, comp research, STAR stories, legitimacy
│  (reads cv.md)   │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 Report  PDF  Tracker
  .md   .pdf  entry
```

## Antigravity CLI Integration

AIJobNinja supports Antigravity CLI natively, the same way it supports Claude Code and OpenCode. All slash commands are available through the shared skill entrypoint, using the same `modes/*.md` evaluation logic.

Google has transitioned consumer Gemini CLI access to Antigravity CLI. `GEMINI.md` is now a no-op compatibility guard so Antigravity does not duplicate the full project instructions when it reads both `AGENTS.md` and `GEMINI.md`.

### Native Antigravity CLI

```bash
# 1. Run in the AIJobNinja directory
cd AIJobNinja
agy

# 2. Use the unified /aijobninja command with subcommands:
/aijobninja "Senior AI Engineer at Anthropic..."
/aijobninja pipeline
/aijobninja scan
/aijobninja pdf
/aijobninja tracker
```

The skill is defined using the open standard in `.agents/skills/aijobninja/SKILL.md` and symlinked/referenced for each supported CLI (e.g. `.claude/`, `.qwen/`, `.antigravitycli/`, `.grok/`). Cursor automatically discovers the shared skill in `.agents/skills/`.

## Codex Integration

AIJobNinja supports Codex through the same shared router, but the invocation model is different from CLIs that auto-register slash commands. For the full guide, see [docs/CODEX.md](docs/CODEX.md).

### Interactive Codex

```bash
cd AIJobNinja
codex
```

Slash commands are not guaranteed in Codex. If `/aijobninja` is unavailable, ask Codex to run the mode directly in plain language:

```text
Evaluate this JD with AIJobNinja auto-pipeline: https://company.com/jobs/123
Run the AIJobNinja scan mode and summarize new matches.
Run the AIJobNinja pipeline mode for data/pipeline.md.
Run the AIJobNinja pdf mode for the latest evaluated role.
Run the AIJobNinja tracker mode and summarize the current statuses.
```

### One-shot Codex (`codex exec`)

```bash
codex exec "Evaluate this JD with AIJobNinja auto-pipeline: https://company.com/jobs/123"
codex exec "Run AIJobNinja scan mode in this repo and summarize new matches."
codex exec "Run AIJobNinja pipeline mode for data/pipeline.md."
codex exec "Run AIJobNinja pdf mode for the latest evaluated role."
codex exec "Run AIJobNinja tracker mode and summarize the current statuses."
```

## Grok Build CLI Integration

AIJobNinja supports Grok Build CLI natively, the same way it supports Claude Code and OpenCode. `AGENTS.md` is auto-loaded as project rules, and all slash commands are available through the shared skill entrypoint.

### Native Grok Build CLI

```bash
# 1. Run in the AIJobNinja directory
cd AIJobNinja
grok

# 2. Use the unified /aijobninja command with subcommands:
/aijobninja "Senior AI Engineer at Anthropic..."
/aijobninja pipeline
/aijobninja scan
/aijobninja pdf
/aijobninja tracker
```

For headless batch workers, use `grok -p "prompt"` (add `--yolo` to auto-approve tool executions).

## Pi Integration

AIJobNinja supports [Pi](https://github.com/earendil-works/pi) natively, with no wrapper file to maintain: Pi reads `AGENTS.md` from the repo root as project context and discovers the shared skill at `.agents/skills/aijobninja/SKILL.md` on its own. The router is then available as `/skill:aijobninja`.

### Native Pi

```bash
# 1. Run in the AIJobNinja directory
cd AIJobNinja
pi

# 2. Use the shared skill with subcommands:
/skill:AIJobNinja "Senior AI Engineer at Anthropic..."
/skill:AIJobNinja pipeline
/skill:AIJobNinja scan
/skill:AIJobNinja pdf
/skill:AIJobNinja tracker
```

### One-shot Pi (`pi -p`)

```bash
pi -p "Evaluate this JD with AIJobNinja auto-pipeline: https://company.com/jobs/123"
pi -p "Run AIJobNinja scan mode and summarize new matches."
pi -p "Run AIJobNinja tracker mode and summarize the current statuses."
```

If a Pi build gates project resources behind a trust decision, run `/trust` once inside the repo and restart `pi` so the project skill loads (`/trust` applies to future Pi processes), or start with `-a`, which trusts a single run and needs no restart.

### Standalone Gemini API Script (No CLI install needed)

```bash
# 1. Get a free API key at https://aistudio.google.com/apikey
cp .env.example .env
# Edit .env, set GEMINI_API_KEY=your_key_here

# 2. Install dependencies
npm install

# 3. Evaluate a job description
node gemini-eval.mjs "We are looking for a Senior AI Engineer..."
node gemini-eval.mjs --file ./jds/my-job.txt
node agent-inbox.mjs add "..."   # queue a request for the next session
npm run gemini:eval -- "JD text here"
```

> **Free tier:** Both options work without billing. Native CLI uses Google OAuth; the API script uses `gemini-3.6-flash` (rate limits are model- and tier-dependent; see Google AI docs for current quotas).

## Pre-configured Portals

The scanner comes with **100+ companies** ready to scan and **35+ search queries** across major job boards. Copy `templates/portals.example.yml` to `portals.yml` and add your own:

**AI Labs:** Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone
**Voice AI:** ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI
**AI Platforms:** Retool, Airtable, Vercel, Temporal, Glean, Arize AI
**Contact Center:** Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys
**Enterprise:** Salesforce, Twilio, Gong, Dialpad
**LLMOps:** Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics
**Automation:** n8n, Zapier, Make.com
**European:** Factorial, Attio, Tinybird, Clarity AI, Travelperk

**Job boards searched:** 55+ provider modules cover ATS APIs, board-wide feeds, XML/RSS feeds, markdown feeds, and local parsers. See [Supported job boards](docs/SUPPORTED_JOB_BOARDS.md) for the full table.

Keep the list current: `portals.yml` is designed to stay live, not be a one-time setup file. See [Keeping portals.yml live](docs/KEEPING_PORTALS_LIVE.md) for the house rule that adds new companies automatically and the commands to validate the file after every change.

By default `node scan.mjs` (a.k.a. `npm run scan`) trusts what each ATS feed returns. Some companies leave stale postings in their public API even after the role is closed, so those expired entries can leak into `pipeline.md`. Pass `--verify` to launch Playwright after the API pass and drop expired postings before they hit the pipeline:

```bash
node scan.mjs --verify          # zero-token discovery + Playwright liveness check
```

The verification is sequential and only runs against new offers (after dedup), so the cost stays bounded.

## Dashboard TUI

The built-in terminal dashboard lets you browse your pipeline visually:

```bash
npm run serve:dashboard   # launch the TUI
npm run build:dashboard   # optional: build the standalone binary
```

Features: 10 filter tabs, 8 sort modes, grouped/flat view, lazy-loaded previews, inline status changes.

There is also an **experimental web UI** (alpha and opt-in: nothing runs unless you start it): see [`web/README.md`](web/README.md).

## Project Structure

```
aijobninja/
├── AGENTS.md                    # Canonical agent instructions (all CLIs)
├── CLAUDE.md                    # Claude Code wrapper (imports AGENTS.md)
├── CODEX.md                     # Codex wrapper (imports AGENTS.md)
├── OPENCODE.md                  # OpenCode wrapper (imports AGENTS.md)
├── GEMINI.md                    # Legacy no-op guard to avoid Antigravity duplicate context
├── cv.md                        # Your CV (create this)
├── article-digest.md            # Your proof points (optional)
├── config/
│   └── profile.example.yml      # Template for your profile
├── modes/                       # Skill modes
│   ├── _shared.md               # Shared context (customize this)
│   ├── oferta.md                # Single evaluation
│   ├── pdf.md                   # PDF generation
│   ├── cover.md                 # Cover letter generation
│   ├── email.md                 # Formal application email drafts
│   ├── scan.md                  # Portal scanner
│   ├── batch.md                 # Batch processing
│   └── ...
├── templates/
│   ├── cv-template.html         # ATS-optimized CV template
│   ├── portals.example.yml      # Scanner config template
│   └── states.yml               # Canonical statuses
├── batch/
│   ├── batch-prompt.md          # Self-contained worker prompt
│   └── batch-runner.sh          # Orchestrator script
├── dashboard/                   # Go TUI pipeline viewer
├── data/                        # Your tracking data (gitignored)
├── reports/                     # Evaluation reports (gitignored)
├── output/                      # Generated PDFs (gitignored)
├── fonts/                       # Space Grotesk + DM Sans
├── docs/                        # Setup, customization, budget guide, architecture
├── modules/job-finder/          # Nordic portal CLIs, search UI, LaTeX workflow
├── site/                        # Static landing page (served by Vercel, see vercel.json)
└── examples/                    # Sample CV, report, proof points
```

## External Data Directory (Optional)

By default, user-layer data (such as `cv.md`, `portals.yml`, and `data/` / `reports/` / `output/` folders) lives inside the project root folder. 

To separate your personal data from the code (making it easier to switch branches, pull updates, or test multiple profiles), you can configure an external data directory using the following precedence:

1. **Environment Variables:** Set the `AIJOBNINJA_ROOT` or `AIJOBNINJA_DATA_DIR` environment variable:
   ```bash
   export AIJOBNINJA_ROOT=~/my-career-data
   ```
2. **Marker File:** Create a `.aijobninja-data` file in the repository root containing the path to your data directory.
3. **Default:** Defaults to the repository root.

Once resolved, all user files are resolved and written relative to that folder, while prompt files and scripts continue to resolve relative to the repository. 

- **Tracker Override:** You can also set `AIJOBNINJA_TRACKER` to override the applications tracker file path directly.
- **Writes:** All write operations (such as merges) canonically target `{DATA_ROOT}/data/applications.md`.
- **Scanner config:** `portals.yml` is read and validated at `{DATA_ROOT}/portals.yml`, so `node validate-portals.mjs` checks the same file `scan.mjs` reads.
- **Generated documents:** tailored CVs and cover letters are written under `{DATA_ROOT}/output/`, and the PDF manifest that links them to a report lives at `{DATA_ROOT}/data/pdf-index.tsv`. While `AIJOBNINJA_TRACKER` is unset, the tracker workspace that bounds those writes is the data root, not the checkout.
- **PDFs under a tracker override:** `generate-pdf.mjs` resolves `AIJOBNINJA_TRACKER` before it derives the workspace, so with the override set the workspace is the folder that holds that tracker (or the folder above it, when the tracker sits in a `data/` folder). The CV's HTML and every PDF must then sit inside that workspace, and the manifest moves to its `data/pdf-index.tsv`. Cover letters still target `{DATA_ROOT}/output/`, so they are refused when that folder falls outside the tracker's workspace.
- **Code layer stays put:** `node_modules/`, `providers/`, `modes/` and the scripts themselves always resolve against the repository, never the data root.

The Go dashboard TUI, Node.js scripts, and AI agent modes all automatically respect this resolution hierarchy.


## Tech Stack

![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white)
![Bubble Tea](https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white)

- **Agent**: AI coding CLI with shared skills and modes (`AGENTS.md` + CLI wrapper)
- **PDF**: Playwright + HTML template
- **Cover letters**: HTML template + Playwright (A4 PDF, same pipeline as CVs)
- **Scanner**: Playwright + Greenhouse API + WebSearch
- **Dashboard**: Go + Bubble Tea + Lipgloss (Catppuccin Mocha theme)
- **Job Finder**: Bun HTTP server + plain HTML/CSS/JS, Python tools, LaTeX
- **Data**: Markdown tables + YAML config + TSV batch files

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Built_with-Claude_Code-000?style=for-the-badge&logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<p align="center">
  <sub>Also runs on any agent-skill-standard CLI. See <a href="docs/SUPPORTED_CLIS.md">Supported CLIs</a>.</sub><br>
  <img src="https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/OpenCode-111827?style=flat&logo=terminal&logoColor=white" alt="OpenCode">
  <img src="https://img.shields.io/badge/Antigravity_CLI-4285F4?style=flat&logo=google&logoColor=white" alt="Antigravity CLI">
  <img src="https://img.shields.io/badge/Codex-412991?style=flat&logo=openai&logoColor=white" alt="Codex">
  <img src="https://img.shields.io/badge/Qwen-615CED?style=flat" alt="Qwen">
  <img src="https://img.shields.io/badge/Kimi-FF4B4B?style=flat" alt="Kimi">
  <img src="https://img.shields.io/badge/GitHub_Copilot-000?style=flat&logo=githubcopilot&logoColor=white" alt="GitHub Copilot">
  <img src="https://img.shields.io/badge/Grok_Build_CLI-000?style=flat&logo=x&logoColor=white" alt="Grok Build CLI">
  <img src="https://img.shields.io/badge/Pi-4B3F72?style=flat" alt="Pi">
  <br>
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white" alt="Bubble Tea">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT">
</p>

## Disclaimer


**AIJobNinja is a local, open-source tool, NOT a hosted service.** By using this software, you acknowledge:

1. **You control your data.** Your CV, contact info, and personal data stay on your machine and are sent directly to the AI provider you choose (Anthropic, OpenAI, etc.). We do not collect, store, or have access to any of your data.
2. **You control the AI.** The default prompts instruct the AI not to auto-submit applications, but AI models can behave unpredictably. If you modify the prompts or use different models, you do so at your own risk. **Always review AI-generated content for accuracy before submitting.**
3. **You comply with third-party ToS.** You must use this tool in accordance with the Terms of Service of the career portals you interact with (Greenhouse, Lever, Workday, LinkedIn, etc.). Do not use this tool to spam employers or overwhelm ATS systems.
4. **No guarantees.** Evaluations are recommendations, not truth. AI models may hallucinate skills or experience. The authors are not liable for employment outcomes, rejected applications, account restrictions, or any other consequences.

See [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) for full details. This software is provided under the [MIT License](LICENSE) "as is", without warranty of any kind.

## License

MIT. See [LICENSE](LICENSE).
