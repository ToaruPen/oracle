# Remote Chrome Service Debug Log

## Context
- Date: 2025-11-20 (US timezone)
- Goal: Run Oracle browser mode from local laptop against VM-hosted Chrome via new `oracle serve` remote service.
- VM IP: 192.168.64.2
- Service port/token used during attempts: 49810 / `cd93955b64d5afcb946a4a4a89651313`

## Attempts

### 1) Local run via remote host
Command:
```
oracle --engine browser \
  --remote-host 192.168.64.2:49810 \
  --remote-token cd93955b64d5afcb946a4a4a89651313 \
  --remote-cookie-source none \
  --prompt "Remote service sanity check" \
  --wait
```
Outcome:
- Initially routed to local Chrome (before wiring fix).
- After wiring fix, logs show “Routing browser automation to remote host …” but requests fail with:
  - `ECONNREFUSED 192.168.64.2:49810` when no service listening.
  - `busy` when a previous service process was still bound.
  - Later run reached remote path but failed model switch: `Unable to find model option matching "GPT-5.1 Pro"` (remote Chrome not logged into ChatGPT / model picker mismatch).

### 2) Remote service on VM
Actions taken on VM (tmux `vmssh`):
- Installed bun (`~/.bun/bin/bun`), added to PATH in `~/.zshrc`.
- `./runner` requires bun; starting service with:
  ```
  cd ~/Projects/oracle
  export PATH="$HOME/.bun/bin:$PATH"
  ./runner pnpm run oracle -- serve --port 49810 --token cd93955b64d5afcb946a4a4a89651313
  ```
- When started correctly, logs show:
  ```
  Remote Oracle listening at 0.0.0.0:49810
  Access token: cd93955b64d5afcb946a4a4a89651313
  ```
- One run failed with EADDRINUSE when a stale node listener stayed on 49810; resolved by killing `node ...49810`.

### Observed blockers
- Environment PATH: bun not on PATH for non-interactive shells caused `./runner` to fail; need to `export PATH="$HOME/.bun/bin:$PATH"` before starting service.
- Port collisions: prior listeners on 49810 caused ECONNREFUSED/busy.
- Remote model switch failed: remote Chrome likely not signed into ChatGPT; model picker couldn’t find “GPT-5.1 Pro”.

## Next steps
- On VM: start service in a clean shell with bun on PATH:
  ```
  cd ~/Projects/oracle
  export PATH="$HOME/.bun/bin:$PATH"
  ./runner pnpm run oracle -- serve --port 49810 --token cd93955b64d5afcb946a4a4a89651313
  ```
  Leave it running; verify with `lsof -nP -iTCP:49810 -sTCP:LISTEN`.
- Sign into ChatGPT in the VM’s Chrome profile used by the service so model switching succeeds, or set `--remote-cookie-source local` on the client once remote path is stable.
- Retry local command above; ensure service logs show incoming /runs.
- Optional: switch to a fresh port/token (`oracle serve` with no args) to avoid lingering listeners.

## Notes
- Remote mode now forces `--wait`, disables detach, and logs when routing to remote executor.
- Client uses NDJSON streaming; remote server serializes attachments per run and cleans temp dirs.
