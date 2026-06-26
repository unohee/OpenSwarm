// DataTable — minimal column-aligned table for the monitor tabs (S6).
// Hand-rolled (no ink-table) to avoid peer-version risk on ink 7 / react 19.
import { Box, Text } from 'ink';
import type { Table } from '../monitorRows.js';

export interface DataTableProps extends Table {
  empty?: string;
}

export function DataTable({ columns, rows, empty }: DataTableProps) {
  if (rows.length === 0) {
    return <Text dimColor>{empty ?? '(no data)'}</Text>;
  }
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]) => cells.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ');
  return (
    <Box flexDirection="column">
      <Text bold>{fmt(columns)}</Text>
      {rows.map((r, i) => (
        <Text key={i}>{fmt(r)}</Text>
      ))}
    </Box>
  );
}
