import { describe, expect, test } from 'vitest';
import {
  buildAttachmentReadyExpressionForTest,
  buildAttemptSendButtonExpressionForTest,
} from '../../src/browser/actions/promptComposer.ts';

describe('prompt composer attachment expressions', () => {
  test('attachment ready check does not match prompt text', () => {
    const expression = buildAttachmentReadyExpressionForTest(['oracle-attach-verify.txt']);
    expect(expression).toContain("document.querySelector('[data-testid*=\"composer\"]')");
    expect(expression).toContain('composer.querySelectorAll');
    expect(expression).toContain('input[type="file"]');
    expect(expression).not.toContain('a,div,span');
    expect(expression).not.toContain('document.querySelectorAll(\'[data-testid*="chip"],[data-testid*="attachment"],a,div,span\')');
  });
});

describe('prompt composer send button expression', () => {
  test('scopes send button lookup to the active composer', () => {
    const expression = buildAttemptSendButtonExpressionForTest();
    expect(expression).toContain("anchor.closest('form')");
    expect(expression).toContain('scope.querySelectorAll(selector)');
    expect(expression).toContain("'button[type=\"submit\"]'");
    expect(expression).toContain('document.querySelector("#prompt-textarea")');
    expect(expression).toContain('scopeHasPrompt');
    expect(expression).toContain('allowGenericSubmit');
    expect(expression).not.toContain('form button[type="submit"]');
  });
});
