import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  CONVERSATION_TURN_SELECTOR,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';
import { BrowserAutomationError } from '../../oracle/errors.js';

const ENTER_KEY_EVENT = {
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = '\r';

export async function submitPrompt(
  deps: {
    runtime: ChromeClient['Runtime'];
    input: ChromeClient['Input'];
    attachmentNames?: string[];
    baselineTurns?: number | null;
    inputTimeoutMs?: number | null;
  },
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  const { runtime, input } = deps;
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
          return false;
        }
        const rect = node.getBoundingClientRect?.();
        if (!rect) return false;
        return rect.width > 8 && rect.height > 8;
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        // Learned: React/ProseMirror require a real click + focus + selection for inserts to stick.
        dispatchClickSequence(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      let fallbackNode = null;
      for (const selector of SELECTORS) {
        const nodes = Array.from(document.querySelectorAll(selector));
        if (!nodes.length) continue;
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') continue;
          if (!fallbackNode) fallbackNode = node;
          if (!isVisible(node)) continue;
          if (focusNode(node)) {
            return { focused: true };
          }
        }
      }
      if (fallbackNode && focusNode(fallbackNode)) {
        return { focused: true, fallback: true };
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!focusResult.result?.value?.focused) {
    await logDomFailure(runtime, logger, 'focus-textarea');
    throw new Error('Failed to focus prompt textarea');
  }

  await runtime
    .evaluate({
      expression: `(() => {
        const fallback = document.querySelector(${fallbackSelectorLiteral});
        const editor = document.querySelector(${primarySelectorLiteral});
        const cleared = { fallback: false, editor: false };
        if (fallback) {
          fallback.value = '';
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
          cleared.fallback = true;
        }
        if (editor) {
          editor.textContent = '';
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          cleared.editor = true;
        }
        return cleared;
      })()`,
      returnByValue: true,
    })
    .catch(() => undefined);

  await delay(150);
  await input.insertText({ text: prompt });

  // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
  // before the send button becomes enabled; give it a short breather to avoid races.
  await delay(500);

  const verification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
      };
    })()`,
    returnByValue: true,
  });

  const editorTextRaw = verification.result?.value?.editorText ?? '';
  const fallbackValueRaw = verification.result?.value?.fallbackValue ?? '';
  const editorTextTrimmed = editorTextRaw?.trim?.() ?? '';
  const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? '';
  if (!editorTextTrimmed && fallbackValueTrimmed) {
    // Learned: some composer variants keep the prompt in a hidden textarea and don't update the
    // contenteditable editor, which prevents the send button from appearing. Mirror the value.
    await runtime
      .evaluate({
        expression: `(() => {
          const fallback = document.querySelector(${fallbackSelectorLiteral});
          const editor = document.querySelector(${primarySelectorLiteral});
          const value = fallback?.value ?? '';
          const editorText = editor?.innerText ?? editor?.textContent ?? '';
          if (value && editor && !String(editorText).trim()) {
            editor.textContent = value;
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertFromPaste' }));
          }
        })()`,
      })
      .catch(() => undefined);
  } else if (!editorTextTrimmed && !fallbackValueTrimmed) {
    // Learned: occasionally Input.insertText doesn't land in the editor; force textContent/value + input events.
    await runtime.evaluate({
      expression: `(() => {
        const fallback = document.querySelector(${fallbackSelectorLiteral});
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector(${primarySelectorLiteral});
        if (editor) {
          editor.textContent = ${encodedPrompt};
          // Nudge ProseMirror to register the textContent write so its state/send-button updates
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        }
      })()`,
    });
  }

  const promptLength = prompt.length;
  const postVerification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
      };
    })()`,
    returnByValue: true,
  });
  const observedEditor = postVerification.result?.value?.editorText ?? '';
  const observedFallback = postVerification.result?.value?.fallbackValue ?? '';
  const observedLength = Math.max(observedEditor.length, observedFallback.length);
  if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
    await logDomFailure(runtime, logger, 'prompt-too-large');
    throw new BrowserAutomationError('Prompt appears truncated in the composer (likely too large).', {
      stage: 'submit-prompt',
      code: 'prompt-too-large',
      promptLength,
      observedLength,
    });
  }

  const sendWaitMs = (() => {
    const base = deps.inputTimeoutMs ?? 60_000;
    const half = Math.floor(base * 0.5);
    return Math.max(20_000, Math.min(60_000, half));
  })();
  const clicked = await attemptSendButton(runtime, logger, deps?.attachmentNames, sendWaitMs);
  if (!clicked) {
    await input.dispatchKeyEvent({
      type: 'keyDown',
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await input.dispatchKeyEvent({
      type: 'keyUp',
      ...ENTER_KEY_EVENT,
    });
    logger('Submitted prompt via Enter key');
  } else {
    logger('Clicked send button');
  }

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  return await verifyPromptCommitted(runtime, prompt, commitTimeoutMs, logger, deps.baselineTurns ?? undefined);
}

export async function clearPromptComposer(Runtime: ChromeClient['Runtime'], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      let cleared = false;
      if (fallback) {
        fallback.value = '';
        fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        fallback.dispatchEvent(new Event('change', { bubbles: true }));
        cleared = true;
      }
      if (editor) {
        editor.textContent = '';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        cleared = true;
      }
      return { cleared };
    })()`,
    returnByValue: true,
  });
  if (!result.result?.value?.cleared) {
    await logDomFailure(Runtime, logger, 'clear-composer');
    throw new Error('Failed to clear prompt composer');
  }
  await delay(250);
}

async function waitForDomReady(Runtime: ChromeClient['Runtime'], logger?: BrowserLogger, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const ready = document.readyState === 'complete';
        const composer = document.querySelector('[data-testid*="composer"]') || document.querySelector('form');
        const fileInput = document.querySelector('input[type="file"]');
        return { ready, composer: Boolean(composer), fileInput: Boolean(fileInput) };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as { ready?: boolean; composer?: boolean; fileInput?: boolean } | undefined;
    if (value?.ready && value.composer) {
      return;
    }
    await delay(150);
  }
  logger?.(`Page did not reach ready/composer state within ${timeoutMs}ms; continuing cautiously.`);
}

function buildAttachmentReadyExpression(attachmentNames: string[]): string {
  const namesLiteral = JSON.stringify(attachmentNames.map((name) => name.toLowerCase()));
  return `(() => {
    const names = ${namesLiteral};
    const composer =
      document.querySelector('[data-testid*="composer"]') ||
      document.querySelector('form') ||
      document.body ||
      document;
    const match = (node, name) => (node?.textContent || '').toLowerCase().includes(name);

    // Restrict to attachment affordances; never scan generic div/span nodes (prompt text can contain the file name).
    const attachmentSelectors = [
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[aria-label="Remove file"]',
      'button[aria-label="Remove file"]',
    ];

    const chipsReady = names.every((name) =>
      Array.from(composer.querySelectorAll(attachmentSelectors.join(','))).some((node) => match(node, name)),
    );
    const inputsReady = names.every((name) =>
      Array.from(composer.querySelectorAll('input[type="file"]')).some((el) =>
        Array.from((el instanceof HTMLInputElement ? el.files : []) || []).some((file) =>
          file?.name?.toLowerCase?.().includes(name),
        ),
      ),
    );

    return chipsReady || inputsReady;
  })()`;
}

export function buildAttachmentReadyExpressionForTest(attachmentNames: string[]) {
  return buildAttachmentReadyExpression(attachmentNames);
}

export function buildAttemptSendButtonExpressionForTest(): string {
  return buildAttemptSendButtonExpression();
}

function buildAttemptSendButtonExpression(): string {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const fallbackSelectorsLiteral = JSON.stringify(
    SEND_BUTTON_SELECTORS.filter((selector) => selector !== 'form button[type="submit"]'),
  );
  return `(() => {
    ${buildClickDispatcher()}
    const editor = document.querySelector(${primarySelectorLiteral});
    const fallback = document.querySelector(${fallbackSelectorLiteral});
    const anchor = editor || fallback;

    const hasPrompt = (node) => {
      if (!node || typeof node.querySelector !== 'function') return false;
      return Boolean(node.querySelector(${primarySelectorLiteral}) || node.querySelector(${fallbackSelectorLiteral}));
    };

    const resolveComposerScope = () => {
      if (anchor && typeof anchor.closest === 'function') {
        const form = anchor.closest('form');
        if (form && hasPrompt(form)) return form;
        const composer =
          anchor.closest('[data-testid*="composer"]') ||
          anchor.closest('[data-testid*="prompt"]') ||
          null;
        if (composer && hasPrompt(composer)) return composer;
        if (anchor instanceof HTMLElement) {
          const parent = anchor.parentElement;
          if (parent && hasPrompt(parent)) return parent;
        }
      }
      const forms = Array.from(document.querySelectorAll('form'));
      for (const form of forms) {
        if (hasPrompt(form)) return form;
      }
      const composers = Array.from(document.querySelectorAll('[data-testid*="composer"], [data-testid*="prompt"]'));
      for (const composer of composers) {
        if (hasPrompt(composer)) return composer;
      }
      return null;
    };

    const scope = resolveComposerScope();
    const scopeHasPrompt = Boolean(scope && hasPrompt(scope));
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
        return false;
      }
      const rect = node.getBoundingClientRect?.();
      if (!rect) return false;
      return rect.width > 4 && rect.height > 4;
    };

    const explicitSelectors = [
      'button[data-testid="send-button"]',
      'button[data-testid*="composer-send"]',
      'button[type="submit"][data-testid*="send"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="送信"]',
    ];
    const allowGenericSubmit = Boolean(anchor) && scopeHasPrompt;
    const selectors = allowGenericSubmit ? [...explicitSelectors, 'button[type="submit"]'] : explicitSelectors;

    const findButton = () => {
      if (scope) {
        for (const selector of selectors) {
          const nodes = Array.from(scope.querySelectorAll(selector));
          for (const node of nodes) {
            if (isVisible(node)) {
              return node;
            }
          }
        }
      }
      // If we couldn't identify a safe composer scope, fall back only to explicit send selectors.
      for (const selector of ${fallbackSelectorsLiteral}) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (isVisible(node)) {
            return node;
          }
        }
      }
      return null;
    };

    const button = findButton();
    if (!button) return 'missing';
    const ariaDisabled = button.getAttribute('aria-disabled');
    const dataDisabled = button.getAttribute('data-disabled');
    const style = window.getComputedStyle(button);
    const disabled =
      button.hasAttribute('disabled') ||
      ariaDisabled === 'true' ||
      dataDisabled === 'true' ||
      style.pointerEvents === 'none' ||
      style.display === 'none';
    // Learned: some send buttons render but are inert; only click when truly enabled.
    if (disabled) return 'disabled';
    // Use unified pointer/mouse sequence to satisfy React handlers.
    dispatchClickSequence(button);
    return 'clicked';
  })()`;
}

async function attemptSendButton(
  Runtime: ChromeClient['Runtime'],
  _logger?: BrowserLogger,
  attachmentNames?: string[],
  timeoutMs = 20_000,
): Promise<boolean> {
  const script = buildAttemptSendButtonExpression();

  const deadline = Date.now() + Math.max(5_000, timeoutMs);
  while (Date.now() < deadline) {
    const needAttachment = Array.isArray(attachmentNames) && attachmentNames.length > 0;
    if (needAttachment) {
      const ready = await Runtime.evaluate({
        expression: buildAttachmentReadyExpression(attachmentNames),
        returnByValue: true,
      });
      if (!ready?.result?.value) {
        await delay(150);
        continue;
      }
    }
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    if (result.value === 'clicked') {
      return true;
    }
    // Learned: hydration can briefly remove/replace the composer controls. If the send button is
    // missing, keep polling until the deadline so we don't prematurely fall back to the Enter key.
    await delay(100);
  }
  return false;
}

async function verifyPromptCommitted(
  Runtime: ChromeClient['Runtime'],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const baselineLiteral =
    typeof baselineTurns === 'number' && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : -1;
  // Learned: ChatGPT can echo/format text; normalize markdown and use prefix matches to detect the sent prompt.
  const script = `(() => {
	    const editor = document.querySelector(${primarySelectorLiteral});
	    const fallback = document.querySelector(${fallbackSelectorLiteral});
	    const normalize = (value) => {
	      let text = value?.toLowerCase?.() ?? '';
	      // Strip markdown *markers* but keep content (ChatGPT renders fence markers differently).
	      text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
	      text = text.replace(/\`\`\`/g, ' ');
	      text = text.replace(/\`([^\`]*)\`/g, '$1');
	      return text.replace(/\\s+/g, ' ').trim();
	    };
	    const normalizedPrompt = normalize(${encodedPrompt});
	    const normalizedPromptPrefix = normalizedPrompt.slice(0, 120);
	    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
	    const articles = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
	    const normalizedTurns = articles.map((node) => normalize(node?.innerText));
	    const userMatched =
	      normalizedPrompt.length > 0 && normalizedTurns.some((text) => text.includes(normalizedPrompt));
	    const prefixMatched =
	      normalizedPromptPrefix.length > 30 &&
	      normalizedTurns.some((text) => text.includes(normalizedPromptPrefix));
	    const lastTurn = normalizedTurns[normalizedTurns.length - 1] ?? '';
	    const lastMatched =
	      normalizedPrompt.length > 0 &&
	      (lastTurn.includes(normalizedPrompt) ||
	        (normalizedPromptPrefix.length > 30 && lastTurn.includes(normalizedPromptPrefix)));
	    const baseline = ${baselineLiteral};
	    const hasNewTurn = baseline < 0 ? true : normalizedTurns.length > baseline;
      const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
      const assistantVisible = Boolean(
        document.querySelector(${assistantSelectorLiteral}) ||
        document.querySelector('[data-testid*="assistant"]'),
      );
      // Learned: composer clearing + stop button (active generation) is a reliable fallback signal.
      const editorValue = editor?.innerText ?? '';
      const fallbackValue = fallback?.value ?? '';
      const composerCleared = !(String(editorValue).trim() || String(fallbackValue).trim());
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
	    return {
      userMatched,
      prefixMatched,
      lastMatched,
      hasNewTurn,
      stopVisible,
      assistantVisible,
      composerCleared,
      inConversation,
      href,
      fallbackValue,
      editorValue,
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as {
      userMatched?: boolean;
      prefixMatched?: boolean;
      lastMatched?: boolean;
      hasNewTurn?: boolean;
      stopVisible?: boolean;
      assistantVisible?: boolean;
      composerCleared?: boolean;
      inConversation?: boolean;
      turnsCount?: number;
    };
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    if (info?.hasNewTurn && (info?.lastMatched || info?.userMatched || info?.prefixMatched)) {
      return typeof turnsCount === 'number' && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const fallbackCommit =
      info?.composerCleared &&
      // Only treat "composer cleared" as a successful commit if the UI shows an active generation.
      // In existing chats the conversation DOM can populate after navigation, which would otherwise
      // trigger false positives and cause multi-turn follow-ups to capture stale answers.
      (info?.stopVisible ?? false);
    if (fallbackCommit) {
      return typeof turnsCount === 'number' && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    await delay(100);
  }
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${await Runtime.evaluate({
        expression: script,
        returnByValue: true,
      }).then((res) => JSON.stringify(res?.result?.value)).catch(() => 'unavailable')}`,
    );
    await logDomFailure(Runtime, logger, 'prompt-commit');
  }
  if (prompt.trim().length >= 50_000) {
    throw new BrowserAutomationError('Prompt did not appear in conversation before timeout (likely too large).', {
      stage: 'submit-prompt',
      code: 'prompt-too-large',
      promptLength: prompt.trim().length,
      timeoutMs,
    });
  }
  throw new Error('Prompt did not appear in conversation before timeout (send may have failed)');
}
