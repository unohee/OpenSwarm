import { describe, it, expect } from 'vitest';
import type { WorkerResult } from './agentPair.js';
import { missingWorkerValidationIssues } from './workerValidationEvidence.js';

function worker(partial: Partial<WorkerResult>): WorkerResult {
  return {
    success: true,
    summary: 'test',
    filesChanged: [],
    commands: [],
    output: '',
    ...partial,
  } as WorkerResult;
}

describe('missingWorkerValidationIssues', () => {
  it('accepts a validation command chained after a leading inspection verb', () => {
    // Regression: `git diff && npm test` was rejected because the inspection
    // short-circuit fired before the validation check.
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['src/example.ts'],
      commands: ['git diff && npm test'],
    }))).toEqual([]);

    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['src/example.ts'],
      commands: ['git status; npm run build'],
    }))).toEqual([]);
  });

  it('still rejects an inspection command that only mentions a test string', () => {
    // `rg "npm test"` searches for the string, it does not run it.
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['src/example.ts'],
      commands: ['rg "npm test" package.json'],
    })).length).toBeGreaterThan(0);
  });

  it('flags .mts/.cts source edited without a validation command', () => {
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['src/config.mts'],
      commands: [],
    })).length).toBeGreaterThan(0);
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['src/loader.cts'],
      commands: [],
    })).length).toBeGreaterThan(0);
  });

  it('does not require validation for data-only trees (locale/fixtures/snapshots)', () => {
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['src/locales/en.json', 'test/fixtures/data.json', 'src/__snapshots__/a.snap'],
      commands: [],
    }))).toEqual([]);
  });

  it('still gates real source modules that live under a data/mock/fixture dir', () => {
    // The data-dir exemption must not bypass code — a .ts under __mocks__/fixtures
    // is a source change that needs a validation command.
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['src/__mocks__/api.ts'],
      commands: [],
    })).length).toBeGreaterThan(0);
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['test/fixtures/helper.ts'],
      commands: [],
    })).length).toBeGreaterThan(0);
  });

  it('treats a source module named readme.ts as code, not docs', () => {
    // README.md is docs; readme.ts is a real module and must hit the gate.
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['src/readme.ts'],
      commands: [],
    })).length).toBeGreaterThan(0);
    expect(missingWorkerValidationIssues(worker({
      filesChanged: ['README.md', 'CHANGELOG.md'],
      commands: [],
    }))).toEqual([]);
  });
});
