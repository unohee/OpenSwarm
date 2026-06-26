import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { DataTable } from './components/DataTable.js';

describe('DataTable (EPIC INT-1813 S6)', () => {
  it('renders an empty state', () => {
    expect(render(<DataTable columns={['A']} rows={[]} empty="nothing here" />).lastFrame()).toContain('nothing here');
  });

  it('renders header + column-aligned rows', () => {
    const f = render(
      <DataTable columns={['ID', 'NAME']} rows={[['1', 'alpha'], ['2', 'beta']]} />,
    ).lastFrame()!;
    expect(f).toContain('ID');
    expect(f).toContain('NAME');
    expect(f).toContain('alpha');
    expect(f).toContain('beta');
  });
});
