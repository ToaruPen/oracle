import { describe, test, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { runBrowserMode } from '../../src/browser/index.js';
import { acquireLiveTestLock, releaseLiveTestLock } from './liveLock.js';
import { getCookies } from '@steipete/sweet-cookie';

const LIVE = process.env.ORACLE_LIVE_TEST === '1';
const FAST = process.env.ORACLE_LIVE_TEST_FAST === '1';
const TEMPORARY_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function hasChatGptSession(): Promise<boolean> {
  try {
    const { cookies } = await getCookies({
      url: 'https://chatgpt.com',
      origins: ['https://chatgpt.com', 'https://chat.openai.com', 'https://atlas.openai.com'],
      browsers: ['chrome'],
      mode: 'merge',
      chromeProfile: 'Default',
      timeoutMs: 5_000,
    });
    return cookies.some((cookie) => cookie.name.startsWith('__Secure-next-auth.session-token'));
  } catch {
    return false;
  }
}

(LIVE && FAST ? describe : describe.skip)('ChatGPT browser fast live', () => {
  test(
    'falls back when a project URL is missing',
    async () => {
      if (!(await hasChatGptSession())) {
        console.warn('Skipping fast live test (missing ChatGPT session cookie).');
        return;
      }
      await acquireLiveTestLock('chatgpt-browser');
      try {
        const promptToken = `fast fallback ${Date.now()}`;
        const result = await runBrowserMode({
          prompt: `${promptToken}\nReply with OK only.`,
          config: {
            url: 'https://chatgpt.com/g/does-not-exist/project',
            timeoutMs: 180_000,
            inputTimeoutMs: 20_000,
          },
        });
        expect(result.answerText.toLowerCase()).toContain('ok');
      } finally {
        await releaseLiveTestLock('chatgpt-browser');
      }
    },
    6 * 60 * 1000,
  );

  test(
    'uploads attachments and sends the prompt (gpt-5.2)',
    async () => {
      if (!(await hasChatGptSession())) {
        console.warn('Skipping fast live test (missing ChatGPT session cookie).');
        return;
      }
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-fast-live-'));
      await acquireLiveTestLock('chatgpt-browser');
      try {
        const fileA = path.join(tmpDir, 'oracle-fast-a.txt');
        const fileB = path.join(tmpDir, 'oracle-fast-b.txt');
        await writeFile(fileA, `fast file a ${Date.now()}`);
        await writeFile(fileB, `fast file b ${Date.now()}`);
        const [statA, statB] = await Promise.all([stat(fileA), stat(fileB)]);
        const promptToken = `fast upload ${Date.now()}`;
        const result = await runBrowserMode({
          prompt: `${promptToken}\nReply with OK only.`,
          attachments: [
            { path: fileA, displayPath: 'oracle-fast-a.txt', sizeBytes: statA.size },
            { path: fileB, displayPath: 'oracle-fast-b.txt', sizeBytes: statB.size },
          ],
          config: {
            url: TEMPORARY_CHAT_URL,
            timeoutMs: 240_000,
            inputTimeoutMs: 60_000,
            desiredModel: 'GPT-5.2',
          },
        });
        expect(result.answerText.toLowerCase()).toContain('ok');
      } finally {
        await releaseLiveTestLock('chatgpt-browser');
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    8 * 60 * 1000,
  );

  test(
    'preserves Markdown formatting (bullets + fenced code)',
    async () => {
      if (!(await hasChatGptSession())) {
        console.warn('Skipping fast live test (missing ChatGPT session cookie).');
        return;
      }
      await acquireLiveTestLock('chatgpt-browser');
      try {
        const promptToken = `fast markdown ${Date.now()}`;
        const result = await runBrowserMode({
          prompt: [
            `Token: ${promptToken}`,
            '',
            'Return exactly this Markdown (no extra text):',
            `- bullet A: ${promptToken}`,
            `- bullet B: ${promptToken}`,
            '',
            '```js',
            `console.log("${promptToken}")`,
            '```',
          ].join('\n'),
          config: {
            url: TEMPORARY_CHAT_URL,
            timeoutMs: 240_000,
            inputTimeoutMs: 60_000,
            desiredModel: 'GPT-5.2',
          },
        });

        const answerMarkdown = result.answerMarkdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const answerHtml = (result.answerHtml ?? '').slice(0, 800).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const listLines = answerMarkdown.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+|[•·・]\s+)/gm) ?? [];
        expect(
          listLines.length,
          `Expected at least 2 list items but saw ${listLines.length}.\n---\n${answerMarkdown.slice(0, 1000)}\n---\n[answerHtml]\n---\n${answerHtml}\n---`,
        ).toBeGreaterThanOrEqual(2);

        const tokenPattern = escapeRegExp(promptToken);
        expect(answerMarkdown).toMatch(
          new RegExp(`^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+|[•·・]\\s+).*${tokenPattern}.*$`, 'm'),
        );

        const fencedBlocks = Array.from(answerMarkdown.matchAll(/```[\s\S]*?```/g)).map((match) => match[0] ?? '');
        expect(
          fencedBlocks.length,
          `Expected at least 1 fenced code block.\n---\n${answerMarkdown.slice(0, 1000)}\n---`,
        ).toBeGreaterThanOrEqual(1);
        expect(
          fencedBlocks.some((block) => new RegExp(tokenPattern).test(block)),
          `Expected token inside a fenced code block.\n---\n${answerMarkdown.slice(0, 1000)}\n---`,
        ).toBe(true);
      } finally {
        await releaseLiveTestLock('chatgpt-browser');
      }
    },
    8 * 60 * 1000,
  );
});
