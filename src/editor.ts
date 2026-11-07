import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import { call } from './api';
import { getLocale, t } from './i18n';
import { monacoOptions, resolvedTheme, type Settings } from './settings';
import { basename, language, parentPath, type Blame, type Diff, type LineChange } from './types';
import { ask, button, icon, menu, raw, report, separator, toast, type Icon, type MenuItem } from './ui';

self.MonacoEnvironment = { getWorker: (_: string, label: string) => {
  if (label === 'typescript' || label === 'javascript') return new TsWorker();
  if (label === 'json') return new JsonWorker();
  if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
  if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
  return new EditorWorker();
} };

// Project-wide type checking would need the whole dependency tree; syntax errors and completions stay on.
const ts = monaco.typescript;
for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults.setCompilerOptions({ target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, jsx: ts.JsxEmit.Preserve, allowJs: true, allowNonTsExtensions: true });
}
monaco.editor.defineTheme('lumen', { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '687883', fontStyle: 'italic' }, { token: 'keyword', foreground: 'c2a0ed' }, { token: 'string', foreground: 'a6dba5' }, { token: 'number', foreground: 'e5bc8d' }], colors: { 'editor.background': '#15181d', 'editor.foreground': '#d1d7df', 'editorLineNumber.foreground': '#515b67', 'editorLineNumber.activeForeground': '#a5b3c2', 'editor.lineHighlightBackground': '#1c2027', 'editor.selectionBackground': '#35554f80', 'editorCursor.foreground': '#8ce8c2', 'editorIndentGuide.background1': '#262c34', 'editorWidget.background': '#1c2129', 'editorWidget.border': '#313a45', 'editorGutter.background': '#15181d' } });
monaco.editor.defineTheme('lumen-light', { base: 'vs', inherit: true, rules: [{ token: 'comment', foreground: '6b7a86', fontStyle: 'italic' }], colors: { 'editor.background': '#fbfbfa', 'editor.lineHighlightBackground': '#f0f1ef', 'editorCursor.foreground': '#17795c', 'editor.selectionBackground': '#b5e6d580' } });

function ago(seconds: number) {
  const elapsed = (seconds * 1000 - Date.now()) / 1000; const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]] as const) if (Math.abs(elapsed) >= size) return format.format(Math.round(elapsed / size), unit);
  return format.format(0, 'minute');
}

interface Conflict { start: number; base: number; middle: number; end: number }
function findConflicts(model: monaco.editor.ITextModel): Conflict[] {
  if (!model.findMatches('<<<<<<< ', false, false, true, null, false, 1).length) return [];
  const conflicts: Conflict[] = []; let current: Partial<Conflict> = {};
  for (let line = 1; line <= model.getLineCount(); line++) {
    const text = model.getLineContent(line);
    if (text.startsWith('<<<<<<<')) current = { start: line };
    else if (text.startsWith('|||||||') && current.start) current.base = line;
    else if (text.startsWith('=======') && current.start) current.middle = line;
    else if (text.startsWith('>>>>>>>') && current.start && current.middle) { conflicts.push({ start: current.start, base: current.base ?? current.middle, middle: current.middle, end: line }); current = {}; }
  }
  return conflicts;
}
function resolveConflict(model: monaco.editor.ITextModel, start: number, side: 'current' | 'incoming' | 'both') {
  const conflict = findConflicts(model).find(c => c.start === start); if (!conflict) return;
  const lines = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => model.getLineContent(from + i));
  const keep = [...(side !== 'incoming' ? lines(conflict.start + 1, conflict.base) : []), ...(side !== 'current' ? lines(conflict.middle + 1, conflict.end) : [])];
  const last = conflict.end === model.getLineCount();
  const range = last ? new monaco.Range(conflict.start, 1, conflict.end, model.getLineMaxColumn(conflict.end)) : new monaco.Range(conflict.start, 1, conflict.end + 1, 1);
  model.pushEditOperations([], [{ range, text: last ? keep.join(model.getEOL()) : keep.map(line => line + model.getEOL()).join('') }], () => null);
}
monaco.editor.addCommand({ id: 'lumen.resolveConflict', run: (_, uri: monaco.Uri, start: number, side: 'current' | 'incoming' | 'both') => { const model = monaco.editor.getModel(uri); if (model) resolveConflict(model, start, side); } });
monaco.languages.registerCodeLensProvider('*', { provideCodeLenses: model => ({ dispose() {}, lenses: findConflicts(model).flatMap(conflict => ([['current', 'Aceptar actual'], ['incoming', 'Aceptar entrante'], ['both', 'Aceptar ambos']] as const).map(([side, title]) => ({ range: new monaco.Range(conflict.start, 1, conflict.start, 1), command: { id: 'lumen.resolveConflict', title: t(title), arguments: [model.uri, conflict.start, side] } }))) }) });

interface Document { path: string; model: monaco.editor.ITextModel; disk: string; savedVersion: number; view: monaco.editor.ICodeEditorViewState | null; subscription: monaco.IDisposable; gutter: string[]; conflicts: string[]; blame: string[]; wasDirty: boolean; preview?: HTMLElement; refresh?: () => Promise<void>; title?: string; glyph?: Icon }
export class Editor {
  documents: Document[] = [];
  /** Document in the focused pane; `left` and `right` track what each pane shows. */
  active: Document | null = null;
  private left: Document | null = null;
  private right: Document | null = null;
  private pane: 'left' | 'right' = 'left';
  code: monaco.editor.IStandaloneCodeEditor;
  split: monaco.editor.IStandaloneCodeEditor | null = null;
  diff: monaco.editor.IStandaloneDiffEditor | null = null;
  private diffModels: monaco.editor.ITextModel[] = [];
  private autoSaveTimer?: ReturnType<typeof setTimeout>;
  private blameTimer?: ReturnType<typeof setTimeout>;
  private saving = new Set<string>();
  private diffTitle = '';
  onChange: () => void = () => {};
  onSaved: () => void = () => {};
  onCursor: (line: number, column: number) => void = () => {};
  onTabMenu: (event: MouseEvent, path: string) => void = () => {};
  onBlame: (text: string) => void = () => {};
  constructor(private settings: Settings) {
    this.code = monaco.editor.create(document.querySelector('#code-editor') as HTMLElement, { model: null, automaticLayout: true, ...this.options(), padding: { top: 12, bottom: 12 }, fixedOverflowWidgets: true });
    this.wire(this.code, 'left');
    monaco.editor.registerEditorOpener({ openCodeEditor: (_, resource, selection) => {
      const doc = this.documents.find(d => d.model.uri.toString() === resource.toString()); if (!doc) return false;
      this.activate(doc);
      if (selection) { const position = 'startLineNumber' in selection ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : selection; this.current.setPosition(position); this.current.revealPositionInCenter(position); }
      return true;
    } });
    this.applySettings(settings);
  }
  get current() { return this.split && this.pane === 'right' ? this.split : this.code; }
  private wire(target: monaco.editor.IStandaloneCodeEditor, pane: 'left' | 'right') {
    target.onDidChangeCursorPosition(e => { if (pane !== this.pane) return; this.onCursor(e.position.lineNumber, e.position.column); this.scheduleBlame(); });
    target.onDidFocusEditorText(() => this.focusPane(pane));
  }
  private focusPane(pane: 'left' | 'right') {
    if (pane === this.pane) return;
    this.clearBlame(); this.pane = pane; this.active = pane === 'right' ? this.right : this.left;
    this.renderTabs(); this.onChange(); this.reportCursor(); this.scheduleBlame();
  }
  private reportCursor() { const position = this.current.getPosition(); this.onCursor(position?.lineNumber ?? 1, position?.column ?? 1); }
  options() { return monacoOptions(this.settings); }
  private indentModel(model: monaco.editor.ITextModel) {
    const { tabSize, insertSpaces, detectIndentation } = this.settings;
    model.updateOptions({ tabSize, insertSpaces });
    if (detectIndentation) model.detectIndentation(insertSpaces, tabSize);
  }
  applySettings(settings: Settings) {
    this.settings = settings; monaco.editor.setTheme(resolvedTheme(settings) === 'dark' ? 'lumen' : 'lumen-light');
    this.code.updateOptions(this.options()); this.split?.updateOptions(this.options()); this.diff?.updateOptions(this.options());
    for (const doc of this.documents) if (!doc.preview) this.indentModel(doc.model);
    if (!settings.blame) this.clearBlame();
    this.refreshGutters();
  }
  dirty(doc: Document) { return !doc.preview && doc.model.getAlternativeVersionId() !== doc.savedVersion; }
  private detect(path: string) {
    const known = language(path); if (known) return known;
    const name = basename(path).toLowerCase();
    return monaco.languages.getLanguages().find(l => l.filenames?.some(f => f.toLowerCase() === name) || l.extensions?.some(e => name.endsWith(e.toLowerCase())))?.id ?? 'plaintext';
  }
  private track(doc: Document) {
    doc.subscription = doc.model.onDidChangeContent(() => {
      const dirty = this.dirty(doc); if (dirty !== doc.wasDirty) { doc.wasDirty = dirty; this.renderTabs(); }
      this.onChange(); this.decorateConflicts(doc); this.clearBlame();
      clearTimeout(this.autoSaveTimer);
      if (this.settings.autoSave) this.autoSaveTimer = setTimeout(() => { void this.save(doc).catch(report); }, this.settings.autoSaveDelay);
    });
  }
  private newDocument(path: string, model: monaco.editor.ITextModel, disk: string, extra: Partial<Document> = {}): Document {
    return { path, model, disk, savedVersion: model.getAlternativeVersionId(), view: null, subscription: { dispose() {} }, gutter: [], conflicts: [], blame: [], wasDirty: false, ...extra };
  }
  async open(path: string, line?: number, column = 1) {
    let doc = this.documents.find(d => d.path === path && !d.preview);
    if (!doc) {
      const content = await call<string>('read_file', { path });
      // Opening the same file concurrently must still produce one model.
      doc = this.documents.find(d => d.path === path && !d.preview);
      if (!doc) {
        const model = monaco.editor.createModel(content, this.detect(path), monaco.Uri.file(`/${path}`));
        this.indentModel(model);
        doc = this.newDocument(path, model, content); this.track(doc); this.documents.push(doc);
        this.decorateConflicts(doc); void this.refreshGutter(doc);
      }
    }
    this.activate(doc);
    if (line) { this.current.setPosition({ lineNumber: line, column }); this.current.revealLineInCenter(line); this.current.focus(); }
  }
  async openPreview(path: string, render: (host: HTMLElement) => Promise<void>, title?: string, glyph?: Icon) {
    let doc = this.documents.find(d => d.path === path && d.preview);
    if (!doc) {
      const host = raw('div', 'preview-host');
      doc = this.newDocument(path, monaco.editor.createModel('', 'plaintext', monaco.Uri.parse(`preview:/${encodeURIComponent(path)}`)), '', { preview: host, refresh: () => render(host), title, glyph });
      this.documents.push(doc);
    }
    this.activate(doc);
  }
  activeTitle() { return this.active ? this.active.title ?? basename(this.active.path) : ''; }
  textOf(path: string) { return this.documents.find(d => d.path === path && !d.preview)?.model.getValue(); }
  activate(doc: Document) {
    // A file already visible in the other pane gets focus instead of a second copy.
    const mine = this.pane === 'right' ? this.right : this.left, other = this.pane === 'right' ? this.left : this.right;
    if (this.split && !doc.preview && mine && mine !== doc && other === doc) {
      this.disposeDiff(); this.layout(); (this.pane === 'right' ? this.code : this.split).focus(); this.focusPane(this.pane === 'right' ? 'left' : 'right'); return;
    }
    if (this.active && !this.active.preview && !this.diff) this.active.view = this.current.saveViewState();
    this.disposeDiff(); this.clearBlame();
    if (doc.preview) this.pane = 'left';
    this.active = doc;
    if (doc.preview) { this.left = doc; document.querySelector('#preview-surface')!.replaceChildren(doc.preview); void doc.refresh?.().catch(report); }
    else { if (this.pane === 'right') this.right = doc; else this.left = doc; this.current.setModel(doc.model); this.current.restoreViewState(doc.view); }
    this.layout(); if (!doc.preview) this.current.focus();
    this.renderTabs(); this.onChange(); this.reportCursor(); this.scheduleBlame();
  }
  private layout() {
    const q = (id: string) => document.querySelector(id)!;
    const preview = !this.diff && !!this.left?.preview;
    q('#diff-editor').classList.toggle('hidden', !this.diff);
    q('#left-pane').classList.toggle('hidden', !!this.diff);
    q('#right-pane').classList.toggle('hidden', !!this.diff || !this.split);
    q('#pane-sash').classList.toggle('hidden', !!this.diff || !this.split);
    q('#preview-surface').classList.toggle('hidden', !preview);
    q('#code-editor').classList.toggle('hidden', preview);
    document.documentElement.classList.toggle('is-split', !!this.split);
    const empty = !this.active && !this.left && !this.diff;
    q('#welcome').classList.toggle('hidden', !empty); q('#editor-surface').classList.toggle('hidden', empty);
  }
  /** Tab text: the file name, plus its folder only when another open file shares that name. */
  private twinFolder(path: string, title?: string) {
    if (title) return '';
    const name = basename(path); const twin = this.documents.some(d => !d.title && d.path !== path && basename(d.path) === name);
    return twin ? parentPath(path) || './' : '';
  }
  private paintPanes() {
    for (const [id, doc, pane] of [['#left-pane', this.left, 'left'], ['#right-pane', this.right, 'right']] as const) {
      const host = document.querySelector(id)!; host.classList.toggle('focused', !!this.split && pane === this.pane);
      const title = host.querySelector('.pane-title')!; title.replaceChildren();
      if (!doc) continue;
      title.append(raw('span', '', doc.title ?? basename(doc.path)));
      const folder = this.twinFolder(doc.path, doc.title); if (folder) title.append(raw('small', '', folder));
      if (this.dirty(doc)) title.append(icon('Circle', 'pane-dirty'));
      if (pane === 'right') title.append(button('Cerrar panel dividido', () => this.closeSplit(), 'X', 'pane-close'));
    }
  }
  renderTabs() {
    const host = document.querySelector('#tabs')!; host.replaceChildren();
    for (const doc of this.documents) {
      const active = doc === this.active && !this.diff; const dirty = this.dirty(doc);
      const shown = !!this.split && !this.diff && (doc === this.left || doc === this.right);
      const tab = raw('div', `editor-tab ${active ? 'active' : shown ? 'shown' : ''}`); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(active));
      const name = button(doc.title ?? doc.path, () => this.activate(doc), doc.glyph ?? (doc.preview ? 'Eye' : 'FileCode2'), 'tab-name'); name.append(raw('span', '', doc.title ?? basename(doc.path)));
      const folder = this.twinFolder(doc.path, doc.title); if (folder) name.append(raw('small', '', folder));
      const close = button(dirty ? 'Cerrar archivo con cambios' : 'Cerrar archivo', () => this.close(doc), dirty ? 'Circle' : 'X', `tab-close ${dirty ? 'dirty' : ''}`);
      tab.addEventListener('auxclick', e => { if (e.button === 1) void this.close(doc).catch(report); });
      tab.addEventListener('contextmenu', e => { e.preventDefault(); this.onTabMenu(e, doc.path); });
      tab.append(name, close); host.append(tab);
    }
    if (this.diff) { const tab = raw('div', 'editor-tab active diff-tab'); tab.title = this.diffTitle; tab.append(icon('GitCompareArrows'), raw('span', '', this.diffTitle), button('Cerrar diferencias', () => this.closeDiff(), 'X')); host.append(tab); }
    host.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.paintPanes();
    const breadcrumbs = document.querySelector('#breadcrumbs')!; breadcrumbs.replaceChildren();
    if (this.active && !this.active.title) this.active.path.split('/').forEach((part, index) => { if (index) breadcrumbs.append(icon('ChevronRight')); breadcrumbs.append(raw('span', '', part)); });
  }
  private async beforeSave(doc: Document) {
    if (this.settings.formatOnSave) await this.current.getAction('editor.action.formatDocument')?.run().catch(() => {});
    if (this.settings.trimTrailingWhitespace) await this.current.getAction('editor.action.trimTrailingWhitespace')?.run();
    if (this.settings.insertFinalNewline) {
      const last = doc.model.getLineCount();
      if (doc.model.getLineLength(last)) { const column = doc.model.getLineMaxColumn(last); doc.model.pushEditOperations([], [{ range: new monaco.Range(last, column, last, column), text: doc.model.getEOL() }], () => null); }
    }
  }
  async save(doc = this.active) {
    if (!doc || doc.preview || this.saving.has(doc.path) || !this.dirty(doc)) return;
    this.saving.add(doc.path);
    try {
      if (doc === this.active && !this.diff) await this.beforeSave(doc);
      const content = doc.model.getValue(); const version = doc.model.getAlternativeVersionId();
      try { await call('save_file', { path: doc.path, content, expected: doc.disk }); }
      catch (error) { if (!String(error).startsWith('CONFLICT')) throw error; this.saving.delete(doc.path); return await this.saveConflict(doc); }
      doc.disk = content; doc.savedVersion = version; doc.wasDirty = this.dirty(doc); this.renderTabs(); this.onChange(); this.onSaved(); void this.refreshGutter(doc); if (doc === this.active) this.scheduleBlame();
    } finally { this.saving.delete(doc.path); }
  }
  private async saveConflict(doc: Document) {
    const disk = await call<string>('read_file', { path: doc.path });
    const choice = await ask({ title: 'El archivo cambió en disco', detail: 'Otro programa modificó este archivo después de abrirlo.', choices: [{ label: 'Comparar', value: 'compare' }, { label: 'Usar versión del disco', value: 'reload' }, { label: 'Sobrescribir', value: 'overwrite', danger: true }] });
    if (choice === 'overwrite') { doc.disk = disk; await this.save(doc); }
    else if (choice === 'reload') { this.replaceContent(doc, disk); this.renderTabs(); this.onChange(); }
    else if (choice === 'compare') this.showDiff({ title: `${basename(doc.path)} · disco ↔ editor`, original: disk, modified: doc.model.getValue() }, doc.path);
  }
  private replaceContent(doc: Document, content: string) { doc.disk = content; doc.model.setValue(content); doc.savedVersion = doc.model.getAlternativeVersionId(); doc.wasDirty = false; this.renderTabs(); void this.refreshGutter(doc); }
  async saveAll() { for (const doc of this.documents) await this.save(doc); }
  /** Follows files changed outside the editor; tabs with unsaved edits are left for the save conflict flow. */
  async syncDisk() {
    await Promise.all(this.documents.filter(d => !d.preview).map(async doc => {
      const content = await call<string>('read_file', { path: doc.path }).catch(() => null);
      if (content !== null && content !== doc.disk && !this.dirty(doc) && !doc.model.isDisposed()) this.replaceContent(doc, content);
    }));
  }
  async reload() {
    const doc = this.active; if (!doc || doc.preview) return;
    if (this.dirty(doc) && !await ask({ title: '¿Recargar el archivo?', detail: 'Se perderán los cambios sin guardar de esta pestaña.', input: false, confirm: 'Recargar' })) return;
    this.replaceContent(doc, await call<string>('read_file', { path: doc.path })); this.renderTabs(); this.onChange();
  }
  async close(doc = this.active): Promise<boolean> {
    if (!doc) return true;
    if (this.dirty(doc)) {
      const result = await ask({ title: `¿Cerrar ${basename(doc.path)}?`, detail: 'Hay cambios sin guardar.', choices: [{ label: 'No guardar', value: 'discard', danger: true }, { label: 'Guardar', value: 'save' }] });
      if (result === 'save') { await this.save(doc); if (this.dirty(doc)) return false; }
      else if (result !== 'discard') return false;
    }
    const index = this.documents.indexOf(doc); this.documents.splice(index, 1);
    const next = this.documents[Math.min(index, this.documents.length - 1)];
    if (this.right === doc) {
      const fallback = next && !next.preview ? next : this.documents.find(d => !d.preview);
      if (fallback) { this.right = fallback; this.split!.setModel(fallback.model); if (this.pane === 'right') this.active = fallback; } else this.closeSplit();
    }
    if (this.left === doc) {
      this.left = null;
      if (next) { const pane = this.pane; this.pane = 'left'; this.active = null; this.activate(next); if (pane === 'right' && this.split) this.focusPane('right'); }
      else { this.active = null; this.showWelcome(); }
    }
    doc.subscription.dispose(); doc.model.dispose();
    this.renderTabs(); this.onChange(); return true;
  }
  async closeAll() { for (const doc of [...this.documents]) if (!await this.close(doc)) return false; this.disposeDiff(); this.layout(); return true; }
  async closeOthers(path: string) { for (const doc of this.documents.filter(d => d.path !== path)) if (!await this.close(doc)) return; }
  /** Closes tabs for a path or anything inside it, so disk operations never leave stale tabs. */
  async closeUnder(path: string) { for (const doc of this.documents.filter(d => d.path === path || d.path.startsWith(`${path}/`))) if (!await this.close(doc)) return false; return true; }
  cycle(step: number) { if (!this.documents.length) return; const index = this.active ? this.documents.indexOf(this.active) : 0; this.activate(this.documents[(index + step + this.documents.length) % this.documents.length]); }
  hasDirty() { return this.documents.some(doc => this.dirty(doc)); }
  showWelcome() { this.disposeDiff(); if (this.split) this.closeSplit(); this.left = this.right = null; this.active = null; this.code.setModel(null); document.querySelector('#preview-surface')!.replaceChildren(); this.layout(); this.renderTabs(); }
  showDiff(diff: Diff, path: string) {
    if (this.active && !this.active.preview && !this.diff) this.active.view = this.current.saveViewState();
    this.disposeDiff();
    const folder = this.twinFolder(path); this.diffTitle = diff.title.replace(path, folder ? `${basename(path)} (${folder})` : basename(path));
    const host = document.querySelector('#diff-editor') as HTMLElement; const id = this.detect(path);
    this.diffModels = [monaco.editor.createModel(diff.original, id), monaco.editor.createModel(diff.modified, id)];
    this.diff = monaco.editor.createDiffEditor(host, { automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: true, ...this.options() });
    this.diff.setModel({ original: this.diffModels[0], modified: this.diffModels[1] }); this.layout(); this.renderTabs();
  }
  private disposeDiff() { this.diff?.dispose(); this.diff = null; this.diffModels.forEach(m => m.dispose()); this.diffModels = []; }
  closeDiff() { this.disposeDiff(); if (this.active) this.activate(this.active); else this.showWelcome(); }
  toggleSplit() {
    if (this.split) { this.closeSplit(); return; }
    const doc = this.active && !this.active.preview ? this.active : this.documents.find(d => !d.preview);
    if (!doc) { toast('Abre un archivo para dividir el editor'); return; }
    this.split = monaco.editor.create(document.querySelector('#split-editor') as HTMLElement, { model: doc.model, automaticLayout: true, ...this.options(), padding: { top: 12, bottom: 12 }, fixedOverflowWidgets: true });
    this.wire(this.split, 'right'); this.right = doc; this.layout(); this.split.focus(); this.focusPane('right'); this.renderTabs(); this.code.layout();
  }
  /** Prepares the right pane to receive the next file that opens. */
  splitForOpen() { if (!this.split) { if (this.documents.some(d => !d.preview)) this.toggleSplit(); } else { this.split.focus(); this.focusPane('right'); } }
  closeSplit() {
    if (!this.split) return;
    this.clearBlame(); this.split.dispose(); this.split = null; this.right = null;
    if (this.pane === 'right') { this.pane = 'left'; this.active = this.left; }
    this.layout(); this.renderTabs(); this.onChange(); this.code.layout(); if (!this.left?.preview) this.code.focus();
  }
  async action(id: string) {
    const target = this.current; target.focus();
    if (id === 'undo' || id === 'redo') { target.trigger('menu', id, null); return; }
    const action = target.getAction(id); if (action) await action.run(); else toast('Esta acción no está disponible para el lenguaje actual');
  }
  actions() { return this.current.getSupportedActions(); }
  languages() { return monaco.languages.getLanguages().map(l => ({ id: l.id, name: l.aliases?.[0] ?? l.id })); }
  setLanguage(id: string) { if (this.active) { monaco.editor.setModelLanguage(this.active.model, id); this.onChange(); } }
  languageName() { const id = this.active?.model.getLanguageId(); return id ? this.languages().find(l => l.id === id)?.name ?? id : ''; }
  eol() { return this.active?.model.getEOL() === '\r\n' ? 'CRLF' : 'LF'; }
  toggleEol() { const model = this.active?.model; if (model) { model.pushEOL(this.eol() === 'LF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF); this.onChange(); } }
  setIndent(size: number) { this.active?.model.updateOptions({ tabSize: size }); this.onChange(); }
  indent() { return this.active?.model.getOptions().tabSize ?? this.settings.tabSize; }
  goToLine(line: number) { if (!this.active) return; const target = Math.min(line, this.active.model.getLineCount()); this.current.setPosition({ lineNumber: target, column: 1 }); this.current.revealLineInCenter(target); this.current.focus(); }
  private async refreshGutter(doc: Document) {
    const changes = this.settings.gitGutter ? await call<LineChange[]>('git_line_changes', { path: doc.path }).catch(() => [] as LineChange[]) : [];
    if (doc.model.isDisposed()) return;
    const classes = { A: 'gutter-added', M: 'gutter-modified', D: 'gutter-deleted' };
    doc.gutter = doc.model.deltaDecorations(doc.gutter, changes.map(c => ({ range: new monaco.Range(c.start, 1, Math.max(c.start, c.start + c.count - 1), 1), options: { isWholeLine: true, linesDecorationsClassName: classes[c.kind] } })));
  }
  refreshGutters() { this.documents.filter(d => !d.preview).forEach(d => void this.refreshGutter(d)); }
  private decorateConflicts(doc: Document) {
    const conflicts = findConflicts(doc.model); if (!doc.conflicts.length && !conflicts.length) return;
    doc.conflicts = doc.model.deltaDecorations(doc.conflicts, conflicts.flatMap(c => [
      { range: new monaco.Range(c.start, 1, c.base - 1, 1), options: { isWholeLine: true, className: 'conflict-current' } },
      { range: new monaco.Range(c.middle + 1, 1, c.end, 1), options: { isWholeLine: true, className: 'conflict-incoming' } },
    ]));
  }
  private clearBlame() { clearTimeout(this.blameTimer); this.onBlame(''); for (const doc of [this.left, this.right]) if (doc?.blame.length && !doc.model.isDisposed()) doc.blame = doc.model.deltaDecorations(doc.blame, []); }
  private scheduleBlame() {
    this.clearBlame(); const doc = this.active; const target = this.current;
    if (!this.settings.blame || !doc || doc.preview || this.diff || this.dirty(doc)) return;
    this.blameTimer = setTimeout(async () => {
      const line = target.getPosition()?.lineNumber; if (!line || doc !== this.active) return;
      const blame = await call<Blame | null | 'failed'>('git_blame', { path: doc.path, line }).catch(() => 'failed' as const);
      if (blame === 'failed' || doc !== this.active || target.getPosition()?.lineNumber !== line || this.dirty(doc)) return;
      const summary = blame ? `${blame.author}, ${ago(blame.time)} · ${blame.summary}` : t('Sin confirmar');
      const column = doc.model.getLineMaxColumn(line);
      doc.blame = doc.model.deltaDecorations(doc.blame, [{ range: new monaco.Range(line, column, line, column), options: { showIfCollapsed: true, after: { content: `    ${summary}`, inlineClassName: 'blame-text' } } }]);
      this.onBlame(summary);
    }, 300);
  }
  tabMenu(event: MouseEvent, path: string, extra: MenuItem[]) {
    menu({ x: event.clientX, y: event.clientY }, [{ label: 'Cerrar archivo', action: () => { const doc = this.documents.find(d => d.path === path); return doc && this.close(doc); } }, { label: 'Cerrar los demás', action: () => this.closeOthers(path) }, { label: 'Cerrar todos', action: () => this.closeAll() }, separator, ...extra]);
  }
}
