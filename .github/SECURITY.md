# Security Policy

## Supported versions

Security fixes go into the latest release. Update with `node update-system.mjs apply --confirm` (or `git pull`) before reporting.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/mannysinghx/AIJOBNINJA/security/advisories/new). Include:

1. A description of the vulnerability
2. Steps to reproduce
3. The impact you expect
4. A suggested fix, if you have one

You will get an acknowledgement as soon as possible, and a fix or mitigation plan once the report is confirmed.

## Scope

AIJobNinja runs locally. The most relevant classes of issue are:

- Untrusted job-posting content steering an AI agent (prompt injection) past the rules in `AGENTS.md`
- Server-side request forgery or private-network access from scanners and providers
- Personal data (CV, profile, tracker) leaking into commits, logs or network requests
- Unsafe file writes outside the data root
