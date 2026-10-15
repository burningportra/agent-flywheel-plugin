export function markdownFenceFor(content: string): string {
  const longestRun = (content.match(/`+/g) ?? [])
    .reduce((longest, run) => Math.max(longest, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}
