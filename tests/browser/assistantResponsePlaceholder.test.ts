import { describe, expect, test } from 'vitest';
import { isAnswerNowPlaceholderTextForTest } from '../../src/browser/actions/assistantResponse.ts';

describe('assistantResponse placeholder detection', () => {
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

