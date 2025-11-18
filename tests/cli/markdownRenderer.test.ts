import { beforeEach, describe, expect, test, vi } from 'vitest';

const codeToTokens = vi.fn();
const createHighlighter = vi.fn().mockResolvedValue({
  getLoadedLanguages: () => ['ts', 'swift', 'js', 'jsx', 'tsx', 'json'],
  codeToTokens,
});

vi.mock('shiki', () => ({
  __esModule: true,
  createHighlighter,
  bundledThemes: { 'github-dark': {} },
  bundledLanguages: {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    json: 'json',
    swift: 'swift',
  },
}));

let originalIsTTY: unknown;
let originalColumns: unknown;

beforeEach(() => {
  originalIsTTY = process.stdout.isTTY;
  originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  codeToTokens.mockReset();
});

describe('renderMarkdownAnsi', () => {
  test('invokes highlighter for supported fenced code blocks', async () => {
    codeToTokens.mockReturnValue({
      tokens: [
        [
          { content: 'let', color: '#ff0000', fontStyle: 0 },
          { content: ' ', color: undefined, fontStyle: 0 },
          { content: 'x', color: '#00ff00', fontStyle: 0 },
        ],
      ],
    });

    const { renderMarkdownAnsi } = await import('../../src/cli/markdownRenderer.ts');
    // ensure highlighter promise settles
    await Promise.resolve();

    const out = renderMarkdownAnsi('```ts\nlet x\n```');
    expect(codeToTokens).toHaveBeenCalledTimes(1);
    expect(codeToTokens).toHaveBeenCalledWith('let x', { lang: 'ts', theme: 'github-dark' });
    expect(out).toContain('let x');
    expect(out).toContain('[ts]');
  });

  test('skips highlighter for unsupported languages', async () => {
    const { renderMarkdownAnsi } = await import('../../src/cli/markdownRenderer.ts');
    await Promise.resolve();

    renderMarkdownAnsi('```bash\necho hi\n```');
    expect(codeToTokens).not.toHaveBeenCalled();
  });
});
