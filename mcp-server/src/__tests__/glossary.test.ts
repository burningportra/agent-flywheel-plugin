import { describe, it, expect } from 'vitest';
import { GLOSSARY_LINE } from '../glossary.js';

describe('GLOSSARY_LINE', () => {
  it('is a non-empty string', () => {
    expect(typeof GLOSSARY_LINE).toBe('string');
    expect(GLOSSARY_LINE.length).toBeGreaterThan(0);
  });

  it.each([
    ['bead'],
    ['plan'],
    ['flywheel'],
    ['NTM'],
    ['agent-mail'],
    ['MCP'],
  ])('contains the expected term %s', (term) => {
    expect(GLOSSARY_LINE).toContain(term);
  });

  it("uses '·' middot as the separator (not bullet or dash)", () => {
    expect(GLOSSARY_LINE).toContain(' · ');
    expect(GLOSSARY_LINE).not.toContain(' • ');
    expect(GLOSSARY_LINE).not.toMatch(/ - /);
  });

  it("starts with 'Glossary:' prefix", () => {
    expect(GLOSSARY_LINE.startsWith('Glossary:')).toBe(true);
  });
});
