import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import { htmlToMarkdownForTest } from '../../src/browser/actions/assistantResponse.ts';

function createHtmlToMarkdown() {
  const { window } = parseHTML('<html><body></body></html>');
  return (html: string) =>
    htmlToMarkdownForTest(html, { DOMParser: window.DOMParser, Node: window.Node });
}

describe('assistantResponse htmlToMarkdown conversion', () => {
  test('converts inline code (including embedded backticks)', () => {
    const htmlToMarkdown = createHtmlToMarkdown();
    expect(htmlToMarkdown('<p>Use <code>foo()</code> and <code>bar</code>.</p>')).toBe('Use `foo()` and `bar`.');
    expect(htmlToMarkdown('<p><code>use `code`</code></p>')).toBe('`` use `code` ``');
  });

  test('converts links', () => {
    const htmlToMarkdown = createHtmlToMarkdown();
    expect(htmlToMarkdown('<p><a href="https://example.com">Example</a></p>')).toBe('[Example](https://example.com)');
  });

  test('converts nested lists', () => {
    const htmlToMarkdown = createHtmlToMarkdown();
    const markdown = htmlToMarkdown('<ul><li>Parent<ul><li>Child</li></ul></li></ul>');
    expect(markdown).toContain('- Parent');
    expect(markdown).toContain('  - Child');
  });
});
