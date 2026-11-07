import { call } from './api';
import { type FileEntry, basename, parentPath } from './types';
import { t } from './i18n';
import { ask, button, el, icon, menu, raw, separator, textButton, toast, type MenuItem } from './ui';

export class Explorer {
  name = '';
  selected = '';
  expanded = new Set<string>();
  entries = new Map<string, FileEntry[]>();
  private generation = 0;
  onOpen: (path: string) => Promise<void> = async () => {};
  beforeMutation: (path: string) => Promise<boolean> = async () => true;
  onOpenSide: (path: string) => Promise<void> = async () => {};
  private side = false;
  onChanged: () => void = () => {};
  onEntryMenu: (entry: FileEntry) => MenuItem[] = () => [];
  /** Git status letters by path, used to color names like the VS Code explorer. */
  statuses = new Map<string, string>();
  exclude: RegExp[] = [];
  indent = 15;
  confirmDelete = true;
  private snapshot = '';
  async reset(name: string) { this.name = name; this.selected = ''; this.expanded.clear(); this.entries.clear(); await this.refresh(); }
  async refresh() {
    if (!this.name) return;
    const generation = ++this.generation;
    const values = await Promise.all(['', ...this.expanded].map(async path => [path, await call<FileEntry[]>('list_directory', { path }).catch(error => { if (path === '') throw error; this.expanded.delete(path); return []; })] as const));
    if (generation !== this.generation) return;
    this.entries = new Map(values);
    const snapshot = JSON.stringify(values); if (snapshot !== this.snapshot) { this.snapshot = snapshot; this.render(); }
  }
  /** Comma-separated names; * matches any run of characters. */
  setExclude(value: string) {
    this.exclude = value.split(',').map(glob => glob.trim()).filter(Boolean).map(glob => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));
    this.render();
  }
  collapseAll() { this.expanded.clear(); this.render(); }
  async reveal(path: string) {
    const parts = path.split('/').slice(0, -1);
    for (let index = 1; index <= parts.length; index++) this.expanded.add(parts.slice(0, index).join('/'));
    this.selected = path; this.snapshot = ''; await this.refresh();
    document.querySelector('#explorer-content .tree-row.selected')?.scrollIntoView({ block: 'nearest' });
  }
  render() {
    const host = document.querySelector('#explorer-content')!; host.replaceChildren();
    if (!this.name) { host.append(el('p', 'empty-sidebar', 'Abre una carpeta para explorar sus archivos.')); return; }
    const heading = raw('div', 'tree-root'); heading.append(icon('ChevronDown'), raw('span', '', this.name.toUpperCase())); host.append(heading);
    const append = (path: string, depth: number) => {
      for (const entry of this.entries.get(path) ?? []) {
        if (this.exclude.some(pattern => pattern.test(entry.name))) continue;
        const row = button(entry.path, async () => {
          this.selected = entry.path;
          if (entry.isDir) {
            if (this.expanded.has(entry.path)) this.expanded.delete(entry.path);
            else { this.expanded.add(entry.path); this.entries.set(entry.path, await call<FileEntry[]>('list_directory', { path: entry.path })); }
            this.render();
          } else { this.render(); await (this.side ? this.onOpenSide(entry.path) : this.onOpen(entry.path)); }
        }, undefined, `tree-row ${this.selected === entry.path ? 'selected' : ''}`);
        row.addEventListener('pointerdown', event => { this.side = event.ctrlKey; });
        row.style.paddingLeft = `${12 + depth * this.indent}px`;
        if (entry.isDir) { row.append(icon(this.expanded.has(entry.path) ? 'ChevronDown' : 'ChevronRight'), icon(this.expanded.has(entry.path) ? 'FolderOpen' : 'Folder', 'folder-icon')); row.setAttribute('aria-expanded', String(this.expanded.has(entry.path))); }
        else { row.append(raw('span', 'tree-spacer'), icon('FileCode2', `file-icon ext-${entry.name.split('.').pop()}`)); }
        const status = this.statuses.get(entry.path); row.append(raw('span', `tree-name ${status ? `status-${status}` : ''}`, entry.name)); if (status) row.append(raw('span', `tree-status status-${status}`, status));
        row.addEventListener('contextmenu', event => { event.preventDefault(); this.selected = entry.path; menu({ x: event.clientX, y: event.clientY }, [
          ...(entry.isDir ? [{ label: 'Nuevo archivo aquí…', action: () => this.create(false, entry.path) }, { label: 'Nueva carpeta aquí…', action: () => this.create(true, entry.path) }] : [{ label: 'Abrir archivo', action: () => this.onOpen(entry.path) }, { label: 'Abrir a un lado', action: () => this.onOpenSide(entry.path) }]),
          { label: 'Copiar ruta relativa', action: () => navigator.clipboard.writeText(entry.path) },
          ...this.onEntryMenu(entry), separator,
          { label: 'Renombrar…', action: () => this.rename(entry) },
          { label: 'Mover a la papelera…', action: () => this.trash(entry), danger: true },
        ]); });
        host.append(row); if (entry.isDir && this.expanded.has(entry.path)) append(entry.path, depth + 1);
      }
    };
    append('', 0);
    if (!this.entries.get('')?.length) host.append(el('p', 'empty-sidebar', 'Esta carpeta está vacía. Crea tu primer archivo con +.'));
  }
  async create(directory: boolean, parent?: string) {
    if (!this.name) return;
    const selectedIsDir = [...this.entries.values()].flat().find(e => e.path === this.selected)?.isDir;
    const base = parent ?? (selectedIsDir ? this.selected : parentPath(this.selected));
    const path = await ask({ title: directory ? 'Nueva carpeta' : 'Nuevo archivo', value: base ? `${base}/` : '', placeholder: directory ? 'nombre-carpeta' : 'archivo.rs' });
    if (!path?.trim()) return;
    await call('create_entry', { path: path.trim(), directory });
    if (base) this.expanded.add(base); await this.refresh(); this.onChanged();
    if (!directory) await this.onOpen(path.trim());
  }
  /** Saves a copy of an open file under a new path and opens it. */
  async saveAs(path: string, content: string) {
    const to = await ask({ title: 'Guardar como', value: path });
    if (!to?.trim() || to === path) return;
    await call('create_entry', { path: to.trim(), directory: false });
    await call('save_file', { path: to.trim(), content, expected: '' });
    await this.refresh(); this.onChanged(); await this.onOpen(to.trim());
  }
  async rename(entry: FileEntry) {
    const to = await ask({ title: `Renombrar ${basename(entry.path)}`, value: entry.path });
    if (!to?.trim() || to === entry.path || !await this.beforeMutation(entry.path)) return;
    await call('rename_entry', { from: entry.path, to: to.trim() });
    this.expanded.delete(entry.path); await this.refresh(); this.onChanged();
    if (!entry.isDir) await this.onOpen(to.trim());
  }
  async trash(entry: FileEntry) {
    if (this.confirmDelete && !await ask({ title: `¿Mover ${entry.name} a la papelera?`, detail: entry.isDir ? 'Se moverán la carpeta y su contenido. Puedes recuperarlos desde la papelera del sistema.' : 'Puedes recuperar el archivo desde la papelera del sistema.', input: false, confirm: 'Mover a la papelera', danger: true })) return;
    if (!await this.beforeMutation(entry.path)) return;
    await call('trash_entry', { path: entry.path }); this.expanded.delete(entry.path); await this.refresh(); this.onChanged();
  }
}

export class SearchPanel {
  query = ''; replacement = ''; include = ''; caseSensitive = false; regex = false; wholeWord = false; delay = 250;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  onOpen: (path: string, line: number, column: number) => Promise<void> = async () => {};
  /** Saves open tabs first and reloads them afterwards so replacing never clobbers an edit. */
  beforeReplace: () => Promise<void> = async () => {};
  afterReplace: () => Promise<void> = async () => {};
  private get request() { return { query: this.query, caseSensitive: this.caseSensitive, regex: this.regex, wholeWord: this.wholeWord, include: this.include }; }
  mount() {
    const host = document.querySelector('#search-content')!; host.replaceChildren();
    const field = raw('div', 'search-field'); const input = raw('input'); input.placeholder = t('Buscar en archivos'); input.setAttribute('aria-label', input.placeholder); input.value = this.query;
    const toggle = (label: string, title: string, get: () => boolean, set: (value: boolean) => void) => { const node = button(title, () => { set(!get()); node.classList.toggle('toggled', get()); void this.search(); }, undefined, 'search-toggle'); node.append(raw('span', '', label)); node.classList.toggle('toggled', get()); return node; };
    field.append(input, toggle('Aa', 'Distinguir mayúsculas', () => this.caseSensitive, v => this.caseSensitive = v), toggle('ab', 'Palabra completa', () => this.wholeWord, v => this.wholeWord = v), toggle('.*', 'Expresión regular', () => this.regex, v => this.regex = v));
    const replaceField = raw('div', 'search-field'); const replacement = raw('input'); replacement.placeholder = t('Reemplazar'); replacement.setAttribute('aria-label', replacement.placeholder); replacement.value = this.replacement; replacement.addEventListener('input', () => this.replacement = replacement.value);
    replaceField.append(replacement, button('Reemplazar todo', () => this.replaceAll(), 'ReplaceAll', 'search-toggle'));
    const include = raw('input', 'search-include'); include.placeholder = t('Archivos a incluir (*.ts, src/**, !*.test.ts)'); include.setAttribute('aria-label', include.placeholder); include.value = this.include;
    host.append(field, replaceField, include, el('p', 'search-summary muted', 'Busca texto en la carpeta abierta.'), raw('div', 'search-results'));
    const schedule = () => { clearTimeout(this.timer); this.timer = setTimeout(() => void this.search(), this.delay); };
    input.addEventListener('input', () => { this.query = input.value; schedule(); });
    include.addEventListener('input', () => { this.include = include.value; schedule(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') void this.search(); });
  }
  focus(text?: string) { const input = document.querySelector('#search-content input') as HTMLInputElement | null; if (!input) return; if (text) { input.value = this.query = text; void this.search(); } input.focus(); input.select(); }
  focusReplace() { (document.querySelectorAll('#search-content input')[1] as HTMLInputElement | undefined)?.focus(); }
  async search() {
    const sequence = ++this.sequence; const host = document.querySelector('.search-results')!; const summary = document.querySelector('.search-summary')!;
    if (!this.query) { host.replaceChildren(); summary.textContent = t('Busca texto en la carpeta abierta.'); return; }
    summary.textContent = t('Buscando…');
    try {
      const result = await call<import('./types').SearchResults>('search_files', { query: this.request });
      if (sequence !== this.sequence) return;
      host.replaceChildren(); summary.textContent = `${t(`${result.matches.length}${result.truncated ? '+' : ''} resultados`)}${result.truncated ? ` · ${t('afina la búsqueda')}` : ''}`;
      let last = '';
      for (const match of result.matches) {
        if (last !== match.path) { last = match.path; const group = raw('div', 'search-group'); group.append(icon('FileCode2'), raw('span', '', match.path)); host.append(group); }
        const row = button(`${match.path}:${match.line}`, () => this.onOpen(match.path, match.line, match.column), undefined, 'search-result'); row.append(raw('span', 'line-number', String(match.line)), raw('span', '', match.text.trim())); host.append(row);
      }
    } catch (error) { if (sequence === this.sequence) { summary.textContent = String(error); host.replaceChildren(); } }
  }
  async replaceAll() {
    if (!this.query) return;
    if (!await ask({ title: '¿Reemplazar en todos los archivos?', detail: `«${this.query}» → «${this.replacement}»`, input: false, confirm: 'Reemplazar todo', danger: true })) return;
    await this.beforeReplace();
    const count = await call<number>('replace_files', { query: this.request, replacement: this.replacement });
    await this.afterReplace(); toast(`${count} reemplazos`); await this.search();
  }
}
