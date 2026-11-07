export interface Workspace { path: string; name: string }
export interface FileEntry { path: string; name: string; isDir: boolean }
export interface Change { path: string; oldPath: string | null; index: string; worktree: string; conflict: boolean }
export interface GitStatus { branch: string; upstream: string | null; ahead: number; behind: number; changes: Change[]; merging: boolean; rebasing: boolean; cherryPicking: boolean }
export interface Commit { hash: string; short: string; author: string; date: string; subject: string; refs: string; parents: string[] }
export interface CommitFile { status: string; path: string }
export interface Branch { name: string; current: boolean; remote: boolean }
export interface Diff { original: string; modified: string; title: string }
export interface LineChange { start: number; count: number; kind: 'A' | 'M' | 'D' }
export interface Blame { hash: string; author: string; time: number; summary: string }
export interface SearchMatch { path: string; line: number; column: number; text: string }
export interface SearchResults { matches: SearchMatch[]; truncated: boolean }
/** Extensions Monaco would otherwise miss or map badly; everything else comes from its language registry. */
export function language(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ({ toml: 'ini', tsx: 'typescript', jsx: 'javascript', vue: 'html', svelte: 'html', svg: 'xml', h: 'c' } as Record<string, string>)[ext] ?? '';
}
export const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const isStaged = (c: Change) => c.index !== ' ' && c.index !== '?' && !c.conflict;
export const isUnstaged = (c: Change) => c.worktree !== ' ' || c.index === '?' || c.conflict;
export function fuzzy(query: string, value: string): number {
  if (!query) return 1;
  const q = query.toLowerCase(), v = value.toLowerCase();
  let at = 0, score = 0, previous = -2;
  for (const char of q) {
    const found = v.indexOf(char, at);
    if (found < 0) return 0;
    score += found === previous + 1 ? 8 : 1;
    if (found === 0 || '/ -_'.includes(v[found - 1])) score += 5;
    previous = found; at = found + 1;
  }
  return score + 1 / (value.length + 1);
}
