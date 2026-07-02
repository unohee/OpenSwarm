/**
 * Script to delete failed Beliefs
 * Target: failed entries from "service end-to-end test and bug fix"
 */
import { connect } from '@lancedb/lancedb';
import { resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const MEMORY_DIR = resolve(homedir(), '.openswarm/memory');
const DELETE_FILTER = `type = 'belief' AND content LIKE '%service end-to-end test and bug fix%' AND content LIKE '%failed%'`;

export async function deleteFailedBeliefs(options: { confirm?: boolean } = {}) {
  console.log('[Delete] Connecting to LanceDB at:', MEMORY_DIR);

  const db = await connect(MEMORY_DIR);
  const tables = await db.tableNames();

  console.log('[Delete] Available tables:', tables);

  const tableName = tables.find(t => t.includes('memory') || t === 'cognitive_memory');
  if (!tableName) {
    console.log('[Delete] No memory table found');
    return;
  }

  const table = await db.openTable(tableName);

  // Verify before deletion
  const beforeCount = await table.countRows();
  console.log(`[Delete] Total records before: ${beforeCount}`);

  console.log('[Delete] Filter:', DELETE_FILTER);

  if (!options.confirm) {
    console.log('[Delete] Dry run only. Re-run with --confirm to delete matching records.');
    return;
  }

  await table.delete(DELETE_FILTER);

  const afterCount = await table.countRows();
  console.log(`[Delete] Total records after: ${afterCount}`);
  console.log(`[Delete] Deleted: ${beforeCount - afterCount} records`);

  console.log('[Delete] Done!');
}

function isDirectRun(): boolean {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isDirectRun()) {
  deleteFailedBeliefs({ confirm: process.argv.includes('--confirm') }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
