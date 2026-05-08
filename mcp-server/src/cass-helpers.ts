import { execFileSync } from 'node:child_process';

export interface ComplianceScoreRecord {
  beadId: string;
  score: number;
  threshold: number;
  passed: boolean;
  rubric: Record<string, string>;
  passUtc: string;
  sessionId: string | null;
  gitHead: string;
}

function scoreBucket(score: number): string {
  if (score < 500) return 'score-0-499';
  if (score < 700) return 'score-500-699';
  if (score < 850) return 'score-700-849';
  return 'score-850-1000';
}

export function storeComplianceScore(cwd: string, record: ComplianceScoreRecord): void {
  const tags = ['compliance', 'score', record.beadId, scoreBucket(record.score)];
  const body = JSON.stringify({
    kind: 'compliance_score',
    tags,
    body: record,
  });
  execFileSync('cm', ['add', '--kind', 'compliance_score', '--tags', tags.join(','), '--body', body], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
}
