import { describe, expect, test } from 'vitest';
import { runBrowserMode } from '../../src/browser/index.js';
import { getCookies } from '@steipete/sweet-cookie';
import { acquireLiveTestLock, releaseLiveTestLock } from './liveLock.js';

const LIVE = process.env.ORACLE_LIVE_TEST === '1';
const DEFAULT_PROJECT_URLS = [
  'https://chatgpt.com/g/g-p-69505ed97e3081918a275477a647a682/project',
  'https://chatgpt.com/g/g-p-691edc9fec088191b553a35093da1ea8-oracle/project',
];
const PROJECT_URLS = process.env.ORACLE_CHATGPT_PROJECT_URL
  ? [process.env.ORACLE_CHATGPT_PROJECT_URL]
  : DEFAULT_PROJECT_URLS;

async function hasChatGptCookies(): Promise<boolean> {
  try {
    const { cookies } = await getCookies({
      url: 'https://chatgpt.com',
      origins: ['https://chatgpt.com', 'https://chat.openai.com', 'https://atlas.openai.com'],
      browsers: ['chrome'],
      mode: 'merge',
      chromeProfile: 'Default',
      timeoutMs: 5_000,
    });
    const hasSession = cookies.some((cookie) => cookie.name.startsWith('__Secure-next-auth.session-token'));
    if (!hasSession) {
      console.warn(
        'Skipping ChatGPT new-chat live test (missing __Secure-next-auth.session-token). Open chatgpt.com in Chrome and retry.',
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractConversationId(url: string | undefined | null): string | undefined {
  const value = String(url ?? '');
  const idx = value.indexOf('/c/');
  if (idx === -1) return undefined;
  const rest = value.slice(idx + 3);
  return rest.split(/[/?#]/)[0] || undefined;
}

(LIVE ? describe : describe.skip)('ChatGPT browser live new chat', () => {
  test(
    'starts a fresh thread when targeting a project URL twice',
    async () => {
      if (!(await hasChatGptCookies())) return;
      await acquireLiveTestLock('chatgpt-browser');
      try {
        const projectUrl = PROJECT_URLS.find((url) => url.includes('/g/'));
        if (!projectUrl) {
          console.warn('Skipping new-chat live test (project URL missing).');
          return;
        }

        const tokenA = `live new chat a ${Date.now()}`;
        const runA = await runBrowserMode({
          prompt: `${tokenA}\nReply with OK only.`,
          config: {
            chromeProfile: 'Default',
            url: projectUrl,
            desiredModel: 'GPT-5.2',
            timeoutMs: 240_000,
            inputTimeoutMs: 60_000,
            cleanupConversation: 'none',
          },
        });
        expect(runA.answerText.toLowerCase()).toContain('ok');
        const idA = extractConversationId(runA.tabUrl ?? '');
        expect(idA, `Expected /c/<id> in tabUrl but got: ${runA.tabUrl ?? '(missing)'}`).toBeTruthy();

        const tokenB = `live new chat b ${Date.now()}`;
        const runB = await runBrowserMode({
          prompt: `${tokenB}\nReply with OK only.`,
          config: {
            chromeProfile: 'Default',
            url: projectUrl,
            desiredModel: 'GPT-5.2',
            timeoutMs: 240_000,
            inputTimeoutMs: 60_000,
            cleanupConversation: 'none',
          },
        });
        expect(runB.answerText.toLowerCase()).toContain('ok');
        const idB = extractConversationId(runB.tabUrl ?? '');
        expect(idB, `Expected /c/<id> in tabUrl but got: ${runB.tabUrl ?? '(missing)'}`).toBeTruthy();
        expect(idB).not.toBe(idA);
      } finally {
        await releaseLiveTestLock('chatgpt-browser');
      }
    },
    12 * 60 * 1000,
  );
});

