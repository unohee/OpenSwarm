/**
 * Script to delete failed Beliefs
 * Target: failed entries from "service end-to-end test and bug fix"
 */
import { connect } from '@lancedb/lancedb';
import { resolve } from 'path';
import { homedir } from 'os';

const MEMORY_DIR = resolve(homedir(), '.openswarm/memory');

async function deleteFailedBeliefs() {
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

  // Use LanceDB delete with SQL where condition
  // Delete belief type records containing specific string in content
  const deleteFilter = `type = 'belief' AND content LIKE '%service end-to-end test and bug fix%' AND content LIKE '%failed%'`;

  console.log('[Delete] Applying filter:', deleteFilter);

  await table.delete(deleteFilter);

  const afterCount = await table.countRows();
  console.log(`[Delete] Total records after: ${afterCount}`);
  console.log(`[Delete] Deleted: ${beforeCount - afterCount} records`);

  console.log('[Delete] Done!');
}

deleteFailedBeliefs().catch(console.error);
