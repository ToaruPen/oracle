import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { BrowserLogger, ChromeClient } from '../../src/browser/types.js';
import { resumeBrowserSession } from '../../src/browser/reattach.js';

const launchChrome = vi.hoisted(() => vi.fn());
const connectToChrome = vi.hoisted(() => vi.fn());
const hideChromeWindow = vi.hoisted(() => vi.fn());

vi.mock('../../src/browser/chromeLifecycle.js', () => ({
  launchChrome,
  connectToChrome,
  hideChromeWindow,
}));

const navigateToChatGPT = vi.hoisted(() => vi.fn());
const ensureNotBlocked = vi.hoisted(() => vi.fn());
const ensureLoggedIn = vi.hoisted(() => vi.fn());
const ensurePromptReady = vi.hoisted(() => vi.fn());
const readAssistantSnapshot = vi.hoisted(() => vi.fn());
const waitForAssistantResponse = vi.hoisted(() => vi.fn());
const captureAssistantMarkdown = vi.hoisted(() => vi.fn());

vi.mock('../../src/browser/pageActions.js', () => ({
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  readAssistantSnapshot,
  waitForAssistantResponse,
  captureAssistantMarkdown,
}));

beforeEach(() => {
  launchChrome.mockReset();
  connectToChrome.mockReset();
  hideChromeWindow.mockReset();
  navigateToChatGPT.mockReset();
  ensureNotBlocked.mockReset();
  ensureLoggedIn.mockReset();
  ensurePromptReady.mockReset();
  readAssistantSnapshot.mockReset();
  waitForAssistantResponse.mockReset();
  captureAssistantMarkdown.mockReset();
});

describe('resumeBrowserSession (new Chrome recovery)', () => {
  test('reopens conversation and returns captured markdown when existing Chrome attach fails', async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: '127.0.0.1',
      tabUrl: 'https://chatgpt.com/c/demo',
    };
    const listTargets = vi.fn(async () => {
      throw new Error('chrome crashed');
    });

    const chromeKill = vi.fn(async () => {});
    launchChrome.mockResolvedValue({ pid: 4242, port: 61616, kill: chromeKill });

    const runtimeEvaluate = vi.fn(async () => ({ result: { value: 2 } }));
    connectToChrome.mockResolvedValue({
      // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
      Network: {},
      // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
      Page: {},
      // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
      Runtime: { enable: vi.fn(), evaluate: runtimeEvaluate },
      // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
      DOM: { enable: vi.fn() },
      close: vi.fn(async () => {}),
    } as unknown as ChromeClient);

    navigateToChatGPT.mockResolvedValue(undefined);
    ensureNotBlocked.mockResolvedValue(undefined);
    ensureLoggedIn.mockResolvedValue(undefined);
    ensurePromptReady.mockResolvedValue(undefined);

    const waitForAssistantResponseStub = vi.fn(async () => ({
      text: 'plain response',
      html: '',
      meta: { messageId: 'm1', turnId: 'conversation-turn-1' },
    }));
    const captureAssistantMarkdownStub = vi.fn(async () => 'captured **markdown**');
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { manualLogin: false, cookieSync: false, timeoutMs: 2_000, inputTimeoutMs: 500 },
      logger,
      {
        listTargets,
        waitForAssistantResponse: waitForAssistantResponseStub,
        captureAssistantMarkdown: captureAssistantMarkdownStub,
      },
    );

    const navigatedUrls = navigateToChatGPT.mock.calls.map((call) => call[2]);
    expect(listTargets).toHaveBeenCalled();
    expect(launchChrome).toHaveBeenCalled();
    expect(connectToChrome).toHaveBeenCalledWith(61616, logger, '127.0.0.1');
    expect(navigatedUrls).toContain('https://chatgpt.com/c/demo');
    expect(result.answerMarkdown).toBe('captured **markdown**');
    expect(captureAssistantMarkdownStub).toHaveBeenCalled();
  });
});
