# Supported CLIs

AIJobNinja is AI-agnostic and runs on several command-line agent tools. The core logic is shared via `AGENTS.md`, while CLI-specific nuances are handled through entry wrappers in the repository root.

| CLI | Entry File | How to Invoke |
| --- | --- | --- |
| Claude Code | `CLAUDE.md` | Interactive: `claude` (then `/aijobninja`). Headless/Batch: `claude -p "prompt"` |
| Cursor | `AGENTS.md` | Interactive: open the project in Cursor and ask for `aijobninja` (auto-discovered from `.agents/skills/aijobninja/SKILL.md`) |
| Codex | `CODEX.md` (see [`docs/CODEX.md`](CODEX.md)) | Interactive: `codex` (then use plain text). Headless/Batch: `codex exec "prompt"` |
| OpenCode | `OPENCODE.md` | Interactive: `opencode` (then `/aijobninja`). Headless/Batch: `opencode run "prompt"` |
| Pi | `AGENTS.md` | Interactive: `pi` (then `/skill:aijobninja`). Headless/Batch: `pi -p "prompt"` |
| Antigravity CLI | `AGENTS.md` | Interactive: `agy` (then `/aijobninja`). Headless/Batch: `agy -p "prompt"` |
| Grok Build CLI | `AGENTS.md` | Interactive: `grok` (then `/aijobninja`). Headless/Batch: `grok -p "prompt"` |
| Qwen | `AGENTS.md` | Interactive: `qwen`. Headless/Batch: `qwen -p "prompt"` |
| Kimi | `KIMI.md` | Interactive: `kimi` |
| GitHub Copilot CLI | `AGENTS.md` | Headless/Batch: `copilot -p "prompt"` |
| Gemini | `GEMINI.md` | Legacy wrapper redirecting to `AGENTS.md` (transitioned to Antigravity CLI). |
| Hermes Agent | `AGENTS.md` | Interactive: `hermes` (then ask for a AIJobNinja task). Web read-only workers: `hermes chat -q "prompt" --oneshot -Q --no-restore-cwd`. Batch ranking: unsupported. |

## Hermes Agent

Hermes runs the same pipeline as every other CLI here. Trust the checkout once with `hermes skills trust` before interactive use. The web UI uses Hermes's one-shot mode (`hermes chat -q ... --oneshot -Q --no-restore-cwd`) only for explicitly non-writing workers; evaluation and portal-repair workers reject it because no verified Hermes permission adapter exists. Batch ranking does not support Hermes. Hermes project-context scanning still applies; see [`docs/HERMES.md`](HERMES.md) for its rules and limitations.

## Pi

Pi needs no wrapper file: it reads `AGENTS.md` from the working directory as project context, and it discovers the shared skill at `.agents/skills/aijobninja/SKILL.md` on its own. In interactive mode the router is available as `/skill:aijobninja`; `--skill <path>` loads it explicitly, and `-p` runs one headless prompt.

```bash
cd AIJobNinja
pi                                          # interactive
pi -p "Evaluate this JD with AIJobNinja auto-pipeline: https://company.com/jobs/123"
```
