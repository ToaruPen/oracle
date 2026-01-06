import type { ChromeClient, BrowserLogger } from '../types.js';
import { CONVERSATION_TURN_SELECTOR } from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';

type ConversationProbe = {
  url: string;
  conversationId: string | null;
  backendUserMessage?: boolean | null;
  backendStatus?: number | null;
  domUserTurns?: number;
  domTurns?: number;
};

export async function ensureNewConversation(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  options: { timeoutMs: number },
): Promise<{ started: boolean; fromUrl?: string; toUrl?: string }> {
  const timeoutMs = Math.max(5_000, options.timeoutMs);
  let probe = await readConversationProbe(Runtime);
  if (!probe) {
    return { started: false };
  }

  // "New chat" is needed when we land in an existing thread (e.g., ChatGPT restores the last /c/<id>).
  // When the backend probe is unavailable, treat any /c/<id> landing as unsafe unless we can prove it's empty.
  let shouldStart = shouldStartNewConversation(probe);
  if (!shouldStart) {
    const hydrationMs = Math.min(2_500, Math.max(750, Math.floor(timeoutMs * 0.1)));
    const hydrated = await waitForConversationHydration(Runtime, hydrationMs, probe);
    if (hydrated && shouldStartNewConversation(hydrated)) {
      probe = hydrated;
      shouldStart = true;
      logger('[browser] Conversation hydrated after load; starting a new chat');
    }
  }
  if (!shouldStart) {
    return { started: false };
  }

  logger('[browser] Existing conversation detected; starting a new chat');
  const fromUrl = probe.url;
  const fromConversationId = probe.conversationId;

  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const click = await clickNewChat(Runtime);
    if (!click?.clicked) {
      if (attempt === attempts - 1) {
        await logDomFailure(Runtime, logger, 'new-chat-button');
        throw new Error(
          `Unable to start a new chat: ${click?.reason ?? 'new chat trigger missing'}. ` +
          'Open ChatGPT, click “New chat”, then rerun (or pass a specific /c/<id> URL to continue an existing thread).',
        );
      }
    }

    // Allow route transitions/hydration to settle before probing again.
    await delay(750);
    const after = await waitForConversationReset(Runtime, timeoutMs, fromConversationId);
    if (after) {
      return { started: true, fromUrl, toUrl: after.url };
    }
  }

  await logDomFailure(Runtime, logger, 'new-chat-reset');
  throw new Error(
    `Timed out waiting for a fresh chat after ${Math.round(timeoutMs / 1000)}s. ` +
    'Open ChatGPT, click “New chat”, then rerun (or pass a specific /c/<id> URL to continue an existing thread).',
  );
}

function shouldStartNewConversation(probe: ConversationProbe): boolean {
  return (probe.domUserTurns ?? 0) > 0 || (probe.conversationId !== null && probe.backendUserMessage !== false);
}

async function waitForConversationHydration(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  baseline: ConversationProbe,
): Promise<ConversationProbe | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let latest: ConversationProbe | null = baseline;
  while (Date.now() < deadline) {
    const probe = await readConversationProbe(Runtime);
    if (probe) {
      latest = probe;
      if (shouldStartNewConversation(probe)) {
        return probe;
      }
    }
    await delay(200);
  }
  return latest;
}

async function waitForConversationReset(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  fromConversationId: string | null,
): Promise<ConversationProbe | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await readConversationProbe(Runtime);
    if (!probe) {
      await delay(250);
      continue;
    }
    const moved = fromConversationId ? probe.conversationId !== fromConversationId : probe.url !== '';
    const clean = (probe.domUserTurns ?? 0) === 0 && probe.backendUserMessage !== true;
    if (clean && (probe.backendUserMessage === false || probe.conversationId === null || moved)) {
      return probe;
    }
    await delay(250);
  }
  return null;
}

async function readConversationProbe(Runtime: ChromeClient['Runtime']): Promise<ConversationProbe | null> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildConversationProbeExpression(),
      awaitPromise: true,
      returnByValue: true,
    });
    const value = outcome.result?.value as ConversationProbe | undefined;
    if (!value || typeof value !== 'object') {
      return null;
    }
    if (typeof value.url !== 'string') {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function buildConversationProbeExpression(): string {
  const turnSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `(async () => {
    const url = typeof location === 'object' && location?.href ? String(location.href) : '';
    const match = url.match(/\\/c\\/([a-zA-Z0-9-]+)/);
    const conversationId = match ? match[1] : null;
    const main = document.querySelector('main') || document.body || document.documentElement;
    const turnSelector = ${turnSelectorLiteral};
    const userSelector = '[data-message-author-role="user"], [data-turn="user"]';
    const turns = main ? Array.from(main.querySelectorAll(turnSelector)) : [];
    let domUserTurns = 0;
    for (const turn of turns) {
      if (!(turn instanceof HTMLElement)) continue;
      const role = ((turn.getAttribute('data-message-author-role') || turn.getAttribute('data-turn') || '') + '').toLowerCase();
      if (role === 'user') {
        domUserTurns += 1;
        continue;
      }
      if (turn.querySelector(userSelector)) {
        domUserTurns += 1;
      }
    }

    const getAccessToken = async () => {
      try {
        const res = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          const token =
            data?.accessToken ||
            data?.access_token ||
            data?.token ||
            data?.session?.accessToken ||
            data?.session?.access_token ||
            data?.session?.token ||
            null;
          if (typeof token === 'string' && token.trim()) return token.trim();
        }
      } catch {}
      try {
        const candidates = ['accessToken', 'access_token', 'oai/accessToken', 'oai/access_token', 'oai-token'];
        for (const key of candidates) {
          const value = localStorage.getItem(key);
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
      } catch {}
      return null;
    };

    const probeBackend = async () => {
      if (!conversationId || typeof fetch !== 'function') return { backendUserMessage: null, backendStatus: null };
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = setTimeout(() => controller?.abort?.(), 4000);
      try {
        const token = await getAccessToken();
        const headers = { accept: 'application/json' };
        if (token) headers['authorization'] = 'Bearer ' + token;
        const res = await fetch('/backend-api/conversation/' + conversationId, {
          method: 'GET',
          headers,
          credentials: 'include',
          signal: controller?.signal,
          cache: 'no-store',
        }).catch(() => null);
        if (!res) return { backendUserMessage: null, backendStatus: null };
        const status = res.status || 0;
        if (!res.ok) return { backendUserMessage: null, backendStatus: status };
        const json = await res.json().catch(() => null);
        const mapping = json?.mapping;
        if (!mapping || typeof mapping !== 'object') return { backendUserMessage: null, backendStatus: status };
        const values = Object.values(mapping);
        for (const node of values) {
          const role = node?.message?.author?.role;
          if (typeof role === 'string' && role.toLowerCase() === 'user') {
            return { backendUserMessage: true, backendStatus: status };
          }
        }
        return { backendUserMessage: false, backendStatus: status };
      } catch {
        return { backendUserMessage: null, backendStatus: null };
      } finally {
        clearTimeout(timeout);
      }
    };

    const backend = await probeBackend();
    return {
      url,
      conversationId,
      backendUserMessage: backend.backendUserMessage,
      backendStatus: backend.backendStatus,
      domUserTurns,
      domTurns: turns.length,
    };
  })()`;
}

type ClickResult = { clicked: boolean; reason?: string; label?: string | null; href?: string | null };

async function clickNewChat(Runtime: ChromeClient['Runtime']): Promise<ClickResult | null> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildNewChatClickExpression(),
      returnByValue: true,
    });
    const value = outcome.result?.value as ClickResult | undefined;
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

function buildNewChatClickExpression(): string {
  const helperLiteral = buildNewChatTriggerFinderExpression();
  return `(() => {
    ${buildClickDispatcher()}
    const findNewChatTrigger = ${helperLiteral};
    const target = findNewChatTrigger(document);
    if (!target) {
      return { clicked: false, reason: 'new-chat-trigger-missing', label: null, href: null };
    }
    try {
      target.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {}
    const label =
      (target.getAttribute?.('aria-label') || target.getAttribute?.('title') || target.textContent || '').trim();
    const href = typeof target.getAttribute === 'function' ? target.getAttribute('href') : null;
    const clicked = dispatchClickSequence(target);
    return { clicked: Boolean(clicked), reason: clicked ? undefined : 'click-failed', label, href };
  })()`;
}

export function findNewChatTriggerForTest(root: Document): HTMLElement | null {
  return findNewChatTrigger(root);
}

function buildNewChatTriggerFinderExpression(): string {
  return findNewChatTrigger.toString();
}

function findNewChatTrigger(root: Document): HTMLElement | null {
  const tokens = [
    'new chat',
    'new conversation',
    'new thread',
    '新しいチャット',
    '新規チャット',
    '新しい会話',
    '新規会話',
    '新しいスレッド',
    '新規スレッド',
  ];
  const normalize = (value: unknown) =>
    String(value ?? '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  const isHtmlElement = (value: unknown): value is HTMLElement => {
    if (!value || typeof value !== 'object') return false;
    const node = value as { querySelector?: unknown; getBoundingClientRect?: unknown };
    return typeof node.querySelector === 'function' && typeof node.getBoundingClientRect === 'function';
  };

  const isVisible = (node: HTMLElement) => {
    try {
      if ((node as unknown as { hidden?: unknown }).hidden) return false;
      const ariaHidden = node.getAttribute?.('aria-hidden');
      if (ariaHidden && ariaHidden.toLowerCase() === 'true') return false;
      const style = (node.getAttribute?.('style') ?? '').toLowerCase().replace(/\s+/g, '');
      if (style.includes('display:none') || style.includes('visibility:hidden')) return false;
      const rect = node.getBoundingClientRect?.();
      if (!rect) return true;
      // Learned: lightweight DOMs used in unit tests (e.g., linkedom) report 0x0 rects.
      // Treat that as "visible" unless explicitly hidden by attributes/styles.
      if (rect.width === 0 && rect.height === 0) return true;
      return rect.width > 0 && rect.height > 0;
    } catch {
      return true;
    }
  };

  const getLabel = (node: Element) => {
    const aria = node.getAttribute?.('aria-label');
    if (aria) return aria;
    const title = node.getAttribute?.('title');
    if (title) return title;
    return node.textContent ?? '';
  };

  const matchesToken = (node: Element) => {
    const label = normalize(getLabel(node));
    if (!label) return false;
    return tokens.some((token) => label.includes(token));
  };

  const primarySelectors = [
    '[data-testid="new-chat-button"]',
    '[data-testid*="new-chat"]',
    'button[aria-label*="New chat"]',
    'a[aria-label*="New chat"]',
    'button[aria-label*="新しいチャット"]',
    'a[aria-label*="新しいチャット"]',
  ];
  for (const selector of primarySelectors) {
    const node = root.querySelector(selector);
    if (node && isHtmlElement(node) && isVisible(node)) {
      return node;
    }
  }

  const candidates = Array.from(root.querySelectorAll('button,a,[role="button"]'));
  for (const candidate of candidates) {
    if (!isHtmlElement(candidate)) continue;
    if (!isVisible(candidate)) continue;
    if (matchesToken(candidate)) {
      return candidate;
    }
  }

  return null;
}
