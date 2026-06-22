import { describe, expect, it } from 'vitest';
import { parseBlockerIdentifiers } from './linear.js';

// INT-1809: the KYTE team writes dependencies as description prose ("블로커: …")
// rather than structured Linear relations, so the text parser is the high-value path.
describe('parseBlockerIdentifiers', () => {
  it('parses slash-separated ids that share a team prefix', () => {
    // The real KT-308 case: "블로커: KT-305/306/307" — 306/307 are bare numbers.
    expect(parseBlockerIdentifiers('블로커: KT-305/306/307')).toEqual([
      'KT-305',
      'KT-306',
      'KT-307',
    ]);
  });

  it('parses comma-separated full identifiers', () => {
    expect(parseBlockerIdentifiers('블로커: KT-302, KT-307')).toEqual(['KT-302', 'KT-307']);
  });

  it('parses the English "Blocked by:" label', () => {
    expect(parseBlockerIdentifiers('Blocked by: INT-1809')).toEqual(['INT-1809']);
  });

  it('tolerates markdown bold around the label', () => {
    expect(parseBlockerIdentifiers('**블로커:** KT-305/306')).toEqual(['KT-305', 'KT-306']);
  });

  it('accepts "Depends on" without a colon', () => {
    expect(parseBlockerIdentifiers('Depends on KT-42')).toEqual(['KT-42']);
  });

  it('only reads the blocker line, not surrounding prose', () => {
    const desc = 'Some intro about issue 999.\n블로커: KT-100\nMore notes mentioning 12345.';
    expect(parseBlockerIdentifiers(desc)).toEqual(['KT-100']);
  });

  it('mixes teams and dedupes', () => {
    expect(parseBlockerIdentifiers('블로커: KT-305, INT-1610, KT-305')).toEqual([
      'KT-305',
      'INT-1610',
    ]);
  });

  it('returns empty for missing or blocker-free descriptions', () => {
    expect(parseBlockerIdentifiers(undefined)).toEqual([]);
    expect(parseBlockerIdentifiers('No dependencies here.')).toEqual([]);
    expect(parseBlockerIdentifiers('블로커: 없음')).toEqual([]);
  });
});
