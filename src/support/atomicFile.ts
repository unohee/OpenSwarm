import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';

export function atomicWriteFileSync(path: string, contents: string, mode = 0o600): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, 'wx', mode);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

export async function atomicWriteFile(path: string, contents: string, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', mode);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await chmod(path, mode);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
