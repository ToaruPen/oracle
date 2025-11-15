import type { RunOracleOptions } from '../oracle.js';
import { readFiles, createFileSections, DEFAULT_SYSTEM_PROMPT, MODEL_CONFIGS, TOKENIZER_OPTIONS } from '../oracle.js';
import type { BrowserAttachment } from './types.js';

export interface BrowserPromptArtifacts {
  markdown: string;
  composerText: string;
  estimatedInputTokens: number;
  attachments: BrowserAttachment[];
}

interface AssemblePromptDeps {
  cwd?: string;
  readFilesImpl?: typeof readFiles;
}

export async function assembleBrowserPrompt(
  runOptions: RunOracleOptions,
  deps: AssemblePromptDeps = {},
): Promise<BrowserPromptArtifacts> {
  const cwd = deps.cwd ?? process.cwd();
  const readFilesFn = deps.readFilesImpl ?? readFiles;
  const files = await readFilesFn(runOptions.file ?? [], { cwd });
  const basePrompt = (runOptions.prompt ?? '').trim();
  const userPrompt = basePrompt;
  const systemPrompt = runOptions.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const sections = createFileSections(files, cwd);
  const lines = ['[SYSTEM]', systemPrompt, '', '[USER]', userPrompt, ''];
  sections.forEach((section) => {
    lines.push(`[FILE: ${section.displayPath}]`, section.content.trimEnd(), '');
  });
  const markdown = lines.join('\n').trimEnd();
  const inlineFiles = Boolean(runOptions.browserInlineFiles);
  const composerSections: string[] = [];
  if (systemPrompt) {
    composerSections.push(systemPrompt);
  }
  if (userPrompt) {
    composerSections.push(userPrompt);
  }
  if (inlineFiles && sections.length > 0) {
    const inlineLines: string[] = [];
    sections.forEach((section) => {
      inlineLines.push(`[FILE: ${section.displayPath}]`, section.content.trimEnd(), '');
    });
    const inlineBlock = inlineLines.join('\n').trim();
    if (inlineBlock) {
      composerSections.push(inlineBlock);
    }
  }
  const composerText = composerSections.join('\n\n').trim();
  const attachments: BrowserAttachment[] = inlineFiles
    ? []
    : sections.map((section) => ({
        path: section.absolutePath,
        displayPath: section.displayPath,
      }));
  const tokenizer = MODEL_CONFIGS[runOptions.model].tokenizer;
  const estimatedInputTokens = tokenizer(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    TOKENIZER_OPTIONS,
  );
  return { markdown, composerText, estimatedInputTokens, attachments };
}
