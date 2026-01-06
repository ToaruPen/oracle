import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  COPY_BUTTON_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure, logConversationSnapshot, buildConversationDebugExpression } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';

const ASSISTANT_POLL_TIMEOUT_ERROR = 'assistant-response-watchdog-timeout';

const PLACEHOLDER_LABEL_ALWAYS_TEXT = ['chatgpt said', 'assistant said'] as const;
const PLACEHOLDER_LABEL_GATE_TEXT = ['chatgpt', 'assistant'] as const;

function isAnswerNowPlaceholderText(
  normalized: string,
  options?: { hasAnswerNowGate?: boolean },
): boolean {
  const text = normalized.trim().toLowerCase();
  if (!text) return false;
  // Learned: "Pro thinking" shows a placeholder turn that contains "Answer now".
  // That is not the final answer and must be ignored in browser automation.
  const labelCandidate = text.replace(/[:：]+$/, '').trim();
  if (PLACEHOLDER_LABEL_ALWAYS_TEXT.includes(labelCandidate as (typeof PLACEHOLDER_LABEL_ALWAYS_TEXT)[number])) {
    return true;
  }
  if (PLACEHOLDER_LABEL_GATE_TEXT.includes(labelCandidate as (typeof PLACEHOLDER_LABEL_GATE_TEXT)[number])) {
    if (options?.hasAnswerNowGate === true) {
      return true;
    }
  }
  if (text.includes('file upload request') && (text.includes('pro thinking') || text.includes('chatgpt said'))) {
    return true;
  }
  const hasAnswerNowGate = text.includes('answer now') || text.includes('今すぐ回答');
  if (!hasAnswerNowGate) {
    return false;
  }
  const hasProThinkingContext =
    text.includes('pro thinking') ||
    text.includes('chatgpt said') ||
    text.includes('思考中') ||
    (text.includes('pro') && text.includes('thinking'));
  return hasProThinkingContext;
}

function buildIsPlaceholderTextExpression(functionName: string): string {
  const placeholdersAlwaysLiteral = JSON.stringify(PLACEHOLDER_LABEL_ALWAYS_TEXT);
  const placeholdersGateLiteral = JSON.stringify(PLACEHOLDER_LABEL_GATE_TEXT);
  return `const ${functionName} = (value, options) => {
    const normalized = String(value ?? '').replace(/\\u00a0/g, ' ').toLowerCase().trim();
    if (!normalized) return false;
    const label = normalized.replace(/[:：]+$/, '').trim();
    const LABEL_ALWAYS = ${placeholdersAlwaysLiteral};
    const LABEL_GATE = ${placeholdersGateLiteral};
    if (LABEL_ALWAYS.includes(label)) return true;
    if (LABEL_GATE.includes(label)) {
      if (options && options.hasAnswerNowGate === true) return true;
    }
    if (normalized.includes('file upload request') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
      return true;
    }
    const hasAnswerNowGate = normalized.includes('answer now') || normalized.includes('今すぐ回答');
    if (!hasAnswerNowGate) return false;
    return (
      normalized.includes('pro thinking') ||
      normalized.includes('chatgpt said') ||
      normalized.includes('思考中') ||
      (normalized.includes('pro') && normalized.includes('thinking'))
    );
  };`;
}

function buildHasAnswerNowGateExpression(functionName: string): string {
  return `const ${functionName} = () => {
    const tokens = ['answer now', '今すぐ回答'];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
    for (const node of nodes) {
      const label = (node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.textContent || '').toLowerCase();
      for (const token of tokens) {
        if (label.includes(token)) return true;
      }
    }
    const bodyText = (document.body?.innerText || document.body?.textContent || '').toLowerCase();
    if (tokens.some((token) => bodyText.includes(token))) return true;
    if (bodyText.includes('pro thinking') || bodyText.includes('思考中')) return true;
    return false;
  };`;
}

export async function waitForAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } }> {
  const start = Date.now();
  logger('Waiting for ChatGPT response');
  // Learned: two paths are needed:
  // 1) DOM observer (fast when mutations fire),
  // 2) snapshot poller (fallback when observers miss or JS stalls).
  const expression = buildResponseObserverExpression(timeoutMs, minTurnIndex);
  const evaluationPromise = Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  const raceReadyEvaluation = evaluationPromise.then(
    (value) => ({ kind: 'evaluation' as const, value }),
    (error) => {
      throw { source: 'evaluation' as const, error };
    },
  );
  const pollerPromise = pollAssistantCompletion(Runtime, timeoutMs, minTurnIndex).then(
    (value) => {
      if (!value) {
        throw { source: 'poll' as const, error: new Error(ASSISTANT_POLL_TIMEOUT_ERROR) };
      }
      return { kind: 'poll' as const, value };
    },
    (error) => {
      throw { source: 'poll' as const, error };
    },
  );

  let evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>> | null = null;
  try {
    const winner = await Promise.race([raceReadyEvaluation, pollerPromise]);
    if (winner.kind === 'poll') {
      logger('Captured assistant response via snapshot watchdog');
      evaluationPromise.catch(() => undefined);
      await terminateRuntimeExecution(Runtime);
      return winner.value;
    }
    evaluation = winner.value;
  } catch (wrappedError) {
    if (wrappedError && typeof wrappedError === 'object' && 'source' in wrappedError && 'error' in wrappedError) {
      const { source, error } = wrappedError as { source: string; error: unknown };
      if (source === 'poll' && error instanceof Error && error.message === ASSISTANT_POLL_TIMEOUT_ERROR) {
        evaluation = await evaluationPromise;
      } else if (source === 'poll') {
        throw error;
      } else if (source === 'evaluation') {
        const recovered = await recoverAssistantResponse(Runtime, timeoutMs, logger, minTurnIndex);
        if (recovered) {
          return recovered;
        }
        await logDomFailure(Runtime, logger, 'assistant-response');
        throw error ?? new Error('Failed to capture assistant response');
      }
    } else {
      throw wrappedError;
    }
  }

  if (!evaluation) {
    await logDomFailure(Runtime, logger, 'assistant-response');
    throw new Error('Failed to capture assistant response');
  }

  const parsed = await parseAssistantEvaluationResult(Runtime, evaluation, logger);
  if (!parsed) {
    let remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    if (remainingMs > 0) {
      const recovered = await recoverAssistantResponse(Runtime, remainingMs, logger, minTurnIndex);
      if (recovered) {
        return recovered;
      }
      remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
      if (remainingMs > 0) {
        const polled = await Promise.race([
          pollerPromise.catch(() => null),
          delay(remainingMs).then(() => null),
        ]);
        if (polled && polled.kind === 'poll') {
          return polled.value;
        }
      }
    }
    await logDomFailure(Runtime, logger, 'assistant-response');
    throw new Error('Unable to capture assistant response');
  }

  const refreshed = await refreshAssistantSnapshot(Runtime, parsed, logger, minTurnIndex);
  const candidate = refreshed ?? parsed;
  // The evaluation path can race ahead of completion. If ChatGPT is still streaming, wait for the watchdog poller.
  const elapsedMs = Date.now() - start;
  const remainingMs = Math.max(0, timeoutMs - elapsedMs);
  if (remainingMs > 0) {
    const [stopVisible, completionVisible] = await Promise.all([
      isStopButtonVisible(Runtime),
      isCompletionVisible(Runtime),
    ]);
    if (stopVisible) {
      logger('Assistant still generating; waiting for completion');
      const completed = await pollAssistantCompletion(Runtime, remainingMs, minTurnIndex);
      if (completed) {
        return completed;
      }
    } else if (completionVisible) {
      // No-op: completion UI surfaced and stop button is gone.
    }
  }

  return candidate;
}

export async function readAssistantSnapshot(
  Runtime: ChromeClient['Runtime'],
  minTurnIndex?: number,
): Promise<AssistantSnapshot | null> {
  const { result } = await Runtime.evaluate({
    expression: buildAssistantSnapshotExpression(minTurnIndex),
    returnByValue: true,
  });
  const value = result?.value;
  if (value && typeof value === 'object') {
    const snapshot = value as AssistantSnapshot;
    if (typeof minTurnIndex === 'number' && Number.isFinite(minTurnIndex)) {
      const turnIndex = typeof snapshot.turnIndex === 'number' ? snapshot.turnIndex : null;
      if (turnIndex === null) {
        return snapshot;
      }
      if (turnIndex < minTurnIndex) {
        return null;
      }
    }
    return snapshot;
  }
  return null;
}

export async function captureAssistantMarkdown(
  Runtime: ChromeClient['Runtime'],
  meta: { messageId?: string | null; turnId?: string | null },
  logger: BrowserLogger,
): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: buildCopyExpression(meta),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value?.success && typeof result.value.markdown === 'string') {
    return result.value.markdown;
  }
  const status = result?.value?.status;
  if (status && status !== 'missing-button') {
    logger(`Copy button fallback status: ${status}`);
    await logDomFailure(Runtime, logger, 'copy-markdown');
  }
  if (!status) {
    await logDomFailure(Runtime, logger, 'copy-markdown');
  }
  return null;
}

export function buildAssistantExtractorForTest(name: string): string {
  return buildAssistantExtractor(name);
}

export function buildConversationDebugExpressionForTest(): string {
  return buildConversationDebugExpression();
}

export function buildMarkdownFallbackExtractorForTest(minTurnLiteral = '0'): string {
  return buildMarkdownFallbackExtractor(minTurnLiteral);
}

export function buildCopyExpressionForTest(
  meta: { messageId?: string | null; turnId?: string | null } = {},
): string {
  return buildCopyExpression(meta);
}

export function isAnswerNowPlaceholderTextForTest(
  value: string,
  options?: { hasAnswerNowGate?: boolean },
): boolean {
  return isAnswerNowPlaceholderText(value, options);
}

export function htmlToMarkdownForTest(
  html: string,
  deps: { DOMParser: unknown; Node: unknown },
): string {
  return htmlToMarkdown(html, deps);
}

async function recoverAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const recoveryTimeoutMs = Math.max(0, timeoutMs);
  if (recoveryTimeoutMs === 0) {
    return null;
  }
  const recovered = await waitForCondition(
    async () => {
      const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
      return normalizeAssistantSnapshot(snapshot);
    },
    recoveryTimeoutMs,
    400,
  );
  if (recovered) {
    logger('Recovered assistant response via polling fallback');
    return recovered;
  }
  await logConversationSnapshot(Runtime, logger).catch(() => undefined);
  return null;
}

async function parseAssistantEvaluationResult(
  _Runtime: ChromeClient['Runtime'],
  evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>>,
  _logger: BrowserLogger,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const { result } = evaluation;
  if (result.type === 'object' && result.value && typeof result.value === 'object' && 'text' in result.value) {
    const hasAnswerNowGate =
      typeof (result.value as { hasAnswerNowGate?: unknown }).hasAnswerNowGate === 'boolean'
        ? ((result.value as { hasAnswerNowGate?: boolean }).hasAnswerNowGate ?? undefined)
        : undefined;
    const html =
      typeof (result.value as { html?: unknown }).html === 'string'
        ? ((result.value as { html?: string }).html ?? undefined)
        : undefined;
    const turnId =
      typeof (result.value as { turnId?: unknown }).turnId === 'string'
        ? ((result.value as { turnId?: string }).turnId ?? undefined)
        : undefined;
    const messageId =
      typeof (result.value as { messageId?: unknown }).messageId === 'string'
        ? ((result.value as { messageId?: string }).messageId ?? undefined)
        : undefined;
    const text = cleanAssistantText(String((result.value as { text: unknown }).text ?? ''));
    const normalized = text.toLowerCase();
    if (isAnswerNowPlaceholderText(normalized, { hasAnswerNowGate })) {
      return null;
    }
    return { text, html, meta: { turnId, messageId } };
  }
  const fallbackText = typeof result.value === 'string' ? cleanAssistantText(result.value as string) : '';
  if (!fallbackText) {
    return null;
  }
  if (isAnswerNowPlaceholderText(fallbackText.toLowerCase())) {
    return null;
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function refreshAssistantSnapshot(
  Runtime: ChromeClient['Runtime'],
  current: { text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } },
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const deadline = Date.now() + 5_000;
  let best: { text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null = null;
  let stableCycles = 0;
  const stableTarget = 3;
  while (Date.now() < deadline) {
    // Learned: short/fast answers can race; poll a few extra cycles to pick up messageId + full text.
    const latestSnapshot = await readAssistantSnapshot(Runtime, minTurnIndex).catch(() => null);
    const latest = normalizeAssistantSnapshot(latestSnapshot);
    if (latest) {
      if (
        !best ||
        latest.text.length > best.text.length ||
        (!best.meta.messageId && latest.meta.messageId)
      ) {
        best = latest;
        stableCycles = 0;
      } else if (latest.text.trim() === best.text.trim()) {
        stableCycles += 1;
      }
    }
    if (best && stableCycles >= stableTarget) {
      break;
    }
    await delay(300);
  }
  if (!best) {
    return null;
  }
  const currentLength = cleanAssistantText(current.text).trim().length;
  const latestLength = best.text.length;
  const hasBetterId = !current.meta?.messageId && Boolean(best.meta.messageId);
  const isLonger = latestLength > currentLength;
  const hasDifferentText = best.text.trim() !== current.text.trim();
  if (isLonger || hasBetterId || hasDifferentText) {
    logger('Refreshed assistant response via latest snapshot');
    return best;
  }
  return null;
}

async function terminateRuntimeExecution(Runtime: ChromeClient['Runtime']): Promise<void> {
  if (typeof Runtime.terminateExecution !== 'function') {
    return;
  }
  try {
    await Runtime.terminateExecution();
  } catch {
    // ignore termination failures
  }
}

async function pollAssistantCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const watchdogDeadline = Date.now() + timeoutMs;
  let previousLength = 0;
  let stableCycles = 0;
  let lastChangeAt = Date.now();
  while (Date.now() < watchdogDeadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
    const normalized = normalizeAssistantSnapshot(snapshot);
    if (normalized) {
      const currentLength = normalized.text.length;
      if (currentLength > previousLength) {
        previousLength = currentLength;
        stableCycles = 0;
        lastChangeAt = Date.now();
      } else {
        stableCycles += 1;
      }
      const [stopVisible, completionVisible] = await Promise.all([
        isStopButtonVisible(Runtime),
        isCompletionVisible(Runtime),
      ]);
      const shortAnswer = currentLength > 0 && currentLength < 16;
      // Learned: short answers need a longer stability window or they truncate.
      const completionStableTarget = shortAnswer ? 12 : currentLength < 40 ? 8 : 4;
      const requiredStableCycles = shortAnswer ? 12 : 6;
      const stableMs = Date.now() - lastChangeAt;
      const minStableMs = shortAnswer ? 8000 : 1200;
      // Require stop button to disappear before treating completion as final.
      if (!stopVisible) {
        const stableEnough = stableCycles >= requiredStableCycles && stableMs >= minStableMs;
        const completionEnough =
          completionVisible && stableCycles >= completionStableTarget && stableMs >= minStableMs;
        if (completionEnough || stableEnough) {
          return normalized;
        }
      }
    } else {
      previousLength = 0;
      stableCycles = 0;
    }
    await delay(400);
  }
  return null;
}

async function isStopButtonVisible(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `Boolean(document.querySelector('${STOP_BUTTON_SELECTOR}'))`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

async function isCompletionVisible(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        // Find the LAST assistant turn to check completion status
        // Must match the same logic as buildAssistantExtractor for consistency
        const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
        const isAssistantTurn = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
          if (turnAttr === 'assistant') return true;
          const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
          if (role === 'assistant') return true;
          const testId = (node.getAttribute('data-testid') || '').toLowerCase();
          if (testId.includes('assistant')) return true;
          return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
        };

        const turns = Array.from(document.querySelectorAll('${CONVERSATION_TURN_SELECTOR}'));
        let lastAssistantTurn = null;
        for (let i = turns.length - 1; i >= 0; i--) {
          if (isAssistantTurn(turns[i])) {
            lastAssistantTurn = turns[i];
            break;
          }
        }
        if (!lastAssistantTurn) {
          return false;
        }
        // Check if the last assistant turn has finished action buttons (copy, thumbs up/down, share)
        if (lastAssistantTurn.querySelector('${FINISHED_ACTIONS_SELECTOR}')) {
          return true;
        }
        // Also check for "Done" text in the last assistant turn's markdown
        const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
        return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
      })()`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

function normalizeAssistantSnapshot(
  snapshot: AssistantSnapshot | null,
): { text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null {
  const text = snapshot?.text ? cleanAssistantText(snapshot.text) : '';
  if (!text.trim()) {
    return null;
  }
  const normalized = text.toLowerCase();
  // "Pro thinking" often renders a placeholder turn containing an "Answer now" gate.
  // Treat it as incomplete so browser mode keeps waiting for the real assistant text.
  if (isAnswerNowPlaceholderText(normalized, { hasAnswerNowGate: snapshot?.hasAnswerNowGate })) {
    return null;
  }
  // Ignore user echo turns that can show up in project view fallbacks.
  if (normalized.startsWith('you said')) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
  };
}

async function waitForCondition<T>(getter: () => Promise<T | null>, timeoutMs: number, pollIntervalMs = 400): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) {
      return value;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

function buildAssistantSnapshotExpression(minTurnIndex?: number): string {
  const minTurnLiteral =
    typeof minTurnIndex === 'number' && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    // Learned: the default turn DOM misses project view; keep a fallback extractor.
    ${buildAssistantExtractor('extractAssistantTurn')}
    ${buildHasAnswerNowGateExpression('detectAnswerNowGate')}
    ${buildIsPlaceholderTextExpression('isPlaceholderText')}
    const annotateSnapshot = (snapshot) => {
      if (!snapshot) return null;
      snapshot.hasAnswerNowGate = detectAnswerNowGate();
      return snapshot;
    };
    const extracted = annotateSnapshot(extractAssistantTurn());
    if (extracted && extracted.text && !isPlaceholderText(extracted.text, { hasAnswerNowGate: extracted.hasAnswerNowGate })) {
      return extracted;
    }
    // Fallback for ChatGPT project view: answers can live outside conversation turns.
    const fallback = annotateSnapshot(${buildMarkdownFallbackExtractor('MIN_TURN_INDEX')});
    return fallback ?? extracted;
  })()`;
}

function buildResponseObserverExpression(timeoutMs: number, minTurnIndex?: number): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const minTurnLiteral =
    typeof minTurnIndex === 'number' && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    ${buildClickDispatcher()}
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = '${STOP_BUTTON_SELECTOR}';
    const FINISHED_SELECTOR = '${FINISHED_ACTIONS_SELECTOR}';
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    // Learned: settling avoids capturing mid-stream HTML; keep short.
    const settleDelayMs = 800;
    ${buildHasAnswerNowGateExpression('detectAnswerNowGate')}
    ${buildIsPlaceholderTextExpression('isPlaceholderText')}
    const annotateSnapshot = (snapshot) => {
      if (!snapshot) return null;
      snapshot.hasAnswerNowGate = detectAnswerNowGate();
      return snapshot;
    };
    const isAnswerNowPlaceholder = (snapshot) => {
      if (!snapshot) return false;
      return isPlaceholderText(snapshot?.text ?? '', { hasAnswerNowGate: snapshot.hasAnswerNowGate === true });
    };

    // Helper to detect assistant turns - must match buildAssistantExtractor logic for consistency.
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const MIN_TURN_INDEX = ${minTurnLiteral};
    ${buildAssistantExtractor('extractFromTurns')}
    // Learned: some layouts (project view) render markdown without assistant turn wrappers.
    const extractFromMarkdownFallback = ${buildMarkdownFallbackExtractor('MIN_TURN_INDEX')};

    const acceptSnapshot = (snapshot) => {
      if (!snapshot) return null;
      const index = typeof snapshot.turnIndex === 'number' ? snapshot.turnIndex : -1;
      if (MIN_TURN_INDEX >= 0) {
        if (index < 0 || index < MIN_TURN_INDEX) {
          return null;
        }
      }
      return snapshot;
    };

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        let stopInterval = null;
        const observer = new MutationObserver(() => {
          const extractedRaw = annotateSnapshot(extractFromTurns());
          const extractedCandidate =
            extractedRaw && !isAnswerNowPlaceholder(extractedRaw) ? extractedRaw : null;
          let extracted = acceptSnapshot(extractedCandidate);
          if (!extracted) {
            const fallbackRaw = annotateSnapshot(extractFromMarkdownFallback());
            const fallbackCandidate =
              fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
            extracted = acceptSnapshot(fallbackCandidate);
          }
          if (extracted) {
            observer.disconnect();
            if (stopInterval) {
              clearInterval(stopInterval);
            }
            resolve(extracted);
          } else if (Date.now() > deadline) {
            observer.disconnect();
            if (stopInterval) {
              clearInterval(stopInterval);
            }
            reject(new Error('Response timeout'));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        stopInterval = setInterval(() => {
          const stop = document.querySelector(STOP_SELECTOR);
          if (!stop) {
            return;
          }
          const isStopButton =
            stop.getAttribute('data-testid') === 'stop-button' || stop.getAttribute('aria-label')?.toLowerCase()?.includes('stop');
          if (isStopButton) {
            return;
          }
          dispatchClickSequence(stop);
        }, 500);
        setTimeout(() => {
          if (stopInterval) {
            clearInterval(stopInterval);
          }
          observer.disconnect();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    // Check if the last assistant turn has finished (scoped to avoid detecting old turns).
    const isLastAssistantTurnFinished = () => {
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      let lastAssistantTurn = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isAssistantTurn(turns[i])) {
          lastAssistantTurn = turns[i];
          break;
        }
      }
      if (!lastAssistantTurn) return false;
      // Check for action buttons in this specific turn
      if (lastAssistantTurn.querySelector(FINISHED_SELECTOR)) return true;
      // Check for "Done" text in this turn's markdown
      const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
      return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
    };

    const waitForSettle = async (snapshot) => {
      // Learned: short answers can be 1-2 tokens; enforce longer settle windows to avoid truncation.
      const initialLength = snapshot?.text?.length ?? 0;
      const shortAnswer = initialLength > 0 && initialLength < 16;
      const settleWindowMs = shortAnswer ? 12_000 : 5_000;
      const settleIntervalMs = 400;
      const deadline = Date.now() + settleWindowMs;
      let latest = snapshot;
      let lastLength = snapshot?.text?.length ?? 0;
      let stableCycles = 0;
      const stableTarget = shortAnswer ? 6 : 3;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, settleIntervalMs));
        const refreshedRaw = annotateSnapshot(extractFromTurns());
        const refreshedCandidate =
          refreshedRaw && !isAnswerNowPlaceholder(refreshedRaw) ? refreshedRaw : null;
        let refreshed = acceptSnapshot(refreshedCandidate);
        if (!refreshed) {
          const fallbackRaw = annotateSnapshot(extractFromMarkdownFallback());
          const fallbackCandidate =
            fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
          refreshed = acceptSnapshot(fallbackCandidate);
        }
        const nextLength = refreshed?.text?.length ?? lastLength;
        if (refreshed && nextLength >= lastLength) {
          latest = refreshed;
        }
        if (nextLength > lastLength) {
          lastLength = nextLength;
          stableCycles = 0;
        } else {
          stableCycles += 1;
        }
        const stopVisible = Boolean(document.querySelector(STOP_SELECTOR));
        const finishedVisible = isLastAssistantTurnFinished();

        if (finishedVisible || (!stopVisible && stableCycles >= stableTarget)) {
          break;
        }
      }
      return latest ?? snapshot;
    };

    const extractedRaw = annotateSnapshot(extractFromTurns());
    const extractedCandidate = extractedRaw && !isAnswerNowPlaceholder(extractedRaw) ? extractedRaw : null;
    let extracted = acceptSnapshot(extractedCandidate);
    if (!extracted) {
      const fallbackRaw = annotateSnapshot(extractFromMarkdownFallback());
      const fallbackCandidate = fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
      extracted = acceptSnapshot(fallbackCandidate);
    }
    if (extracted) {
      return waitForSettle(extracted);
    }
    return captureViaObserver().then((payload) => waitForSettle(payload));
  })()`;
}

function buildAssistantExtractor(functionName: string): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const ${functionName} = () => {
    ${buildClickDispatcher()}
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') {
        return true;
      }
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const expandCollapsibles = (root) => {
      const buttons = Array.from(root.querySelectorAll('button'));
      for (const button of buttons) {
        const label = (button.textContent || '').toLowerCase();
        const testid = (button.getAttribute('data-testid') || '').toLowerCase();
        if (
          label.includes('more') ||
          label.includes('expand') ||
          label.includes('show') ||
          testid.includes('markdown') ||
          testid.includes('toggle')
        ) {
          dispatchClickSequence(button);
        }
      }
    };

    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) {
        continue;
      }
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) ?? turn;
      expandCollapsibles(messageRoot);
      const preferred =
        (messageRoot.matches?.('.markdown') || messageRoot.matches?.('[data-message-content]') ? messageRoot : null) ||
        messageRoot.querySelector('.markdown') ||
        messageRoot.querySelector('[data-message-content]') ||
        messageRoot.querySelector('[data-testid*="message"]') ||
        messageRoot.querySelector('[data-testid*="assistant"]') ||
        messageRoot.querySelector('.prose') ||
        messageRoot.querySelector('[class*="markdown"]');
      const contentRoot = preferred ?? messageRoot;
      if (!contentRoot) {
        continue;
      }
      const innerText = contentRoot?.innerText ?? '';
      const textContent = contentRoot?.textContent ?? '';
      const text = innerText.trim().length > 0 ? innerText : textContent;
      const html = contentRoot?.innerHTML ?? '';
      const messageId = messageRoot.getAttribute('data-message-id');
      const turnId = messageRoot.getAttribute('data-testid');
      if (text.trim()) {
        return { text, html, messageId, turnId, turnIndex: index };
      }
    }
    return null;
  };`;
}

function buildMarkdownFallbackExtractor(minTurnLiteral?: string): string {
  const turnIndexValue = minTurnLiteral ? `(${minTurnLiteral} >= 0 ? ${minTurnLiteral} : null)` : 'null';
  return `(() => {
    const MIN_TURN_INDEX = ${turnIndexValue};
    const roots = [
      document.querySelector('section[data-testid="screen-threadFlyOut"]'),
      document.querySelector('[data-testid="chat-thread"]'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
    ].filter(Boolean);
    if (roots.length === 0) return null;
    const markdownSelector = '.markdown,[data-message-content],[data-testid*="message"],.prose,[class*="markdown"]';
    const isExcluded = (node) =>
      Boolean(
        node?.closest?.(
          'nav, aside, [data-testid*="sidebar"], [data-testid*="chat-history"], [data-testid*="composer"], form',
        ),
      );
    const scoreRoot = (node) => {
      const actions = node.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}').length;
      const assistants = node.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]').length;
      const markdowns = node.querySelectorAll(markdownSelector).length;
      return actions * 10 + assistants * 5 + markdowns;
    };
    let root = roots[0];
    let bestScore = scoreRoot(root);
    for (let i = 1; i < roots.length; i += 1) {
      const candidate = roots[i];
      const score = scoreRoot(candidate);
      if (score > bestScore) {
        bestScore = score;
        root = candidate;
      }
    }
    if (!root) return null;
    const CONVERSATION_SELECTOR = '${CONVERSATION_TURN_SELECTOR}';
    const turnNodes = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const hasTurns = turnNodes.length > 0;
    const resolveTurnIndex = (node) => {
      const turn = node?.closest?.(CONVERSATION_SELECTOR);
      if (!turn) return null;
      const idx = turnNodes.indexOf(turn);
      return idx >= 0 ? idx : null;
    };
    const isAfterMinTurn = (node) => {
      if (MIN_TURN_INDEX === null) return true;
      if (!hasTurns) return true;
      const idx = resolveTurnIndex(node);
      return idx !== null && idx >= MIN_TURN_INDEX;
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const collectUserText = (scope) => {
      if (!scope?.querySelectorAll) return '';
      const userTurns = Array.from(scope.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'));
      const lastUser = userTurns[userTurns.length - 1];
      return lastUser ? normalize(lastUser.innerText || lastUser.textContent || '') : '';
    };
    const userText = collectUserText(root) || collectUserText(document);
    const isUserEcho = (text) => {
      if (!userText) return false;
      const normalized = normalize(text);
      if (!normalized) return false;
      return normalized === userText || normalized.startsWith(userText);
    };
    const markdowns = Array.from(root.querySelectorAll(markdownSelector))
      .filter((node) => !isExcluded(node))
      .filter((node) => {
        const container = node.closest('[data-message-author-role], [data-turn]');
        if (!container) return true;
        const role =
          (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
        return role !== 'user';
      });
    if (markdowns.length === 0) return null;
    const actionButtons = Array.from(root.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}'));
    const actionMarkdowns = [];
    for (const button of actionButtons) {
      const container =
        button.closest('${CONVERSATION_TURN_SELECTOR}') ||
        button.closest('[data-message-author-role="assistant"], [data-turn="assistant"]') ||
        button.closest('[data-message-author-role], [data-turn]') ||
        button.closest('[data-testid*="assistant"]');
      if (!container || container === root || container === document.body) continue;
      const scoped = Array.from(container.querySelectorAll(markdownSelector))
        .filter((node) => !isExcluded(node))
        .filter((node) => {
          const roleNode = node.closest('[data-message-author-role], [data-turn]');
          if (!roleNode) return true;
          const role =
            (roleNode.getAttribute('data-message-author-role') || roleNode.getAttribute('data-turn') || '').toLowerCase();
          return role !== 'user';
        });
      if (scoped.length === 0) continue;
      for (const node of scoped) {
        actionMarkdowns.push(node);
      }
    }
    const assistantMarkdowns = markdowns.filter((node) => {
      const container = node.closest('[data-message-author-role], [data-turn], [data-testid*="assistant"]');
      if (!container) return false;
      const role =
        (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (container.getAttribute('data-testid') || '').toLowerCase();
      return testId.includes('assistant');
    });
    const hasAssistantIndicators = Boolean(
      root.querySelector('${FINISHED_ACTIONS_SELECTOR}') ||
        root.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'),
    );
    const allowMarkdownFallback = hasAssistantIndicators || hasTurns || Boolean(userText);
    const candidates =
      actionMarkdowns.length > 0
        ? actionMarkdowns
        : assistantMarkdowns.length > 0
          ? assistantMarkdowns
          : allowMarkdownFallback
            ? markdowns
            : [];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const node = candidates[i];
      if (!node) continue;
      if (!isAfterMinTurn(node)) continue;
      const text = (node.innerText || node.textContent || '').trim();
      if (!text) continue;
      if (isUserEcho(text)) continue;
      const html = node.innerHTML ?? '';
      const turnIndex = resolveTurnIndex(node);
      return { text, html, messageId: null, turnId: null, turnIndex };
    }
    return null;
  })`;
}

function buildCopyExpression(meta: { messageId?: string | null; turnId?: string | null }): string {
  return `(() => {
    ${buildClickDispatcher()}
    const BUTTON_SELECTOR = '${COPY_BUTTON_SELECTOR}';
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const TIMEOUT_MS = 10000;

    const locateButton = () => {
      const hint = ${JSON.stringify(meta ?? {})};
      if (hint?.messageId) {
        const node = document.querySelector('[data-message-id="' + hint.messageId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      if (hint?.turnId) {
        const node = document.querySelector('[data-testid="' + hint.turnId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
      const isAssistantTurn = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        if (turnAttr === 'assistant') return true;
        const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
        if (role === 'assistant') return true;
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        if (testId.includes('assistant')) return true;
        return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
      };
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (!isAssistantTurn(turn)) continue;
        const button = turn.querySelector(BUTTON_SELECTOR);
        if (button) {
          return button;
        }
      }
      const all = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const button = all[i];
        const turn = button?.closest?.(CONVERSATION_SELECTOR);
        if (turn && isAssistantTurn(turn)) {
          return button;
        }
      }
      return null;
    };

    const interceptClipboard = () => {
      const clipboard = navigator.clipboard;
      const state = { text: '', updatedAt: 0 };
      if (!clipboard) {
        return { state, restore: () => {} };
      }
      const originalWriteText = clipboard.writeText;
      const originalWrite = clipboard.write;
      const htmlToMarkdown = ${buildHtmlToMarkdownFunctionExpression()};

      clipboard.writeText = (value) => {
        state.text = typeof value === 'string' ? value : '';
        state.updatedAt = Date.now();
        return Promise.resolve();
      };
      clipboard.write = async (items) => {
        try {
          const list = Array.isArray(items) ? items : items ? [items] : [];
          for (const item of list) {
            if (!item) continue;
            const types = Array.isArray(item.types) ? item.types : [];
            if (typeof item.getType !== 'function') continue;

            const getText = async (type) => {
              try {
                const blob = await item.getType(type);
                return await blob.text();
              } catch {
                return '';
              }
            };

            const markdownRaw = types.includes('text/markdown')
              ? await getText('text/markdown')
              : types.includes('text/x-markdown')
                ? await getText('text/x-markdown')
                : '';
            const html = types.includes('text/html') ? await getText('text/html') : '';
            const plain = types.includes('text/plain') ? await getText('text/plain') : '';
            const markdownFromHtml = html ? htmlToMarkdown(html) : '';
            const markdown = markdownRaw.trim()
              ? markdownRaw
              : markdownFromHtml.trim()
                ? markdownFromHtml
                : plain;
            state.text = markdown ?? '';
            state.updatedAt = Date.now();
            if (state.text.trim()) {
              break;
            }
          }
        } catch {
          state.text = '';
          state.updatedAt = Date.now();
        }
        return Promise.resolve();
      };
      return {
        state,
        htmlToMarkdown,
        restore: () => {
          clipboard.writeText = originalWriteText;
          clipboard.write = originalWrite;
        },
      };
    };

    return new Promise((resolve) => {
      const deadline = Date.now() + TIMEOUT_MS;
      const waitForButton = () => {
        const button = locateButton();
        if (button) {
          const interception = interceptClipboard();
          let settled = false;
          let pollId = null;
          let timeoutId = null;
          const finish = (payload) => {
            if (settled) {
              return;
            }
            settled = true;
            if (pollId) {
              clearInterval(pollId);
            }
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            button.removeEventListener('copy', handleCopy, true);
            interception.restore?.();
            resolve(payload);
          };

          const readIntercepted = () => {
            const markdown = interception.state.text ?? '';
            const updatedAt = interception.state.updatedAt ?? 0;
            return { success: Boolean(markdown.trim()), markdown, updatedAt };
          };

          const BACKTICK = String.fromCharCode(96);
          const FENCE = BACKTICK + BACKTICK + BACKTICK;

          const looksLikeMarkdown = (value) => {
            const text = String(value ?? '').trim();
            if (!text) return false;
            if (text.includes(FENCE)) return true;
            if (/^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+|[•·・]\\s+)/m.test(text)) return true;
            return false;
          };

          const extractMarkdownFromDom = () => {
            try {
              const container =
                button.closest(CONVERSATION_SELECTOR) ||
                button.closest('[data-message-author-role="assistant"], [data-turn="assistant"]') ||
                button.closest('[data-message-author-role], [data-turn]');
              if (!container) return '';
              const contentRoot =
                container.querySelector('.markdown') ||
                container.querySelector('[data-message-content]') ||
                container.querySelector('[data-testid*="message"]') ||
                container.querySelector('[data-testid*="assistant"]') ||
                container.querySelector('.prose') ||
                container.querySelector('[class*="markdown"]') ||
                null;
              if (!contentRoot) return '';
              const html = contentRoot.innerHTML ?? '';
              const converted = interception.htmlToMarkdown ? interception.htmlToMarkdown(html) : '';
              const candidate = converted?.trim?.() ? converted : (contentRoot.innerText || contentRoot.textContent || '');
              return String(candidate ?? '').trim();
            } catch {
              return '';
            }
          };

          const shouldPreferDomMarkdown = (clipboardText, domText) => {
            const clipped = String(clipboardText ?? '').trim();
            const dom = String(domText ?? '').trim();
            if (!dom) return false;
            if (!clipped) return true;
            const hasCopyArtifacts =
              clipped.toLowerCase().includes('copy code') ||
              clipped.includes('コードをコピーする') ||
              clipped.includes('コードをコピー') ||
              clipped.includes('Copy code');
            const clipboardLooks = looksLikeMarkdown(clipped);
            const domLooks = looksLikeMarkdown(dom);
            if (!domLooks) return false;
            if (hasCopyArtifacts) return true;
            if (!clipboardLooks) return true;
            return false;
          };

          let lastText = '';
          let stableTicks = 0;
          const requiredStableTicks = 3;
          const requiredStableMs = 250;
          const maybeFinish = () => {
            const payload = readIntercepted();
            if (!payload.success) return;
            if (payload.markdown !== lastText) {
              lastText = payload.markdown;
              stableTicks = 0;
              return;
            }
            stableTicks += 1;
            const ageMs = Date.now() - (payload.updatedAt || 0);
            if (stableTicks >= requiredStableTicks && ageMs >= requiredStableMs) {
              const domMarkdown = extractMarkdownFromDom();
              const finalMarkdown = shouldPreferDomMarkdown(payload.markdown, domMarkdown) ? domMarkdown : payload.markdown;
              finish({ ...payload, markdown: finalMarkdown });
            }
          };

          const handleCopy = () => {
            maybeFinish();
          };

          button.addEventListener('copy', handleCopy, true);
          button.scrollIntoView({ block: 'center', behavior: 'instant' });
          dispatchClickSequence(button);
          pollId = setInterval(maybeFinish, 120);
          timeoutId = setTimeout(() => {
            button.removeEventListener('copy', handleCopy, true);
            finish({ success: false, status: 'timeout' });
          }, TIMEOUT_MS);
          return;
        }
        if (Date.now() > deadline) {
          resolve({ success: false, status: 'missing-button' });
          return;
        }
        setTimeout(waitForButton, 120);
      };

      waitForButton();
    });
  })()`;
}

function buildHtmlToMarkdownFunctionExpression(): string {
  return htmlToMarkdown.toString();
}

function htmlToMarkdown(
  html: string,
  deps?: { DOMParser?: unknown; Node?: unknown },
): string {
  try {
    const DOMParserCtor = (deps?.DOMParser ??
      (globalThis as unknown as { DOMParser?: unknown }).DOMParser) as
      | { new (): { parseFromString: (markup: string, type: string) => unknown } }
      | undefined;
    if (!DOMParserCtor) {
      return '';
    }

    const nodeRef = deps?.Node ?? (globalThis as unknown as { Node?: unknown }).Node;
    const TEXT_NODE = (nodeRef as { TEXT_NODE?: number } | null | undefined)?.TEXT_NODE ?? 3;
    const ELEMENT_NODE = (nodeRef as { ELEMENT_NODE?: number } | null | undefined)?.ELEMENT_NODE ?? 1;

    const BACKTICK = String.fromCharCode(96);
    const FENCE = BACKTICK + BACKTICK + BACKTICK;
    const normalizeNewlines = (value: unknown) =>
      String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u00a0/g, ' ');

    const doc = new DOMParserCtor().parseFromString(String(html ?? ''), 'text/html') as any;
    const root = (() => {
      const body = doc?.body;
      if (body && body.childNodes && body.childNodes.length > 0) return body;
      const element = doc?.documentElement;
      const tag = (element?.tagName || '').toLowerCase();
      if (element && tag && tag !== 'html') return element;
      return body || element;
    })();
    if (!root) return '';

    const formatInlineCode = (value: unknown) => {
      const text = String(value ?? '');
      if (!text) return '';
      let maxRun = 0;
      let currentRun = 0;
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === BACKTICK) {
          currentRun += 1;
          if (currentRun > maxRun) maxRun = currentRun;
        } else {
          currentRun = 0;
        }
      }
      const fence = BACKTICK.repeat(Math.max(1, maxRun + 1));
      const needsPadding = text.startsWith(BACKTICK) || text.endsWith(BACKTICK) || /^\s/.test(text) || /\s$/.test(text);
      const content = needsPadding ? ' ' + text + ' ' : text;
      return fence + content + fence;
    };

    const extractCodeLanguage = (code: any) => {
      if (!code) return '';
      const className = String(code.className ?? '');
      const match = className.match(/language-([a-z0-9#+-]+)/i);
      if (match && match[1]) return match[1];
      const dataLang =
        code.getAttribute?.('data-language') ||
        code.getAttribute?.('data-lang') ||
        code.dataset?.language ||
        '';
      return String(dataLang ?? '').trim();
    };

    const shouldIgnore = (node: any) => {
      const tag = (node?.tagName || '').toLowerCase();
      if (!tag) return false;
      return (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        tag === 'button' ||
        tag === 'svg' ||
        tag === 'path' ||
        tag === 'title' ||
        tag === 'desc'
      );
    };

    const renderChildren = (parent: any, ctx: any): string =>
      Array.from(parent?.childNodes || []).map((child: any) => render(child, ctx)).join('');

    const renderListItem = (li: any, ordered: boolean, index: number, ctx: any): string => {
      const indent = ctx?.listIndent ?? '';
      const marker = ordered ? String(index) + '. ' : '- ';
      const parts: string[] = [];
      const nested: string[] = [];
      for (const child of Array.from(li?.childNodes || []) as any[]) {
        if (child && child.nodeType === ELEMENT_NODE) {
          const tag = (child.tagName || '').toLowerCase();
          if (tag === 'ul' || tag === 'ol') {
            nested.push(render(child, { ...ctx, listIndent: indent + '  ' }));
            continue;
          }
        }
        parts.push(render(child, ctx));
      }
      const contentRaw = normalizeNewlines(parts.join('')).trim();
      const contentLines = contentRaw ? contentRaw.split('\n') : [];
      const firstLine = (contentLines.shift() ?? '').trim();
      let line = indent + marker + firstLine;
      const continuationIndent = indent + ' '.repeat(marker.length);
      if (contentLines.length > 0) {
        const continuation = contentLines
          .map((value) => continuationIndent + String(value ?? '').trimEnd())
          .join('\n')
          .trimEnd();
        if (continuation) {
          line = line.trimEnd() + '\n' + continuation;
        }
      }
      const nestedText = nested.join('').trimEnd();
      if (nestedText) {
        line += '\n' + nestedText;
      }
      return line.trimEnd();
    };

    const renderList = (node: any, ordered: boolean, ctx: any): string => {
      const items = Array.from(node?.children || []).filter(
        (child: any) => (child?.tagName || '').toLowerCase() === 'li',
      );
      if (!items.length) return '';
      const lines: string[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const li = items[i];
        const line = renderListItem(li, ordered, i + 1, ctx);
        if (line) lines.push(line);
      }
      return lines.join('\n') + '\n\n';
    };

    const render = (node: any, ctx: any): string => {
      if (!node) return '';
      if (node.nodeType === TEXT_NODE) {
        return String(node.nodeValue ?? '');
      }
      if (node.nodeType !== ELEMENT_NODE) {
        return '';
      }
      if (shouldIgnore(node)) {
        return '';
      }
      const tag = (node.tagName || '').toLowerCase();
      if (!tag) {
        return renderChildren(node, ctx);
      }
      if (tag === 'br') {
        return '\n';
      }
      if (tag === 'pre') {
        const code = node.querySelector?.('code');
        const lang = extractCodeLanguage(code);
        const raw = code ? code.textContent ?? '' : node.textContent ?? '';
        const codeText = normalizeNewlines(raw).replace(/\n+$/g, '');
        return FENCE + (lang ? lang : '') + '\n' + codeText + '\n' + FENCE + '\n\n';
      }
      if (tag === 'code') {
        if (ctx?.inPre) {
          return String(node.textContent ?? '');
        }
        const text = String(node.textContent ?? '');
        if (!text) return '';
        return formatInlineCode(text);
      }
      if (tag === 'ul') {
        return renderList(node, false, ctx);
      }
      if (tag === 'ol') {
        return renderList(node, true, ctx);
      }
      if (/^h[1-6]$/.test(tag)) {
        const level = Number.parseInt(tag.slice(1), 10);
        const prefix = '#'.repeat(Number.isFinite(level) && level > 0 ? level : 1);
        const text = renderChildren(node, ctx).trim();
        return text ? prefix + ' ' + text + '\n\n' : '';
      }
      if (tag === 'p') {
        const text = renderChildren(node, ctx).trim();
        return text ? text + '\n\n' : '';
      }
      if (tag === 'a') {
        const href = String(node.getAttribute?.('href') ?? '').trim();
        const text = renderChildren(node, ctx).trim() || href;
        if (!href) return text;
        return '[' + text + '](' + href + ')';
      }
      if (tag === 'strong' || tag === 'b') {
        const text = renderChildren(node, ctx).trim();
        return text ? '**' + text + '**' : '';
      }
      if (tag === 'em' || tag === 'i') {
        const text = renderChildren(node, ctx).trim();
        return text ? '*' + text + '*' : '';
      }
      return renderChildren(node, ctx);
    };

    const rootTag = (root.tagName || '').toLowerCase();
    let markdown =
      rootTag === 'body'
        ? renderChildren(root, { listIndent: '', inPre: false })
        : render(root, { listIndent: '', inPre: false });
    markdown = normalizeNewlines(markdown);
    const fencedBlocks: string[] = [];
    const fencePattern = new RegExp(FENCE + '[^]*?' + FENCE, 'g');
    markdown = markdown.replace(fencePattern, (match: string) => {
      fencedBlocks.push(match);
      return '__ORACLE_CODE_BLOCK_' + (fencedBlocks.length - 1) + '__';
    });
    markdown = markdown.replace(/[ \t]+\n/g, '\n');
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
    markdown = markdown.replace(/__ORACLE_CODE_BLOCK_(\d+)__/g, (_match: string, index: string) => {
      const idx = Number(index);
      return Number.isFinite(idx) && fencedBlocks[idx] ? fencedBlocks[idx] : '';
    });
    return markdown;
  } catch {
    return '';
  }
}

interface AssistantSnapshot {
  text?: string;
  html?: string;
  messageId?: string | null;
  turnId?: string | null;
  turnIndex?: number | null;
  hasAnswerNowGate?: boolean;
}

const LANGUAGE_TAGS = new Set(
  [
    'copy code',
    'markdown',
    'bash',
    'sh',
    'shell',
    'javascript',
    'typescript',
    'ts',
    'js',
    'yaml',
    'json',
    'python',
    'py',
    'go',
    'java',
    'c',
    'c++',
    'cpp',
    'c#',
    'php',
    'ruby',
    'rust',
    'swift',
    'kotlin',
    'html',
    'css',
    'sql',
    'text',
  ].map((token) => token.toLowerCase()),
);

function cleanAssistantText(text: string): string {
  const normalized = text.replace(/\u00a0/g, ' ');
  const lines = normalized.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim().toLowerCase();
    if (LANGUAGE_TAGS.has(trimmed)) return false;
    return true;
  });
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
