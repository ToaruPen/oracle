import { describe, expect, test } from 'vitest';
import { isAnswerNowPlaceholderTextForTest } from '../../src/browser/actions/assistantResponse.ts';

describe('assistantResponse placeholder detection', () => {
  test('treats label-only turns as placeholders only when Answer now gate is present', () => {
    expect(isAnswerNowPlaceholderTextForTest('ChatGPT:', { hasAnswerNowGate: true })).toBe(true);
    expect(isAnswerNowPlaceholderTextForTest('chatgpt', { hasAnswerNowGate: true })).toBe(true);
    expect(isAnswerNowPlaceholderTextForTest('ChatGPT:', { hasAnswerNowGate: false })).toBe(false);
    expect(isAnswerNowPlaceholderTextForTest('assistant', { hasAnswerNowGate: false })).toBe(false);
  });

  test('treats "ChatGPT said" labels as placeholders', () => {
    expect(isAnswerNowPlaceholderTextForTest('ChatGPT said')).toBe(true);
  });

  test('treats English Answer now gate as placeholder', () => {
    const text = 'ChatGPT said:\nPro thinking\nAnswer now'.toLowerCase();
    expect(isAnswerNowPlaceholderTextForTest(text)).toBe(true);
  });

  test('treats Japanese Answer now gate as placeholder', () => {
    const text = 'Pro が思考中です • コードを記述しています\n今すぐ回答'.toLowerCase();
    expect(isAnswerNowPlaceholderTextForTest(text)).toBe(true);
  });

  test('does not treat normal Japanese text as placeholder', () => {
    const text = '今すぐ回答してください'.toLowerCase();
    expect(isAnswerNowPlaceholderTextForTest(text)).toBe(false);
  });
});
