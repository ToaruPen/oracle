import { ensureShikiReady, renderMarkdownAnsi } from './markdownRenderer.js';

interface RenderOptions {
  richTty?: boolean;
}

/**
 * Format markdown for CLI output. Uses our ANSI renderer + syntax highlighting
 * when running in a rich TTY; otherwise returns the raw markdown to avoid
 * escape codes in redirected output.
 */
export async function formatRenderedMarkdown(markdown: string, options: RenderOptions = {}): Promise<string> {
  const richTty = options.richTty ?? Boolean(process.stdout.isTTY);
  if (!richTty) return markdown;

  try {
    await ensureShikiReady();
  } catch {
    // If Shiki fails to init (missing terminals/themes), fall back to plain output gracefully.
  }

  try {
    return renderMarkdownAnsi(markdown);
  } catch {
    return markdown;
  }
}
