import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveBrowserConfig } from './config.js';
import type { BrowserRunOptions, BrowserRunResult, BrowserLogger } from './types.js';
import { launchChrome, registerTerminationHooks, hideChromeWindow, connectToChrome } from './chromeLifecycle.js';
import { syncCookies } from './cookies.js';
import {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
} from './pageActions.js';
import { estimateTokenCount } from './utils.js';

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from './types.js';
export { CHATGPT_URL, DEFAULT_MODEL_TARGET } from './constants.js';
export { parseDuration, delay } from './utils.js';

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error('Prompt text is required when using browser mode.');
  }

  const config = resolveBrowserConfig(options.config);
  const logger: BrowserLogger = options.log ?? (() => {});
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...config,
        promptLength: promptText.length,
      })}`,
    );
  }

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-browser-'));
  logger(`Created temporary Chrome profile at ${userDataDir}`);

  const chrome = await launchChrome(config, userDataDir, logger);
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(chrome, userDataDir, config.keepBrowser, logger);
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: Awaited<ReturnType<typeof connectToChrome>> | null = null;
  const startedAt = Date.now();
  let answerText = '';
  let answerMarkdown = '';
  let answerHtml = '';
  let runStatus: 'attempted' | 'complete' = 'attempted';

  try {
    client = await connectToChrome(chrome.port, logger);
    const { Network, Page, Runtime, Input } = client;

    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    await Promise.all([Network.enable({}), Page.enable(), Runtime.enable()]);
    await Network.clearBrowserCookies();

    if (config.cookieSync) {
      const cookieCount = await syncCookies(
        Network,
        config.url,
        config.chromeProfile,
        logger,
        config.allowCookieErrors ?? false,
      );
      logger(
        cookieCount > 0
          ? `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? 'Default'}`
          : 'No Chrome cookies found; continuing without session reuse',
      );
    } else {
      logger('Skipping Chrome cookie sync (--browser-no-cookie-sync)');
    }

    await navigateToChatGPT(Page, Runtime, config.url, logger);
    await ensureNotBlocked(Runtime, config.headless, logger);
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    logger(`Prompt textarea ready (${promptText.length.toLocaleString()} chars queued)`);
    if (config.desiredModel) {
      await ensureModelSelection(Runtime, config.desiredModel, logger);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      logger(`Prompt textarea re-focused after model switch (${promptText.length.toLocaleString()} chars queued)`);
    }
    await submitPrompt({ runtime: Runtime, input: Input }, promptText, logger);
    const answer = await waitForAssistantResponse(Runtime, config.timeoutMs, logger);
    answerText = answer.text;
    answerHtml = answer.html ?? '';
    const copiedMarkdown = await captureAssistantMarkdown(Runtime, answer.meta, logger);
    answerMarkdown = copiedMarkdown ?? answerText;
    runStatus = 'complete';
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      userDataDir,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to complete ChatGPT run: ${message}`);
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') && error instanceof Error && error.stack) {
      logger(error.stack);
    }
    throw error;
  } finally {
    try {
      await client?.close();
    } catch {
      // ignore
    }
    removeTerminationHooks?.();
    if (!config.keepBrowser) {
      try {
        chrome.kill();
      } catch {
        // ignore
      }
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      const totalSeconds = (Date.now() - startedAt) / 1000;
      logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
    } else {
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
  }
}

export { estimateTokenCount } from './utils.js';
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from './config.js';
export { syncCookies } from './cookies.js';
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
} from './pageActions.js';
