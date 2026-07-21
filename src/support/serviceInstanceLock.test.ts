import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireServiceInstanceLock } from './serviceInstanceLock.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('service instance lifetime lock', () => {
  it('admits one owner and becomes immediately reusable after release', () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-instance-lock-'));
    roots.push(root);
    const path = join(root, 'service.db');
    const first = acquireServiceInstanceLock(path);

    expect(() => acquireServiceInstanceLock(path)).toThrow(/owns the instance lock/i);

    first.release();
    const replacement = acquireServiceInstanceLock(path);
    replacement.release();
    replacement.release();
  });
});
