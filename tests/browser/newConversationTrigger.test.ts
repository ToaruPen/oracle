import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import { findNewChatTriggerForTest } from '../../src/browser/actions/newConversation.ts';

describe('new conversation trigger', () => {
  test('prefers data-testid selector when present', () => {
    const { document } = parseHTML(
      '<html><body><button data-testid="new-chat-button" aria-label="Something else">+</button></body></html>',
    );
    const trigger = findNewChatTriggerForTest(document);
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('data-testid')).toBe('new-chat-button');
  });

  test('matches aria-label in English', () => {
    const { document } = parseHTML('<html><body><button aria-label="New chat">New</button></body></html>');
    const trigger = findNewChatTriggerForTest(document);
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-label')).toBe('New chat');
  });

  test('matches aria-label in Japanese', () => {
    const { document } = parseHTML('<html><body><button aria-label="新しいチャット">新しいチャット</button></body></html>');
    const trigger = findNewChatTriggerForTest(document);
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-label')).toBe('新しいチャット');
  });
});

