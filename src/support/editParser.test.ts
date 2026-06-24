import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseSearchReplaceBlocks,
  applyEditBlock,
  SEARCH_REPLACE_PROMPT,
  WHOLE_FILE_PROMPT,
} from './editParser.js';

// ---- parseSearchReplaceBlocks ----

describe('parseSearchReplaceBlocks', () => {
  it('parses a single block inside a code fence', () => {
    const content = `src/foo.ts
\`\`\`typescript
<<<<<<< SEARCH
function oldName() {
  return "old";
}
=======
function newName() {
  return "new";
}
>>>>>>> REPLACE
\`\`\``;
    const result = parseSearchReplaceBlocks(content);
    expect(result.success).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].filePath).toBe('src/foo.ts');
    expect(result.blocks[0].search).toContain('oldName');
    expect(result.blocks[0].replace).toContain('newName');
    expect(result.errors).toHaveLength(0);
  });

  it('returns success=false when no SEARCH/REPLACE blocks present', () => {
    const result = parseSearchReplaceBlocks('No changes needed here.');
    expect(result.success).toBe(false);
    expect(result.blocks).toHaveLength(0);
  });

  it('detects new-file creation (empty SEARCH section)', () => {
    const content = `src/new.ts
\`\`\`typescript
<<<<<<< SEARCH
=======
export const x = 1;
>>>>>>> REPLACE
\`\`\``;
    const result = parseSearchReplaceBlocks(content);
    expect(result.success).toBe(true);
    expect(result.blocks[0].isNewFile).toBe(true);
    expect(result.blocks[0].replace).toContain('export const x');
  });

  it('parses multiple blocks from a single response', () => {
    const content = `src/a.ts
\`\`\`typescript
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE
\`\`\`

src/b.ts
\`\`\`typescript
<<<<<<< SEARCH
const b = 1;
=======
const b = 3;
>>>>>>> REPLACE
\`\`\``;
    const result = parseSearchReplaceBlocks(content);
    expect(result.success).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].filePath).toBe('src/a.ts');
    expect(result.blocks[1].filePath).toBe('src/b.ts');
  });
});

// ---- applyEditBlock ----

describe('applyEditBlock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'editparser-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('applies a SEARCH/REPLACE edit to an existing file', async () => {
    const file = path.join(tmpDir, 'foo.ts');
    await fs.writeFile(file, 'function oldName() {\n  return "old";\n}\n');

    const result = await applyEditBlock(
      {
        filePath: 'foo.ts',
        search: 'function oldName() {\n  return "old";\n}',
        replace: 'function newName() {\n  return "new";\n}',
      },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const updated = await fs.readFile(file, 'utf-8');
    expect(updated).toContain('newName');
    expect(updated).not.toContain('oldName');
  });

  it('creates a new file when isNewFile=true (empty search)', async () => {
    const result = await applyEditBlock(
      {
        filePath: 'new-file.ts',
        search: '',
        replace: 'export const x = 1;\n',
        isNewFile: true,
      },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const created = await fs.readFile(path.join(tmpDir, 'new-file.ts'), 'utf-8');
    expect(created).toBe('export const x = 1;\n');
  });

  it('returns error when search text is not found', async () => {
    const file = path.join(tmpDir, 'bar.ts');
    await fs.writeFile(file, 'const x = 1;\n');

    const result = await applyEditBlock(
      { filePath: 'bar.ts', search: 'does not exist', replace: 'replaced' },
      tmpDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('round-trips parseSearchReplaceBlocks → applyEditBlock', async () => {
    const file = path.join(tmpDir, 'src', 'utils.ts');
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(file, 'export function add(a: number, b: number) {\n  return a + b;\n}\n');

    const llmOutput = `src/utils.ts
\`\`\`typescript
<<<<<<< SEARCH
export function add(a: number, b: number) {
  return a + b;
}
=======
export function add(a: number, b: number): number {
  return a + b;
}
>>>>>>> REPLACE
\`\`\``;

    const parsed = parseSearchReplaceBlocks(llmOutput);
    expect(parsed.success).toBe(true);
    expect(parsed.blocks).toHaveLength(1);

    for (const block of parsed.blocks) {
      const applyResult = await applyEditBlock(block, tmpDir);
      expect(applyResult.success).toBe(true);
    }

    const updated = await fs.readFile(file, 'utf-8');
    expect(updated).toContain(': number {');
  });
});

// ---- prompt constants ----

describe('prompt constants', () => {
  it('SEARCH_REPLACE_PROMPT contains required markers', () => {
    expect(SEARCH_REPLACE_PROMPT).toContain('<<<<<<< SEARCH');
    expect(SEARCH_REPLACE_PROMPT).toContain('>>>>>>> REPLACE');
  });

  it('WHOLE_FILE_PROMPT instructs write_file and warns against edit_file', () => {
    expect(WHOLE_FILE_PROMPT).toContain('write_file');
    // The prompt must explicitly tell the model NOT to use edit_file
    expect(WHOLE_FILE_PROMPT).toContain('edit_file');
    expect(WHOLE_FILE_PROMPT).toContain('not available');
  });
});
