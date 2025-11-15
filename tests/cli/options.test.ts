import { describe, expect, test } from 'vitest';
import { InvalidArgumentError } from 'commander';
import {
  collectPaths,
  parseFloatOption,
  parseIntOption,
  resolvePreviewMode,
} from '../../src/cli/options.ts';

describe('collectPaths', () => {
  test('merges repeated flags and splits comma-separated values', () => {
    const result = collectPaths(['src/a', 'src/b,src/c'], ['existing']);
    expect(result).toEqual(['existing', 'src/a', 'src/b', 'src/c']);
  });

  test('returns previous list when value is undefined', () => {
    expect(collectPaths(undefined, ['keep'])).toEqual(['keep']);
  });
});

describe('parseFloatOption', () => {
  test('parses numeric strings', () => {
    expect(parseFloatOption('12.5')).toBeCloseTo(12.5);
  });

  test('throws for NaN input', () => {
    expect(() => parseFloatOption('nope')).toThrow(InvalidArgumentError);
  });
});

describe('parseIntOption', () => {
  test('parses integers and allows undefined', () => {
    expect(parseIntOption(undefined)).toBeUndefined();
    expect(parseIntOption('42')).toBe(42);
  });

  test('throws for invalid integers', () => {
    expect(() => parseIntOption('not-a-number')).toThrow(InvalidArgumentError);
  });
});

describe('resolvePreviewMode', () => {
  test('returns explicit mode', () => {
    expect(resolvePreviewMode('json')).toBe('json');
  });

  test('defaults boolean true to summary', () => {
    expect(resolvePreviewMode(true)).toBe('summary');
  });

  test('returns undefined for falsey values', () => {
    expect(resolvePreviewMode(undefined)).toBeUndefined();
    expect(resolvePreviewMode(false)).toBeUndefined();
  });
});
