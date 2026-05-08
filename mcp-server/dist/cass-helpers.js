import { execFileSync } from 'node:child_process';
function scoreBucket(score) {
    if (score < 500)
        return 'score-0-499';
    if (score < 700)
        return 'score-500-699';
    if (score < 850)
        return 'score-700-849';
    return 'score-850-1000';
}
export function storeComplianceScore(cwd, record) {
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
//# sourceMappingURL=cass-helpers.js.map