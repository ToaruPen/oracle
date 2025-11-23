import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunOracleOptions } from '../oracle.js';
import {
  readFiles,
  createFileSections,
  MODEL_CONFIGS,
  TOKENIZER_OPTIONS,
  formatFileSection,
} from '../oracle.js';
import { isKnownModel } from '../oracle/modelResolver.js';
import { buildPromptMarkdown } from '../oracle/promptAssembly.js';
import type { BrowserAttachment } from './types.js';
import { buildAttachmentPlan } from './policies.js';

export interface BrowserPromptArtifacts {
  markdown: string;
  composerText: string;
  estimatedInputTokens: number;
  attachments: BrowserAttachment[];
  inlineFileCount: number;
  tokenEstimateIncludesInlineFiles: boolean;
  bundled?: { originalCount: number; bundlePath: string } | null;
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
  const systemPrompt = runOptions.system?.trim() || '';
  const sections = createFileSections(files, cwd);
  const markdown = buildPromptMarkdown(systemPrompt, userPrompt, sections);
  const inlineFiles = Boolean(runOptions.browserInlineFiles);
  const composerSections: string[] = [];
  if (systemPrompt) composerSections.push(systemPrompt);
  if (userPrompt) composerSections.push(userPrompt);

  const attachmentPlan = buildAttachmentPlan(sections, {
    inlineFiles,
    bundleRequested: Boolean(runOptions.browserBundleFiles),
  });

  if (attachmentPlan.inlineBlock) {
    composerSections.push(attachmentPlan.inlineBlock);
  }

  const composerText = composerSections.join('\n\n').trim();
  const attachments: BrowserAttachment[] = attachmentPlan.attachments.slice();

  const shouldBundle = attachmentPlan.shouldBundle;
  let bundleText: string | null = null;
  if (shouldBundle) {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-browser-bundle-'));
    const bundlePath = path.join(bundleDir, 'attachments-bundle.txt');
    const bundleLines: string[] = [];
    sections.forEach((section) => {
      bundleLines.push(formatFileSection(section.displayPath, section.content).trimEnd());
      bundleLines.push('');
    });
    bundleText = `${bundleLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
    await fs.writeFile(bundlePath, bundleText, 'utf8');
    attachments.length = 0;
    attachments.push({
      path: bundlePath,
      displayPath: bundlePath,
      sizeBytes: Buffer.byteLength(bundleText, 'utf8'),
    });
  }
  const inlineFileCount = attachmentPlan.inlineFileCount;
  const modelConfig = isKnownModel(runOptions.model) ? MODEL_CONFIGS[runOptions.model] : MODEL_CONFIGS['gpt-5.1'];
  const tokenizer = modelConfig.tokenizer;
  const tokenizerUserContent =
    inlineFileCount > 0 && attachmentPlan.inlineBlock
      ? [userPrompt, attachmentPlan.inlineBlock].filter((value) => Boolean(value?.trim())).join('\n\n').trim()
      : userPrompt;
  const tokenizerMessages = [
    systemPrompt ? { role: 'system', content: systemPrompt } : null,
    tokenizerUserContent ? { role: 'user', content: tokenizerUserContent } : null,
  ].filter(Boolean) as Array<{ role: 'system' | 'user'; content: string }>;
  let estimatedInputTokens = tokenizer(
    tokenizerMessages.length > 0
      ? tokenizerMessages
      : [{ role: 'user', content: '' }],
    TOKENIZER_OPTIONS,
  );
  const tokenEstimateIncludesInlineFiles = inlineFileCount > 0 && Boolean(attachmentPlan.inlineBlock);
  if (!tokenEstimateIncludesInlineFiles && sections.length > 0) {
    const attachmentText =
      bundleText ??
      sections
        .map((section) => formatFileSection(section.displayPath, section.content).trimEnd())
        .join('\n\n');
    const attachmentTokens = tokenizer(
      [{ role: 'user', content: attachmentText }],
      TOKENIZER_OPTIONS,
    );
    estimatedInputTokens += attachmentTokens;
  }
  return {
    markdown,
    composerText,
    estimatedInputTokens,
    attachments,
    inlineFileCount,
    tokenEstimateIncludesInlineFiles,
    bundled:
      shouldBundle && attachments.length === 1 && attachments[0]?.displayPath
        ? { originalCount: sections.length, bundlePath: attachments[0].displayPath }
        : null,
  };
}
