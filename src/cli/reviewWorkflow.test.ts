import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('OpenSwarm review workflow bootstrap (INT-2552)', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/review.yml'), 'utf8');
  const document = parse(workflow) as { jobs: { review: { 'runs-on': string[]; steps: Array<Record<string, unknown>> } } };
  const steps = document.jobs.review.steps;

  it('prefers the GitHub App token but remains operational before secrets are installed', () => {
    const token = steps.find((step) => step.uses === 'actions/create-github-app-token@v1');
    const comment = steps.find((step) => step.name === 'Post review comment');
    expect(document.jobs.review['runs-on']).toEqual(['self-hosted', 'openswarm-review']);
    expect(token).toMatchObject({ id: 'app-token', 'continue-on-error': true });
    expect(comment?.env).toMatchObject({ GH_TOKEN: '${{ steps.app-token.outputs.token || github.token }}' });
  });

  it('does not fail the comment step merely because review output is absent', () => {
    const comment = steps.find((step) => step.name === 'Post review comment');
    expect(comment?.run).toContain('if [ -f review-output.txt ]');
  });
});
