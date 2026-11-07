import { call } from './api';
import { basename, isStaged, isUnstaged, type Branch, type Change, type Commit, type CommitFile, type Diff, type GitStatus } from './types';
import { ask, button, el, icon, menu, quickPick, raw, report, separator, textButton, toast, type MenuItem } from './ui';

const LANE = 12, ROW = 40, COLORS = ['#8ce8c2', '#c2a0ed', '#e5bc8d', '#7cc4f0', '#f09a9a', '#d8d48a'];
/** Assigns each commit to a lane and returns one SVG per row, drawing edges in and out of it. */
function graph(commits: Commit[]) {
  let lanes: (string | null)[] = [];
  const free = () => { const index = lanes.indexOf(null); return index < 0 ? lanes.length : index; };
  return commits.map(commit => {
    let lane = lanes.indexOf(commit.hash); if (lane < 0) { lane = free(); lanes[lane] = commit.hash; }
    const above = [...lanes];
    const joining = lanes.flatMap((hash, index) => hash === commit.hash && index !== lane ? [index] : []);
    joining.forEach(index => { lanes[index] = null; });
    lanes[lane] = commit.parents[0] ?? null;
    const opening: number[] = [];
    for (const parent of commit.parents.slice(1)) { let index = lanes.indexOf(parent); if (index < 0) { index = free(); lanes[index] = parent; opening.push(index); } else opening.push(index); }
    const below = [...lanes];
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const x = (index: number) => LANE / 2 + index * LANE; const middle = ROW / 2;
    const width = Math.max(above.length, below.length, 1) * LANE;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(ROW)); svg.classList.add('graph');
    const line = (x1: number, y1: number, x2: number, y2: number, index: number) => { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`); path.setAttribute('stroke', COLORS[index % COLORS.length]); path.setAttribute('fill', 'none'); path.setAttribute('stroke-width', '1.5'); svg.append(path); };
    above.forEach((hash, index) => { if (hash) line(x(index), 0, joining.includes(index) || index === lane ? x(lane) : x(index), middle, index); });
    below.forEach((hash, index) => { if (hash) line(opening.includes(index) ? x(lane) : x(index), middle, x(index), ROW, index); });
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.setAttribute('cx', String(x(lane))); dot.setAttribute('cy', String(middle)); dot.setAttribute('r', '3.5'); dot.setAttribute('fill', COLORS[lane % COLORS.length]); svg.append(dot);
    return svg;
  });
}

export class GitPanel {
  status: GitStatus | null = null;
  enabled = false;
  error = '';
  busy = false;
  commitMessage = '';
  view: 'changes' | 'history' | 'branches' = 'changes';
  smartCommit = 'prompt';
  pullMode = 'pull';
  private refreshing = false;
  private revision = 0;
  onDiff: (diff: Diff, path: string) => void = () => {};
  onOpen: (path: string) => Promise<void> = async () => {};
  onUpdate: () => void = () => {};
  onOutput: (text: string) => void = () => {};
  /** Runs after any operation that can rewrite working tree files. */
  onChanged: () => void = () => {};
  async refresh(force = false) {
    if (!this.enabled || this.refreshing) return;
    this.refreshing = true; const revision = this.revision;
    try {
      const status = await call<GitStatus>('git_status');
      if (revision !== this.revision) return;
      const changed = JSON.stringify(status) !== JSON.stringify(this.status) || this.error;
      this.status = status; this.error = ''; if ((changed || force) && this.view === 'changes') this.render(); this.onUpdate();
    } catch (error) { if (revision === this.revision) { const changed = this.error !== String(error); this.status = null; this.error = String(error); if (changed || force) this.render(); this.onUpdate(); } }
    finally { this.refreshing = false; }
  }
  reset() { this.revision++; this.status = null; this.error = ''; this.commitMessage = ''; this.view = 'changes'; this.render(); }
  async action(action: string, value = '', paths: string[] = []) {
    if (this.busy) return;
    this.busy = true; document.querySelector('#git-content')!.classList.add('busy');
    try {
      const result = await call<string>('git_action', { action, value, paths });
      this.onOutput(`git ${action}\n${result || 'Operación completada.'}`); toast(action.startsWith('commit') ? 'Commit creado' : 'Git actualizado');
      if (action.startsWith('commit')) this.commitMessage = '';
    } catch (error) { this.onOutput(`git ${action}\n${String(error)}`); throw error; }
    finally { this.busy = false; document.querySelector('#git-content')!.classList.remove('busy'); await this.refresh(true); if (this.view !== 'changes') await this.show(this.view); this.onChanged(); }
  }
  async show(view: typeof this.view) { this.view = view; if (view === 'changes') this.render(); else if (view === 'history') await this.history(); else await this.branches(); }
  header(host: Element) {
    const tabs = raw('div', 'scm-tabs');
    for (const [id, title] of [['changes', 'Cambios'], ['history', 'Historial'], ['branches', 'Ramas']] as const) tabs.append(textButton(title, () => this.show(id), undefined, this.view === id ? 'active' : ''));
    host.append(tabs);
  }
  render() {
    const host = document.querySelector('#git-content')!; host.replaceChildren(); this.header(host);
    if (!this.status) {
      const empty = raw('div', 'empty-sidebar'); empty.append(icon('GitFork'), el('h3', '', this.enabled ? 'Sin repositorio' : 'Tu código, versionado.'), el('p', '', this.error && !this.error.includes('not a git repository') ? this.error : this.enabled ? 'Esta carpeta no es un repositorio Git.' : 'Abre una carpeta para trabajar con Git.'));
      if (this.enabled && !this.error.includes('raíz del repositorio')) empty.append(textButton('Inicializar repositorio', () => this.action('init'), 'Plus', 'secondary wide'));
      host.append(empty); return;
    }
    const status = this.status;
    const branch = textButton(status.branch, () => this.pickBranch(), 'GitBranch', 'branch-summary'); branch.append(raw('span', 'muted', `↑${status.ahead} ↓${status.behind}`)); host.append(branch);
    if (status.merging || status.rebasing || status.cherryPicking) {
      const operation = status.rebasing ? 'rebase' : status.cherryPicking ? 'cherry-pick' : 'merge';
      const banner = raw('div', 'conflict-banner'); banner.append(el('strong', '', status.rebasing ? 'Rebase en curso' : status.cherryPicking ? 'Cherry-pick en curso' : 'Merge en curso'), el('p', '', 'Resuelve los marcadores del editor y prepara los archivos.'));
      banner.append(textButton('Continuar', () => this.action(`${operation}-continue`), 'Check'));
      banner.append(textButton('Abortar operación…', async () => { if (await ask({ title: '¿Abortar la operación Git?', detail: 'Git restaurará el estado anterior al merge o rebase.', input: false, confirm: 'Abortar' })) await this.action(`${operation}-abort`); }, 'Undo2'));
      host.append(banner);
    }
    const composer = raw('div', 'commit-composer'); const input = raw('textarea'); input.placeholder = el('span', '', 'Mensaje del commit').textContent ?? ''; input.setAttribute('aria-label', input.placeholder); input.value = this.commitMessage; input.rows = 3; input.addEventListener('input', () => this.commitMessage = input.value);
    input.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void this.commit().catch(report); } });
    const commitRow = raw('div', 'commit-row'); const more = button('Más opciones de commit', () => menu(more, this.commitMenu()), 'ChevronDown', 'primary');
    commitRow.append(textButton('Crear commit', () => this.commit(), 'Check', 'primary wide'), more); composer.append(input, commitRow); host.append(composer);
    const sync = raw('div', 'git-sync'); sync.append(textButton('Fetch', () => this.action('fetch'), 'RefreshCw'), textButton('Pull', () => this.action(this.pullMode), 'ArrowDown'), textButton('Push', () => this.action('push'), 'ArrowUp'), textButton('Sync', () => this.sync(), 'RefreshCw')); host.append(sync);
    const conflicts = status.changes.filter(c => c.conflict);
    if (conflicts.length) this.group(host, 'Conflictos', conflicts, false, true);
    const staged = status.changes.filter(isStaged), unstaged = status.changes.filter(c => !c.conflict && isUnstaged(c));
    if (staged.length) this.group(host, 'Preparados', staged, true);
    this.group(host, 'Cambios', unstaged, false);
    if (!status.changes.length) { const clean = raw('div', 'clean-state'); clean.append(icon('Check'), el('strong', '', 'Todo al día'), el('p', '', 'No hay cambios locales.')); host.append(clean); }
    host.append(raw('p', 'sidebar-note', status.upstream ? el('span', '', `Seguimiento: ${status.upstream}`).textContent ?? '' : el('span', '', 'Sin rama remota de seguimiento. Push publica en origin.').textContent ?? ''));
  }
  private commitMenu(): MenuItem[] { return [
    { label: 'Crear commit', action: () => this.commit() },
    { label: 'Commit de todo', action: () => this.commit('commit-all') },
    { label: 'Modificar último commit (amend)', action: () => this.action('commit-amend', this.commitMessage.trim()) },
    separator,
    { label: 'Commit y push', action: async () => { await this.commit(); await this.action('push'); } },
    { label: 'Commit y sync', action: async () => { await this.commit(); await this.sync(); } },
  ]; }
  async sync() { await this.action(this.pullMode); await this.action('push'); }
  group(host: Element, title: string, changes: Change[], staged: boolean, conflict = false) {
    const header = raw('div', 'section-heading'); header.append(el('span', '', title), raw('span', 'count', String(changes.length)));
    const paths = (items: Change[]) => [...new Set(items.flatMap(c => c.oldPath ? [c.path, c.oldPath] : [c.path]))];
    if (changes.length && !conflict) {
      if (!staged) header.append(button('Descartar todos los cambios', () => this.discard(changes), 'Undo2'));
      header.append(button(staged ? 'Quitar todos de preparados' : 'Preparar todos', () => this.action(staged ? 'unstage' : 'stage', '', paths(changes)), staged ? 'Minus' : 'Plus'));
    }
    host.append(header);
    for (const change of changes) {
      const row = raw('div', 'change-row');
      const open = button(change.path, async () => { if (conflict) await this.onOpen(change.path); else this.onDiff(await call<Diff>('git_diff', { path: change.path, staged, oldPath: change.oldPath }), change.path); }, undefined, 'change-name');
      open.append(icon(conflict ? 'GitCompareArrows' : 'FileCode2'), raw('span', '', basename(change.path)), raw('small', '', change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''));
      row.append(open, raw('span', `git-status status-${conflict ? 'U' : staged ? change.index : change.worktree === '?' ? 'A' : change.worktree}`, conflict ? '!' : staged ? change.index : change.worktree === '?' ? 'U' : change.worktree));
      if (change.worktree !== 'D') row.append(button('Abrir archivo para editar', () => this.onOpen(change.path), 'FileCode2', 'row-action'));
      if (!staged && !conflict) row.append(button('Descartar cambios', () => this.discard([change]), 'Undo2', 'row-action'));
      row.append(button(staged ? 'Quitar de preparados' : conflict ? 'Marcar como resuelto' : 'Preparar archivo', () => this.action(staged ? 'unstage' : 'stage', '', paths([change])), staged ? 'Minus' : 'Plus', 'row-action')); host.append(row);
    }
  }
  async discard(changes: Change[]) {
    const untracked = changes.filter(c => c.index === '?').map(c => c.path), tracked = changes.filter(c => c.index !== '?').map(c => c.path);
    const name = changes.length === 1 ? basename(changes[0].path) : `${changes.length} archivos`;
    if (!await ask({ title: `¿Descartar cambios en ${name}?`, detail: 'Los cambios sin confirmar se perderán de forma permanente. Los archivos nuevos irán a la papelera.', input: false, confirm: 'Descartar', danger: true })) return;
    if (tracked.length) await this.action('discard', '', tracked);
    if (untracked.length) await this.action('clean', '', untracked);
  }
  async commit(action = 'commit') {
    if (!this.commitMessage.trim()) { toast('Escribe un mensaje de commit', true); return; }
    if (action === 'commit' && !this.status?.changes.some(isStaged) && !this.status?.merging) {
      if (!this.status?.changes.length) { toast('No hay cambios para el commit', true); return; }
      if (this.smartCommit === 'never') { toast('Prepara los archivos con + antes de crear el commit', true); return; }
      if (this.smartCommit === 'prompt' && !await ask({ title: '¿Preparar todos los cambios?', detail: 'No hay archivos preparados. Se incluirán todos los cambios en el commit.', input: false, confirm: 'Crear commit' })) return;
      action = 'commit-all';
    }
    await this.action(action, this.commitMessage.trim());
  }
  async history(path: string | null = null) {
    this.view = 'history';
    const host = document.querySelector('#git-content')!; host.replaceChildren(); this.header(host);
    if (!this.enabled) return;
    const loading = el('p', 'empty-sidebar', 'Cargando historial…'); host.append(loading);
    try {
      const commits = await call<Commit[]>('git_log', { path }); if (this.view !== 'history') return; loading.remove();
      if (path) host.append(raw('p', 'sidebar-note', el('span', '', `Historial: ${path}`).textContent ?? ''));
      if (!commits.length) host.append(el('p', 'empty-sidebar', 'Todavía no hay commits.'));
      const rails = graph(commits);
      commits.forEach((commit, index) => {
        const row = button(`${commit.short}: ${commit.subject}`, () => this.toggleCommit(row, commit), undefined, 'history-row');
        const body = raw('div', 'history-body'); body.append(raw('strong', '', commit.subject), raw('small', '', `${commit.short} · ${commit.author} · ${commit.date}`));
        row.append(rails[index], body); if (commit.refs) row.append(raw('span', 'ref-badge', commit.refs.split(', ')[0].replace('HEAD -> ', '')));
        row.addEventListener('contextmenu', e => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, this.commitActions(commit)); });
        host.append(row);
      });
    } catch (error) { loading.textContent = String(error); }
  }
  private async toggleCommit(row: HTMLElement, commit: Commit) {
    if (row.nextElementSibling?.classList.contains('commit-files')) { row.nextElementSibling.remove(); return; }
    const files = await call<CommitFile[]>('git_commit_files', { hash: commit.hash });
    const list = raw('div', 'commit-files');
    for (const file of files) { const item = button(file.path, async () => this.onDiff(await call<Diff>('git_commit_diff', { hash: commit.hash, path: file.path }), file.path), undefined, 'commit-file'); item.append(raw('span', `git-status status-${file.status[0]}`, file.status[0]), raw('span', '', file.path)); list.append(item); }
    row.after(list);
  }
  private commitActions(commit: Commit): MenuItem[] {
    const reset = (mode: string, title: string, detail: string, danger = false) => ({ label: title, danger, action: async () => { if (await ask({ title: `${title} ${commit.short}?`, detail, input: false, confirm: 'Reset', danger })) await this.action(`reset-${mode}`, commit.hash); } });
    return [
      { label: 'Copiar hash', action: () => navigator.clipboard.writeText(commit.hash) },
      { label: 'Cambiar a este commit', action: () => this.action('checkout-detached', commit.hash) },
      { label: 'Crear rama aquí…', action: async () => { const name = await ask({ title: 'Nombre de la nueva rama' }); if (name?.trim()) await this.action('branch-from', `${name.trim()}\n${commit.hash}`); } },
      { label: 'Crear etiqueta aquí…', action: async () => { const name = await ask({ title: 'Nombre de la etiqueta' }); if (name?.trim()) await this.action('tag-at', `${name.trim()}\n${commit.hash}`); } },
      separator,
      { label: 'Cherry-pick', action: () => this.action('cherry-pick', commit.hash) },
      { label: 'Revertir commit', action: () => this.action('revert', commit.hash) },
      separator,
      reset('soft', 'Reset suave', 'Mueve la rama aquí y conserva los cambios preparados.'),
      reset('mixed', 'Reset mixto', 'Mueve la rama aquí y conserva los cambios sin preparar.'),
      reset('hard', 'Reset duro', 'Mueve la rama aquí y elimina todos los cambios locales de forma permanente.', true),
    ];
  }
  private section(host: Element, title: string, count: number) { const heading = raw('div', 'section-heading'); heading.append(el('span', '', title), raw('span', 'count', String(count))); host.append(heading); return heading; }
  private item(host: Element, label: string, glyph: 'GitBranch' | 'Tag' | 'Archive' | 'Globe', click: () => unknown, items: MenuItem[], className = '') {
    const row = button(label, click, glyph, `branch-row ${className}`); row.append(raw('span', '', label));
    row.addEventListener('contextmenu', e => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, items); }); host.append(row); return row;
  }
  async branches() {
    const host = document.querySelector('#git-content')!; host.replaceChildren(); this.header(host);
    host.append(textButton('Crear rama…', () => this.promptAction('branch', 'Nombre de la nueva rama'), 'Plus', 'secondary create-branch'));
    if (!this.enabled) return;
    try {
      const [branches, tags, stashes, remotes] = await Promise.all([call<Branch[]>('git_branches'), call<string[]>('git_list', { kind: 'tags' }), call<string[]>('git_list', { kind: 'stashes' }), call<string[]>('git_list', { kind: 'remotes' })]);
      if (this.view !== 'branches') return;
      for (const remote of [false, true]) {
        const list = branches.filter(b => b.remote === remote); this.section(host, remote ? 'Remotas' : 'Locales', list.length);
        for (const branch of list) {
          const actions: MenuItem[] = [{ label: 'Fusionar en la rama actual', action: () => this.action('merge', branch.name) }, { label: 'Rebase de la rama actual sobre esta', action: () => this.action('rebase', branch.name) }];
          if (!remote) actions.push(separator, { label: 'Renombrar…', action: async () => { const name = await ask({ title: `Renombrar ${branch.name}`, value: branch.name }); if (name?.trim()) await this.action('branch-rename', `${branch.name}\n${name.trim()}`); } }, { label: 'Eliminar rama…', danger: true, action: async () => { const choice = await ask({ title: `¿Eliminar ${branch.name}?`, detail: 'La opción forzada elimina también commits sin fusionar.', choices: [{ label: 'Eliminar', value: 'branch-delete' }, { label: 'Forzar', value: 'branch-delete-force', danger: true }] }); if (choice) await this.action(choice, branch.name); } });
          this.item(host, branch.name, 'GitBranch', () => this.checkout(branch), actions, branch.current ? 'current' : '');
        }
      }
      this.section(host, 'Etiquetas', tags.length).append(button('Enviar etiquetas', () => this.action('push-tags'), 'ArrowUp'));
      for (const tag of tags) this.item(host, tag, 'Tag', () => this.action('checkout-detached', tag), [{ label: 'Cambiar a esta etiqueta', action: () => this.action('checkout-detached', tag) }, { label: 'Eliminar etiqueta', danger: true, action: () => this.action('tag-delete', tag) }]);
      this.section(host, 'Stashes', stashes.length).append(button('Guardar cambios en stash…', () => this.promptAction('stash', 'Nombre del stash', 'Incluye archivos nuevos sin seguimiento.'), 'Plus'));
      for (const line of stashes) {
        const [id, ...rest] = line.split('\t');
        this.item(host, rest.join(' '), 'Archive', () => this.action('stash-apply', id), [{ label: 'Aplicar', action: () => this.action('stash-apply', id) }, { label: 'Aplicar y eliminar (pop)', action: () => this.action('stash-pop', id) }, { label: 'Eliminar stash', danger: true, action: async () => { if (await ask({ title: '¿Eliminar este stash?', detail: 'No se puede deshacer.', input: false, confirm: 'Eliminar', danger: true })) await this.action('stash-drop', id); } }]);
      }
      this.section(host, 'Servidores remotos', remotes.length).append(button('Añadir remoto…', () => this.addRemote(), 'Plus'));
      for (const remote of remotes) this.item(host, remote, 'Globe', () => this.action('fetch'), [{ label: 'Eliminar remoto', danger: true, action: () => this.action('remote-remove', remote) }]);
    } catch (error) { host.append(raw('p', 'empty-sidebar', String(error))); }
  }
  private async checkout(branch: Branch) {
    if (branch.current) return;
    if (!branch.remote) return this.action('checkout', branch.name);
    const local = await ask({ title: 'Crear rama local desde remota', value: branch.name.split('/').slice(1).join('/') });
    if (local) await this.action('track', `${local}\n${branch.name}`);
  }
  async pickBranch(run?: (branch: string) => unknown, placeholder = 'Selecciona una rama') {
    const branches = await call<Branch[]>('git_branches');
    quickPick(placeholder, branches.filter(b => !run || !b.current).map(b => ({ label: b.name, detail: b.current ? '●' : b.remote ? 'remota' : '', run: () => run ? run(b.name) : this.checkout(b) })));
  }
  async promptAction(action: string, title: string, detail?: string) { const value = await ask({ title, detail }); if (value?.trim()) await this.action(action, value.trim()); }
  private async addRemote() { const name = await ask({ title: 'Nombre del remoto', value: 'origin' }); if (!name) return; const url = await ask({ title: 'URL del remoto', placeholder: 'https://… o git@…' }); if (url) await this.action('remote', `${name}\n${url}`); }
  more(anchor: HTMLElement | { x: number; y: number }) { menu(anchor, [
    { label: 'Pull (rebase)', action: () => this.action('pull-rebase') },
    { label: 'Pull (merge)', action: () => this.action('pull-merge') },
    { label: 'Push forzado (with lease)…', danger: true, action: async () => { if (await ask({ title: '¿Hacer push forzado?', detail: 'Reescribe la rama remota si nadie más la actualizó.', input: false, confirm: 'Push forzado', danger: true })) await this.action('push-force'); } },
    separator,
    { label: 'Cambiar de rama…', action: () => this.pickBranch() },
    { label: 'Crear rama…', action: () => this.promptAction('branch', 'Nombre de la nueva rama') },
    { label: 'Fusionar rama (merge)…', action: () => this.pickBranch(branch => this.action('merge', branch), 'Rama que quieres fusionar') },
    { label: 'Rebase sobre rama…', action: () => this.pickBranch(branch => this.action('rebase', branch), 'Rama base del rebase') },
    separator,
    { label: 'Guardar cambios en stash…', action: () => this.promptAction('stash', 'Nombre del stash', 'Incluye archivos nuevos sin seguimiento.') },
    { label: 'Recuperar último stash', action: () => this.action('stash-pop') },
    { label: 'Crear etiqueta…', action: () => this.promptAction('tag', 'Nombre de la etiqueta') },
    { label: 'Añadir remoto…', action: () => this.addRemote() },
  ]); }
}
