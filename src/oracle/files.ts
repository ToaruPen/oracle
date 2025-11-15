import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileContent, FileSection, MinimalFsModule } from './types.js';

async function expandToFiles(targetPath: string, fsModule: MinimalFsModule): Promise<string[]> {
  let stats;
  try {
    stats = await fsModule.stat(targetPath);
  } catch {
    throw new Error(`Missing file or directory: ${targetPath}`);
  }
  if (stats.isFile()) {
    return [targetPath];
  }
  if (stats.isDirectory()) {
    const entries = await fsModule.readdir(targetPath);
    const nestedFiles = await Promise.all(
      entries.map((entry) => expandToFiles(path.join(targetPath, entry), fsModule)),
    );
    return nestedFiles.flat();
  }
  throw new Error(`Not a file or directory: ${targetPath}`);
}

export async function readFiles(
  filePaths: string[],
  { cwd = process.cwd(), fsModule = fs as MinimalFsModule } = {},
): Promise<FileContent[]> {
  const files: FileContent[] = [];
  const seen = new Set<string>();
  for (const rawPath of filePaths) {
    const absolutePath = path.resolve(cwd, rawPath);
    const expandedPaths = await expandToFiles(absolutePath, fsModule);
    for (const concretePath of expandedPaths) {
      if (seen.has(concretePath)) {
        continue;
      }
      seen.add(concretePath);
      const content = await fsModule.readFile(concretePath, 'utf8');
      files.push({ path: concretePath, content });
    }
  }
  return files;
}

export function createFileSections(files: FileContent[], cwd = process.cwd()): FileSection[] {
  return files.map((file, index) => {
    const relative = path.relative(cwd, file.path) || file.path;
    const sectionText = [
      `### File ${index + 1}: ${relative}`,
      '```',
      file.content.trimEnd(),
      '```',
    ].join('\n');
    return {
      index: index + 1,
      absolutePath: file.path,
      displayPath: relative,
      sectionText,
      content: file.content,
    };
  });
}
