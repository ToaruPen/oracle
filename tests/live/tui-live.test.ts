import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Gate on live flag + API key to avoid accidental spend.
const LIVE = process.env.ORACLE_LIVE_TEST === '1' && Boolean(process.env.OPENAI_API_KEY);

// Optional PTY dependency (same as other PTY tests).
let pty: any | null = null;
try {
  // biome-ignore lint/suspicious/noExplicitAny: third-party pty module ships without types
  const mod: any = await import('@cdktf/node-pty-prebuilt-multiarch').catch(() =>
    import('@homebridge/node-pty-prebuilt-multiarch'),
  );
  pty = mod.default ?? mod;
} catch {
  // leave null; test will be skipped.
}

const NODE_BIN = process.execPath;

const liveDescribe = LIVE && pty ? describe : describe.skip;

liveDescribe('live TUI flow (API, multi-model)', () => {
  it(
    'runs ask-oracle via TUI, selects extra model, and writes a session',
    async () => {
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-tui-live-'));
      const env = {
        ...process.env,
        ORACLE_FORCE_TUI: '1',
        ORACLE_HOME_DIR: tmpHome,
        FORCE_COLOR: '0',
        CI: '',
      } satisfies Record<string, string | undefined>;

      const entry = path.join(process.cwd(), 'dist/bin/oracle-cli.js');
      const ps = pty.spawn(NODE_BIN, [entry], {
        name: 'xterm-color',
        cols: 100,
        rows: 40,
        cwd: process.cwd(),
        env,
      });

      let output = '';
      ps.onData((d: string) => {
        output += d;
        if (output.includes('Paste your prompt text')) {
          ps.write('Live TUI multi-model smoke\n');
        } else if (output.includes('Engine')) {
          ps.write('\r'); // accept default (API)
        } else if (output.includes('Optional slug')) {
          ps.write('\r'); // no slug
        } else if (output.includes('Model')) {
          ps.write('\r'); // default first model
        } else if (output.includes('Additional API models')) {
          // Down arrow to second model, select with space, then submit.
          ps.write('\u001b[B \r');
        } else if (output.includes('Files or globs to attach')) {
          ps.write('\r'); // none
        }
      });

      const { exitCode } = await new Promise<{ exitCode: number | null; signal: number | null }>((resolve) => {
        ps.onExit((evt: { exitCode: number | null; signal: number | null }) => resolve(evt));
      });

      const sessionsDir = path.join(tmpHome, 'sessions');
      const entries = await fs.readdir(sessionsDir);
      expect(entries.length).toBeGreaterThan(0);

      const newest = entries.sort().pop() as string;
      const metaPath = path.join(sessionsDir, newest, 'meta.json');
      const metaRaw = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
        id: string;
        options?: { models?: string[] };
        usage?: { totalTokens?: number };
      };

      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});

      expect(exitCode).toBe(0);
      expect(metaRaw.id).toBeTruthy();
      expect(metaRaw.options?.models?.length ?? 1).toBeGreaterThan(1); // multi-model fan-out recorded
      expect(output.toLowerCase()).toContain('session');
    },
    180_000,
  );
});
