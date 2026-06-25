import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseV4A, applyV4APatch } from './applyPatch.js';
import { executeTool } from './tools.js';

let dir: string;
const resolve = (p: string) => path.join(dir, p);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v4a-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe('parseV4A', () => {
  it('throws on missing Begin marker', () => {
    expect(() => parseV4A('no envelope here')).toThrow(/Begin Patch/);
  });

  it('parses update / add / delete / move ops', () => {
    const ops = parseV4A(wrap(
      '*** Update File: a.ts\n@@\n-old\n+new\n' +
      '*** Add File: b.ts\n+line1\n+line2\n' +
      '*** Delete File: c.ts\n' +
      '*** Update File: d.ts\n*** Move to: e.ts\n@@\n-x\n+y',
    ));
    expect(ops.map((o) => o.kind)).toEqual(['update', 'add', 'delete', 'update']);
    expect(ops[1].addLines).toEqual(['line1', 'line2']);
    expect(ops[3].moveTo).toBe('e.ts');
  });
});

describe('applyV4APatch', () => {
  it('applies a single-hunk update with context anchoring', async () => {
    await fs.writeFile(resolve('sample.txt'), 'hello FOO world', 'utf-8');
    const res = await applyV4APatch(
      wrap('*** Update File: sample.txt\n@@\n-hello FOO world\n+hello BAR world'),
      dir, resolve,
    );
    expect(res.errors).toEqual([]);
    expect(res.changed).toEqual(['sample.txt']);
    expect(await fs.readFile(resolve('sample.txt'), 'utf-8')).toBe('hello BAR world');
  });

  it('anchors a change using surrounding context lines', async () => {
    await fs.writeFile(resolve('f.ts'), 'a\nb\nc\nd\ne', 'utf-8');
    const res = await applyV4APatch(
      wrap('*** Update File: f.ts\n@@\n b\n-c\n+C\n d'),
      dir, resolve,
    );
    expect(res.errors).toEqual([]);
    expect(await fs.readFile(resolve('f.ts'), 'utf-8')).toBe('a\nb\nC\nd\ne');
  });

  it('applies multiple hunks to one file', async () => {
    await fs.writeFile(resolve('m.ts'), 'one\ntwo\nthree\nfour\nfive\nsix', 'utf-8');
    const res = await applyV4APatch(
      wrap('*** Update File: m.ts\n@@\n-one\n+ONE\n@@\n-five\n+FIVE'),
      dir, resolve,
    );
    expect(res.errors).toEqual([]);
    expect(await fs.readFile(resolve('m.ts'), 'utf-8')).toBe('ONE\ntwo\nthree\nfour\nFIVE\nsix');
  });

  it('creates a new file with Add File', async () => {
    const res = await applyV4APatch(
      wrap('*** Add File: nested/new.ts\n+export const x = 1;\n+export const y = 2;'),
      dir, resolve,
    );
    expect(res.errors).toEqual([]);
    expect(await fs.readFile(resolve('nested/new.ts'), 'utf-8')).toBe('export const x = 1;\nexport const y = 2;');
  });

  it('deletes a file with Delete File', async () => {
    await fs.writeFile(resolve('gone.txt'), 'bye', 'utf-8');
    const res = await applyV4APatch(wrap('*** Delete File: gone.txt'), dir, resolve);
    expect(res.errors).toEqual([]);
    await expect(fs.access(resolve('gone.txt'))).rejects.toThrow();
  });

  it('renames via Move to while applying the update', async () => {
    await fs.writeFile(resolve('old.ts'), 'v = 1', 'utf-8');
    const res = await applyV4APatch(
      wrap('*** Update File: old.ts\n*** Move to: new.ts\n@@\n-v = 1\n+v = 2'),
      dir, resolve,
    );
    expect(res.errors).toEqual([]);
    expect(await fs.readFile(resolve('new.ts'), 'utf-8')).toBe('v = 2');
    await expect(fs.access(resolve('old.ts'))).rejects.toThrow();
  });

  it('reports an error when the hunk context is not found', async () => {
    await fs.writeFile(resolve('s.txt'), 'actual content', 'utf-8');
    const res = await applyV4APatch(
      wrap('*** Update File: s.txt\n@@\n-nonexistent line\n+replacement'),
      dir, resolve,
    );
    expect(res.changed).toEqual([]);
    expect(res.errors[0]).toMatch(/context not found/);
  });
});

describe('executeTool: apply_patch dispatch', () => {
  const call = (input: string) => ({ id: 'c1', type: 'function' as const, function: { name: 'apply_patch', arguments: JSON.stringify({ input }) } });

  it('applies a V4A patch through the tool executor', async () => {
    await fs.writeFile(resolve('app.ts'), 'const v = 1;', 'utf-8');
    const r = await executeTool(call(wrap('*** Update File: app.ts\n@@\n-const v = 1;\n+const v = 2;')), dir);
    expect(r.is_error).toBe(false);
    expect(r.content).toMatch(/Patched: app\.ts/);
    expect(await fs.readFile(resolve('app.ts'), 'utf-8')).toBe('const v = 2;');
  });

  it('rejects input that is not a V4A envelope', async () => {
    const r = await executeTool(call('just change line 1'), dir);
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/Begin Patch/);
  });

  it('refuses to patch protected files', async () => {
    await fs.writeFile(resolve('guard.test.ts'), 'x', 'utf-8');
    const r = await executeTool(
      call(wrap('*** Update File: guard.test.ts\n@@\n-x\n+y')),
      dir, undefined, { protectedFiles: [resolve('guard.test.ts')] },
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/PROTECTED/);
  });
});
