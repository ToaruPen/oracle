---
name: oracle
description: Runs the Oracle CLI (local fork preferred) to bundle a prompt plus selected files and get a second-model review via API or browser automation. Use for debugging, refactors, design checks, or cross-validation when the agent needs another model to see concrete repo context.
---

# Oracle (CLI) — local fork first

Oracle bundles a prompt + selected files into one “one-shot” request so another model can answer with real repo context. Treat outputs as advisory: verify against the codebase + tests.

## Entry points (prefer local)

- Prefer the local wrapper (works from any directory):
  - `oracle-local …` / `oracle-mcp-local`
- If the wrapper is not installed, run from this repo root:
  - `pnpm run oracle -- …` (TypeScript → `dist/` first)
  - `node ./dist/bin/oracle-cli.js …` (requires `pnpm build` once)

## Main use case (browser, GPT‑5.2 Pro)

Default workflow: `--engine browser` with `--model gpt-5.2-pro`. This is the “human-in-the-loop” path (often minutes); it creates a stored session you can reattach to.

Recommended defaults:
- Browser engine: `--engine browser`
- Pro model: `--model gpt-5.2-pro --browser-model-strategy select`
- Keep ChatGPT history clean: `--browser-cleanup-conversation archive` (or `delete`, which may fall back to `archive`)

## Golden path

1. Pick the smallest file set that contains the truth.
2. Preview before spending tokens (`--dry-run` + `--files-report`).
3. Run; if it detaches/times out, reattach instead of re-running.

## Commands (use the same flags with `pnpm run oracle --` if needed)

- Help:
  - `oracle-local --help`

- Preview (no tokens):
  - `oracle-local --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `oracle-local --dry-run full -p "<task>" --file "src/**"`

- Token/cost sanity:
  - `oracle-local --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run (GPT‑5.2 Pro, history archived):
  - `oracle-local --engine browser --model gpt-5.2-pro --browser-model-strategy select --browser-cleanup-conversation archive -p "<task>" --file "src/**"`

- API run (requires `OPENAI_API_KEY`; Pro may detach unless `--wait` is set):
  - `oracle-local --engine api --model gpt-5.2-pro --wait -p "<task>" --file "src/**"`

- Manual paste fallback (assemble bundle, copy to clipboard):
  - `oracle-local --render --copy -p "<task>" --file "src/**"`

## Attaching files (`--file`)

`--file` accepts files, directories, and globs. You can pass it multiple times; entries can be comma-separated.

- Include:
  - `--file "src/**"` (directory glob)
  - `--file src/index.ts` (literal file)
  - `--file docs --file README.md` (literal directory + file)

- Exclude (prefix with `!`):
  - `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`

Notes:
- Avoid secrets (`.env`, key files, auth tokens). Prefer minimal, relevant context.
- If you need to understand browser flags/endpoints, see `docs/browser-mode.md`.

## Budget + observability

- Target: keep total input under ~196k tokens.
- Use `--files-report` (and/or `--dry-run json`) to spot the token hogs before spending.
- If you need the full option set: `oracle-local --help --verbose`.

## Engines (API vs browser)

- Auto-pick: uses `api` when `OPENAI_API_KEY` is set, otherwise `browser`.
- Browser engine supports GPT + Gemini only; use `--engine api` for Claude/Grok/Codex or multi-model runs.
- Browser attachments:
  - `--browser-attachments auto|never|always` (auto pastes inline up to ~60k chars then uploads).
- Remote browser host (signed-in machine runs automation):
  - Host: `oracle-local serve --host 0.0.0.0 --port 9473 --token <secret>`
  - Client: `oracle-local --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`

## Sessions + slugs (don’t lose work)

- Stored under `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).
- Runs may detach or take a long time (browser + GPT‑5.2 Pro often does). If the CLI times out: don’t re-run; reattach.
  - List: `oracle-local status --hours 72`
  - Attach: `oracle-local session <id> --render`
- Use `--slug "<3-5 words>"` to keep session IDs readable.
- Duplicate prompt guard exists; use `--force` only when you truly want a fresh run.

## Prompt checklist

Include:
- The goal + desired output (patch, review, options, etc.)
- Repro steps + exact errors (verbatim)
- Constraints (don’t change X, API stability, perf budget)
