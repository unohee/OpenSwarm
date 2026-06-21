import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSteps, isMissingTool } from './localCI.js';

describe('localCI', () => {
  const dirs: string[] = [];
  const mkProject = (files: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'localci-'));
    dirs.push(dir);
    for (const f of files) writeFileSync(join(dir, f), '');
    return dir;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  describe('detectSteps', () => {
    it('detects a Python project (ruff + pytest)', () => {
      for (const marker of ['pyproject.toml', 'setup.py', 'requirements.txt']) {
        const steps = detectSteps(mkProject([marker]));
        expect(steps.map((s) => s.label)).toEqual(['ruff', 'pytest']);
      }
    });

    it('detects a Node project (tsc + npm test)', () => {
      const steps = detectSteps(mkProject(['package.json']));
      expect(steps.map((s) => s.label)).toEqual(['tsc', 'npm test']);
    });

    it('prefers Python when both markers exist', () => {
      const steps = detectSteps(mkProject(['pyproject.toml', 'package.json']));
      expect(steps.map((s) => s.label)).toEqual(['ruff', 'pytest']);
    });

    it('returns no steps for an unrecognized project', () => {
      expect(detectSteps(mkProject(['README.md']))).toEqual([]);
    });
  });

  describe('isMissingTool', () => {
    it('matches missing-tool errors (so they are skipped, not failed)', () => {
      expect(isMissingTool('ruff: command not found')).toBe(true);
      expect(isMissingTool('spawn ruff ENOENT')).toBe(true);
      expect(isMissingTool('No such file or directory')).toBe(true);
      expect(isMissingTool('pytest: not found')).toBe(true);
    });

    it('does not match a real test failure', () => {
      expect(isMissingTool('FAILED tests/test_x.py::test_foo - assert 1 == 2')).toBe(false);
      expect(isMissingTool('2 failed, 3 passed')).toBe(false);
    });
  });
});
