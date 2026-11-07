import { getCurrentWindow } from '@tauri-apps/api/window';
import * as monaco from 'monaco-editor';
import './styles.css';
import { call, desktop } from './api';
import { Editor } from './editor';
import { Explorer, SearchPanel } from './explorer';
import { GitPanel } from './git-panel';
import { getLocale, setLocale, t, type Locale } from './i18n';
import { binaryPreview, renderPreview, textPreview } from './preview';
import { TerminalPanel } from './terminal';
import { capture, renderSettings, type SettingsContext } from './settings-page';
import { comboOf, defaultSettings, loadSettings, resolvedTheme, type Settings, type SettingValue } from './settings';
import { basename, type Diff, type Workspace } from './types';
import { ask, button, el, menu, quickPick, raw, report, separator, textButton, toast, type Icon, type MenuItem, type PickItem } from './ui';

const store = {
  get<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(`lumen.${key}`) ?? 'null') ?? fallback; } catch { return fallback; } },
  set(key: string, value: unknown) { try { localStorage.setItem(`lumen.${key}`, JSON.stringify(value)); } catch { /* Storage can be disabled by the host. */ } },
};

document.querySelector('#app')!.innerHTML = `
<header id="titlebar"><span class="brand">Lumen</span><nav id="menubar"></nav><span id="title-text"></span></header>
<div id="workbench">
  <nav id="activity" aria-label="Vistas"></nav>
  <aside id="sidebar">
    <div id="sidebar-header"><h2 id="sidebar-title"></h2><div id="sidebar-actions"></div></div>
    <div id="explorer-content" class="view"></div><div id="search-content" class="view hidden"></div><div id="git-content" class="view hidden"></div>
  </aside>
  <div id="sidebar-sash" class="sash vertical"></div>
  <main id="main">
    <section id="editor-area">
      <div id="tabs" role="tablist"></div>
      <div id="welcome"></div>
      <div id="editor-surface" class="hidden">
        <div id="breadcrumbs"></div>
        <div id="editor-panes">
          <div id="left-pane" class="pane"><div class="pane-title"></div><div id="code-editor"></div><div id="preview-surface" class="hidden"></div></div>
          <div id="pane-sash" class="sash vertical hidden"></div>
          <div id="right-pane" class="pane hidden"><div class="pane-title"></div><div id="split-editor"></div></div>
          <div id="diff-editor" class="hidden"></div>
        </div>
      </div>
    </section>
    <div id="panel-sash" class="sash horizontal"></div>
    <section id="bottom-panel" class="hidden">
      <div id="panel-header"><button id="problems-tab" type="button"></button><button id="output-tab" type="button"></button><button id="terminal-tab" type="button"></button><div id="terminal-sessions"></div><div id="terminal-actions"></div></div>
      <div id="problems-content" class="panel-body hidden"></div>
      <pre id="output-content" class="panel-body hidden"></pre>
      <div id="terminal-content" class="panel-body"><div id="terminal-instances"></div><div id="terminal-empty"><button id="terminal-start" type="button" class="secondary"></button></div></div>
    </section>
  </main>
</div>
<footer id="statusbar"><div id="status-left"></div><div id="status-right"></div></footer>
<div id="toasts" aria-live="polite"></div>`;
document.querySelector('#problems-tab')!.textContent = t('Problemas');
document.querySelector('#output-tab')!.textContent = t('Salida');
document.querySelector('#terminal-tab')!.textContent = t('Terminal');
document.querySelector('#terminal-start')!.textContent = t('Iniciar terminal');

let settings: Settings = { ...loadSettings(store.get<Record<string, SettingValue>>('settings', {})), locale: getLocale() };
let workspace: Workspace | null = null;
let recents = store.get<Workspace[]>('recents', []);
let view: 'explorer' | 'search' | 'git' = 'explorer';
let sidebarVisible = true;
const editor = new Editor(settings), explorer = new Explorer(), search = new SearchPanel(), git = new GitPanel(), terminal = new TerminalPanel(settings);
const requireFolder = () => { if (!workspace) { toast('Abre una carpeta primero', true); return false; } return true; };

/* ---------- Files and workspace ---------- */
async function openFile(path: string, line?: number, column?: number) {
  if (binaryPreview(path) && !line) return openPreview(path);
  try { await editor.open(path, line, column); }
  catch (error) { if (/binario|UTF-8/.test(String(error))) await openPreview(path); else throw error; }
  persistSession();
}
const openPreview = (path: string) => editor.openPreview(path, host => renderPreview(host, path, editor.textOf(path), () => editor.open(path)));
function persistSession() {
  if (workspace) store.set(`session:${workspace.path}`, { files: editor.documents.filter(d => !d.preview).map(d => d.path), active: editor.active?.path });
}
async function openFolder(path?: string) {
  const target = path ?? await call<string | null>('pick_folder');
  if (!target || !await editor.closeAll()) return;
  try { await enter(await call<Workspace>('open_workspace', { path: target })); }
  catch (error) { recents = recents.filter(r => r.path !== target); store.set('recents', recents); renderWelcome(); throw error; }
}
async function enter(info: Workspace) {
  workspace = info; recents = [info, ...recents.filter(r => r.path !== info.path)].slice(0, 10); store.set('recents', recents); store.set('last', info.path);
  await explorer.reset(info.name); git.enabled = true; git.reset(); await git.refresh(true); terminal.reset(); renderWelcome(); updateStatus(); setView('explorer');
  const session = settings.restoreSession ? store.get<{ files: string[]; active?: string }>(`session:${info.path}`, { files: [] }) : { files: [] as string[], active: undefined };
  for (const file of session.files) await editor.open(file).catch(() => {});
  if (session.active && session.files.includes(session.active)) await editor.open(session.active).catch(() => {});
}
async function closeFolder() {
  if (!await editor.closeAll()) return;
  workspace = null; explorer.name = ''; explorer.render(); git.enabled = false; git.reset(); terminal.reset(); store.set('last', null); renderWelcome(); updateStatus();
}
async function cloneRepository() {
  const url = await ask({ title: 'URL del repositorio', placeholder: 'https://github.com/…' }); if (!url?.trim()) return;
  const name = await ask({ title: 'Nombre de la carpeta', value: basename(url.trim()).replace(/\.git$/, '') }); if (!name?.trim() || !await editor.closeAll()) return;
  toast('Clonando repositorio…');
  const info = await call<Workspace | null>('clone_repository', { url: url.trim(), name: name.trim() }); if (info) await enter(info);
}
const absolute = (path: string) => { const root = workspace?.path ?? ''; const separator = root.includes('\\') ? '\\' : '/'; return `${root}${separator}${path.replaceAll('/', separator)}`; };
async function openToSide(path: string) { editor.splitForOpen(); await openFile(path); }
async function saveAs() { const doc = editor.active; if (!doc || doc.preview) return; await explorer.saveAs(doc.path, doc.model.getValue()); }
const quit = () => getCurrentWindow().close();

/* ---------- Tasks ---------- */
const RUNNERS: Record<string, (file: string) => string> = { py: f => `python "${f}"`, js: f => `node "${f}"`, mjs: f => `node "${f}"`, ts: f => `npx tsx "${f}"`, rs: () => 'cargo run', go: f => `go run "${f}"`, sh: f => `bash "${f}"`, ps1: f => `powershell -ExecutionPolicy Bypass -File "${f}"`, bat: f => `.\\"${f}"`, cmd: f => `.\\"${f}"`, rb: f => `ruby "${f}"`, php: f => `php "${f}"`, lua: f => `lua "${f}"` };
async function runActiveFile() {
  const path = editor.active?.path; if (!path || !requireFolder()) return;
  const runner = RUNNERS[path.split('.').pop()?.toLowerCase() ?? '']; if (!runner) { toast('No se sabe cómo ejecutar este archivo', true); return; }
  await editor.saveAll(); await terminal.run(runner(path));
}
async function detectTasks() {
  const tasks: { label: string; command: string }[] = [];
  const read = (path: string) => call<string>('read_file', { path }).catch(() => null);
  const packageJson = await read('package.json');
  if (packageJson) { try { for (const name of Object.keys(JSON.parse(packageJson).scripts ?? {})) tasks.push({ label: `npm: ${name}`, command: `npm run ${name}` }); } catch { /* Invalid manifest: nothing to offer. */ } }
  if (await read('Cargo.toml')) for (const name of ['build', 'run', 'test', 'check', 'clippy']) tasks.push({ label: `cargo: ${name}`, command: `cargo ${name}` });
  if (await read('go.mod')) for (const name of ['build ./...', 'test ./...', 'run .']) tasks.push({ label: `go: ${name}`, command: `go ${name}` });
  if (await read('Makefile')) tasks.push({ label: 'make', command: 'make' });
  const vscode = await read('.vscode/tasks.json');
  if (vscode) { try { for (const task of JSON.parse(vscode.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')).tasks ?? []) if (task.command) tasks.push({ label: task.label ?? task.command, command: [task.command, ...(task.args ?? [])].join(' ') }); } catch { /* Unsupported tasks.json syntax. */ } }
  return tasks;
}
async function runTask() {
  if (!requireFolder()) return;
  const tasks = await detectTasks();
  if (!tasks.length) { toast('No se encontraron tareas (package.json, Cargo.toml, tasks.json…)', true); return; }
  quickPick('Selecciona una tarea', tasks.map(task => ({ label: task.label, detail: task.command, run: async () => { await editor.saveAll(); await terminal.run(task.command); } })));
}

/* ---------- Commands ---------- */
const normalize = (keys: string) => keys.toLowerCase().replace(/\s/g, '');
const SHORTCUTS = new Map<string, Command>();
function rebuildShortcuts() {
  SHORTCUTS.clear();
  for (const c of commands) if (c.keys) SHORTCUTS.set(normalize(c.keys), c);
  if (!SHORTCUTS.has('ctrl+`')) SHORTCUTS.set('ctrl+`', command('terminal'));
}
interface Command { id: string; label: string; run: () => unknown; keys?: string }
const action = (id: string, label: string, monacoId: string, keys?: string): Command => ({ id, label, keys, run: () => editor.action(monacoId) });
const zoom = (delta: number) => updateSettings({ fontSize: delta ? Math.min(72, Math.max(6, settings.fontSize + delta)) : defaultSettings.fontSize });
const commands: Command[] = [
  { id: 'newFile', label: 'Nuevo archivo…', keys: 'Ctrl+N', run: () => requireFolder() && explorer.create(false) },
  { id: 'newFolder', label: 'Nueva carpeta', run: () => requireFolder() && explorer.create(true) },
  { id: 'openFolder', label: 'Abrir carpeta…', keys: 'Ctrl+O', run: () => openFolder() },
  { id: 'recent', label: 'Abrir reciente…', keys: 'Ctrl+R', run: () => quickPick('Proyectos recientes', recents.map(r => ({ label: r.name, detail: r.path, run: () => openFolder(r.path) }))) },
  { id: 'clone', label: 'Clonar repositorio…', run: cloneRepository },
  { id: 'save', label: 'Guardar', keys: 'Ctrl+S', run: () => editor.save() },
  { id: 'saveAs', label: 'Guardar como…', keys: 'Ctrl+Shift+S', run: saveAs },
  { id: 'saveAll', label: 'Guardar todo', keys: 'Ctrl+Alt+S', run: () => editor.saveAll() },
  { id: 'autoSave', label: 'Guardado automático', run: () => updateSettings({ autoSave: !settings.autoSave }) },
  { id: 'reload', label: 'Recargar desde disco', run: () => editor.reload() },
  { id: 'closeFile', label: 'Cerrar archivo', keys: 'Ctrl+W', run: () => editor.diff ? editor.closeDiff() : editor.close() },
  { id: 'closeAll', label: 'Cerrar todos', keys: 'Ctrl+Shift+W', run: () => editor.closeAll() },
  { id: 'closeFolder', label: 'Cerrar carpeta', run: closeFolder },
  { id: 'settings', label: 'Ajustes', keys: 'Ctrl+,', run: openSettings },
  { id: 'quit', label: 'Salir', run: quit },
  action('undo', 'Deshacer', 'undo'), action('redo', 'Rehacer', 'redo'),
  action('cut', 'Cortar', 'editor.action.clipboardCutAction'), action('copy', 'Copiar', 'editor.action.clipboardCopyAction'), action('paste', 'Pegar', 'editor.action.clipboardPasteAction'),
  action('find', 'Buscar en el archivo', 'actions.find'), action('replace', 'Reemplazar en el archivo', 'editor.action.startFindReplaceAction'),
  { id: 'findFiles', label: 'Buscar en todos los archivos', keys: 'Ctrl+Shift+F', run: () => { setView('search'); search.focus(settings.searchSeed ? editor.current.getModel()?.getValueInRange(editor.current.getSelection() ?? new monaco.Range(1, 1, 1, 1)).split('\n')[0] : undefined); } },
  { id: 'replaceFiles', label: 'Reemplazar en todos los archivos', keys: 'Ctrl+Shift+H', run: () => { setView('search'); search.focusReplace(); } },
  action('format', 'Formatear documento', 'editor.action.formatDocument'), action('comment', 'Comentar línea', 'editor.action.commentLine'),
  action('selectAll', 'Seleccionar todo', 'editor.action.selectAll'), action('expand', 'Ampliar selección', 'editor.action.smartSelect.expand'), action('shrink', 'Reducir selección', 'editor.action.smartSelect.shrink'),
  action('cursorUp', 'Añadir cursor arriba', 'editor.action.insertCursorAbove'), action('cursorDown', 'Añadir cursor abajo', 'editor.action.insertCursorBelow'),
  action('nextMatch', 'Añadir siguiente coincidencia', 'editor.action.addSelectionToNextFindMatch'), action('allMatches', 'Seleccionar todas las coincidencias', 'editor.action.selectHighlights'),
  action('duplicate', 'Duplicar línea', 'editor.action.copyLinesDownAction'), action('lineUp', 'Mover línea arriba', 'editor.action.moveLinesUpAction'), action('lineDown', 'Mover línea abajo', 'editor.action.moveLinesDownAction'),
  { id: 'palette', label: 'Paleta de comandos', keys: 'Ctrl+Shift+P', run: () => openPalette('>') },
  { id: 'explorer', label: 'Explorador', keys: 'Ctrl+Shift+E', run: () => setView('explorer') },
  { id: 'search', label: 'Buscar', run: () => setView('search') },
  { id: 'scm', label: 'Control de versiones', keys: 'Ctrl+Shift+G', run: () => setView('git') },
  { id: 'problems', label: 'Mostrar problemas', keys: 'Ctrl+Shift+M', run: () => terminal.show('problems') },
  { id: 'output', label: 'Mostrar salida', keys: 'Ctrl+Shift+U', run: () => terminal.show('output') },
  { id: 'terminal', label: 'Mostrar u ocultar terminal', keys: 'Ctrl+J', run: () => terminal.toggle() },
  { id: 'sidebar', label: 'Mostrar u ocultar barra lateral', keys: 'Ctrl+B', run: toggleSidebar },
  { id: 'split', label: 'Dividir editor', keys: 'Ctrl+\\', run: () => editor.toggleSplit() },
  { id: 'wrap', label: 'Ajuste de línea', keys: 'Alt+Z', run: () => updateSettings({ wordWrap: settings.wordWrap === 'off' ? 'on' : 'off' }) },
  { id: 'minimap', label: 'Mostrar minimapa', run: () => updateSettings({ minimap: !settings.minimap }) },
  { id: 'blame', label: 'Git blame en línea', run: () => updateSettings({ blame: !settings.blame }) },
  { id: 'preview', label: 'Vista previa de Markdown/CSV', keys: 'Ctrl+Shift+V', run: () => editor.active && openPreview(editor.active.path) },
  { id: 'zoomIn', label: 'Aumentar zoom', keys: 'Ctrl+=', run: () => zoom(1) }, { id: 'zoomOut', label: 'Reducir zoom', keys: 'Ctrl+-', run: () => zoom(-1) }, { id: 'zoomReset', label: 'Restablecer zoom', keys: 'Ctrl+0', run: () => zoom(0) },
  { id: 'fullscreen', label: 'Pantalla completa', keys: 'F11', run: async () => { const win = getCurrentWindow(); await win.setFullscreen(!await win.isFullscreen()); } },
  { id: 'goFile', label: 'Abrir archivo…', keys: 'Ctrl+P', run: () => openPalette('') },
  { id: 'goLine', label: 'Ir a la línea', keys: 'Ctrl+G', run: () => openPalette(':') },
  action('goSymbol', 'Ir a símbolo', 'editor.action.quickOutline', 'Ctrl+Shift+O'), action('goDefinition', 'Ir a definición', 'editor.action.revealDefinition'), action('goReferences', 'Ir a referencias', 'editor.action.goToReferences'), action('rename', 'Renombrar símbolo', 'editor.action.rename'),
  action('nextProblem', 'Problema siguiente', 'editor.action.marker.next'), action('prevProblem', 'Problema anterior', 'editor.action.marker.prev'),
  { id: 'nextTab', label: 'Pestaña siguiente', keys: 'Ctrl+Tab', run: () => editor.cycle(1) }, { id: 'prevTab', label: 'Pestaña anterior', keys: 'Ctrl+Shift+Tab', run: () => editor.cycle(-1) },
  { id: 'newTerminal', label: 'Nueva terminal', keys: 'Ctrl+Shift+`', run: () => terminal.create() },
  { id: 'clearTerminal', label: 'Limpiar terminal', run: () => terminal.active?.terminal.clear() },
  { id: 'closeTerminal', label: 'Cerrar terminal activa', run: () => terminal.closeActive() },
  { id: 'runTask', label: 'Ejecutar tarea…', keys: 'Ctrl+Shift+B', run: runTask },
  { id: 'runFile', label: 'Ejecutar archivo activo', keys: 'F5', run: runActiveFile },
  { id: 'gitMerge', label: 'Fusionar rama (merge)…', run: () => git.pickBranch(branch => git.action('merge', branch), 'Rama que quieres fusionar') },
  { id: 'gitBranch', label: 'Cambiar de rama…', run: () => git.pickBranch() },
  { id: 'gitHistory', label: 'Historial', run: () => { setView('git'); return git.history(); } },
  { id: 'gitFileHistory', label: 'Ver historial del archivo', run: () => { if (editor.active) { setView('git'); return git.history(editor.active.path); } } },
  { id: 'gitCompare', label: 'Comparar con HEAD', run: () => editor.active && compareHead(editor.active.path) },
  { id: 'language', label: 'Lenguaje del archivo', run: pickLanguage },
  { id: 'indent', label: 'Tamaño de sangría', run: pickIndent },
  { id: 'eol', label: 'Cambiar final de línea', run: () => editor.toggleEol() },
  { id: 'shortcuts', label: 'Atajos de teclado', run: showShortcuts },
  { id: 'about', label: 'Acerca de Lumen', run: () => ask({ title: 'Acerca de Lumen', detail: 'Lumen 1.0 · Rust + Tauri · Windows y Linux. Editor Monaco y terminal PTY. No incluye todavía depuración, extensiones de VS Code ni servidores LSP externos.', input: false }) },
];
const command = (id: string) => commands.find(c => c.id === id)!;
const defaultKeys = new Map(commands.map(c => [c.id, c.keys]));
let keybindings = store.get<Record<string, string>>('keybindings', {});
for (const [id, keys] of Object.entries(keybindings)) { const found = commands.find(c => c.id === id); if (found) found.keys = keys || undefined; }
const item = (id: string, label?: string): MenuItem => { const c = command(id); return { label: label ?? c.label, shortcut: c.keys, action: c.run }; };
const items = (...ids: string[]): MenuItem[] => ids.map(id => id === '-' ? separator : item(id));
const MENUS: [string, () => MenuItem[]][] = [
  ['Archivo', () => items('newFile', 'newFolder', '-', 'openFolder', 'recent', 'clone', '-', 'save', 'saveAs', 'saveAll', 'autoSave', 'reload', '-', 'closeFile', 'closeAll', 'closeFolder', '-', 'settings', 'quit')],
  ['Editar', () => items('undo', 'redo', '-', 'cut', 'copy', 'paste', '-', 'find', 'replace', 'findFiles', 'replaceFiles', '-', 'format', 'comment')],
  ['Selección', () => items('selectAll', 'expand', 'shrink', '-', 'cursorUp', 'cursorDown', 'nextMatch', 'allMatches', '-', 'duplicate', 'lineUp', 'lineDown')],
  ['Ver', () => items('palette', '-', 'explorer', 'search', 'scm', 'problems', 'output', 'terminal', '-', 'sidebar', 'split', 'wrap', 'minimap', 'blame', 'preview', '-', 'zoomIn', 'zoomOut', 'zoomReset', 'fullscreen')],
  ['Ir', () => items('goFile', 'goLine', 'goSymbol', 'goDefinition', 'goReferences', 'rename', '-', 'nextProblem', 'prevProblem', '-', 'nextTab', 'prevTab')],
  ['Terminal', () => items('newTerminal', 'clearTerminal', 'closeTerminal', '-', 'runTask', 'runFile')],
  ['Ayuda', () => items('palette', 'shortcuts', '-', 'about')],
];
for (const [label, build] of MENUS) { const node = textButton(label, () => menu(node, build())); document.querySelector('#menubar')!.append(node); }

let fileCache: string[] = [];
async function openPalette(prefix: string) {
  if (workspace && !prefix) fileCache = await call<string[]>('list_files').catch(() => []);
  const commandItems = (): PickItem[] => [...commands.map(c => ({ label: t(c.label), hint: c.keys, run: c.run })), ...editor.actions().filter(a => a.isSupported()).map(a => ({ label: a.label, run: () => a.run() }))];
  const fileItems = (): PickItem[] => fileCache.map(path => ({ label: basename(path), detail: path, run: () => openFile(path) }));
  quickPick(prefix === '>' ? 'Escribe un comando…' : 'Busca un archivo por nombre…', query => {
    if (query.startsWith('>')) return commandItems();
    if (query.startsWith('@')) return [{ label: t('Ir a símbolo'), run: command('goSymbol').run }];
    if (query.startsWith(':')) { const line = Number(query.slice(1)); return [{ label: `${t('Ir a la línea')} ${Number.isInteger(line) && line > 0 ? line : ''}`, run: () => { if (line > 0) editor.goToLine(line); } }]; }
    return fileItems();
  }, prefix);

}
function pickLanguage() { quickPick('Selecciona un lenguaje', editor.languages().map(l => ({ label: l.name, detail: l.id, run: () => editor.setLanguage(l.id) }))); }
function pickIndent() { quickPick('Tamaño de sangría', [2, 3, 4, 6, 8].map(size => ({ label: String(size), run: () => editor.setIndent(size) }))); }
async function compareHead(path: string) { editor.showDiff(await call<Diff>('git_diff', { path, staged: true, oldPath: null }).then(async diff => ({ ...diff, modified: editor.textOf(path) ?? await call<string>('read_file', { path }), title: `${basename(path)} · HEAD ↔ ${t('Editor')}` })), path); }
async function showShortcuts() { await openSettings(); }

/* ---------- Layout ---------- */
const VIEWS = { explorer: ['Explorador', '#explorer-content', 'Files'], search: ['Buscar', '#search-content', 'Search'], git: ['Control de versiones', '#git-content', 'GitBranch'] } as const;
function toggleSidebar() { sidebarVisible = !sidebarVisible; document.querySelector('#sidebar')!.classList.toggle('hidden', !sidebarVisible); document.querySelector('#sidebar-sash')!.classList.toggle('hidden', !sidebarVisible); renderActivity(); }
function setView(next: typeof view) {
  view = next; if (!sidebarVisible) toggleSidebar();
  for (const [id, [, selector]] of Object.entries(VIEWS)) document.querySelector(selector)!.classList.toggle('hidden', id !== next);
  document.querySelector('#sidebar-title')!.textContent = t(VIEWS[next][0]);
  const actions = document.querySelector('#sidebar-actions')!; actions.replaceChildren();
  if (next === 'explorer') actions.append(button('Nuevo archivo', () => command('newFile').run(), 'FilePlus2'), button('Nueva carpeta', () => command('newFolder').run(), 'FolderPlus'), button('Actualizar', () => explorer.refresh(), 'RefreshCw'), button('Contraer todo', () => explorer.collapseAll(), 'ChevronsDownUp'));
  if (next === 'git') { const more = button('Más acciones de Git', () => git.more(more), 'MoreHorizontal'); actions.append(button('Actualizar', () => git.refresh(true), 'RefreshCw'), more); }
  renderActivity();
}
function renderActivity() {
  const host = document.querySelector('#activity')!; host.replaceChildren();
  for (const [id, [label, , glyph]] of Object.entries(VIEWS) as [typeof view, typeof VIEWS[typeof view]][]) {
    const node = button(label, () => { if (view === id && sidebarVisible) toggleSidebar(); else setView(id); }, glyph as Icon, view === id && sidebarVisible ? 'active' : '');
    const count = id === 'git' ? git.status?.changes.length : 0; if (count) node.append(raw('span', 'badge', String(count)));
    host.append(node);
  }
  host.append(raw('span', 'spacer'), button('Ajustes', openSettings, 'Settings2'));
}
function sash(id: string, axis: 'x' | 'y', apply: (value: number) => void) {
  document.querySelector(id)!.addEventListener('pointerdown', event => {
    const target = event.target as HTMLElement; target.setPointerCapture((event as PointerEvent).pointerId); target.classList.add('dragging');
    const move = (e: Event) => apply(axis === 'x' ? (e as PointerEvent).clientX : (e as PointerEvent).clientY);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', () => { target.removeEventListener('pointermove', move); target.classList.remove('dragging'); }, { once: true });
  });
}
function setSize(name: string, value: number) { document.documentElement.style.setProperty(`--${name}`, `${value}px`); store.set(name, value); }
setSize('sidebar-width', store.get('sidebar-width', 280)); setSize('panel-height', store.get('panel-height', 280));
sash('#sidebar-sash', 'x', x => setSize('sidebar-width', Math.min(window.innerWidth - 300, Math.max(170, settings.sidebarPosition === 'right' ? window.innerWidth - x : x - (settings.showActivityBar ? 48 : 0)))));
sash('#pane-sash', 'x', x => { const box = document.querySelector('#editor-panes')!.getBoundingClientRect(); document.documentElement.style.setProperty('--split', `${Math.min(85, Math.max(15, (x - box.left) / box.width * 100))}%`); });
sash('#panel-sash', 'y', y => setSize('panel-height', Math.min(window.innerHeight - 180, Math.max(90, window.innerHeight - y - 24))));

/* ---------- Status bar, welcome, problems ---------- */
function statusItem(host: Element, text: string, action?: () => unknown, glyph?: Icon, title = '') {
  const node = button(title || text, action ?? (() => {}), glyph, 'status-item'); node.append(raw('span', '', text)); host.append(node);
}
let cursor = { line: 1, column: 1 }, blameText = '';
function updateStatus() {
  const left = document.querySelector('#status-left')!, right = document.querySelector('#status-right')!; left.replaceChildren(); right.replaceChildren();
  if (git.status) { statusItem(left, git.status.branch + (git.status.changes.length ? '*' : ''), () => git.pickBranch(), 'GitBranch'); statusItem(left, `↑${git.status.ahead} ↓${git.status.behind}`, () => git.sync(), 'RefreshCw', 'Sync'); }
  else statusItem(left, workspace?.name ?? t('Sin carpeta'), () => command('openFolder').run(), 'Folder');
  const markers = monaco.editor.getModelMarkers({}); const count = (severity: monaco.MarkerSeverity) => markers.filter(m => m.severity === severity).length;
  statusItem(left, String(count(monaco.MarkerSeverity.Error)), () => terminal.show('problems'), 'CircleX', 'Problemas'); statusItem(left, String(count(monaco.MarkerSeverity.Warning)), () => terminal.show('problems'), 'TriangleAlert', 'Problemas');
  if (blameText) statusItem(left, blameText, () => command('gitFileHistory').run(), 'History', 'Ver historial del archivo');
  if (editor.active && !editor.active.preview) {
    statusItem(right, `${t('Línea')} ${cursor.line}, ${t('Columna')} ${cursor.column}`, () => openPalette(':'));
    statusItem(right, `${t('Espacios')}: ${editor.indent()}`, pickIndent); statusItem(right, 'UTF-8'); statusItem(right, editor.eol(), () => editor.toggleEol()); statusItem(right, editor.languageName(), pickLanguage);
  }
  statusItem(right, t(desktop ? 'Listo' : 'Vista previa web'));
  const name = editor.activeTitle(); const title = [name, workspace?.name, 'Lumen'].filter(Boolean).join(' — ');
  document.title = title; document.querySelector('#title-text')!.textContent = title;
  if (desktop) void getCurrentWindow().setTitle(title).catch(() => {});
}
function renderWelcome() {
  const host = document.querySelector('#welcome')!; host.replaceChildren();
  const hero = raw('div', 'hero'); hero.append(el('h1', '', 'Un espacio para tu código.'), el('p', 'muted', 'Editor preciso. Git integrado. Una terminal de verdad.'));
  const start = raw('div', 'welcome-col'); start.append(el('h3', '', 'EMPEZAR'), textButton('Abrir carpeta…', () => openFolder(), 'FolderOpen'), textButton('Clonar repositorio…', cloneRepository, 'GitFork'), textButton('Paleta de comandos', () => openPalette('>'), 'Search'));
  const recent = raw('div', 'welcome-col'); recent.append(el('h3', '', 'RECIENTES'));
  if (!recents.length) recent.append(el('p', 'muted', 'Todavía no has abierto ningún proyecto.'));
  for (const entry of recents.slice(0, 6)) { const row = button(entry.path, () => openFolder(entry.path), 'Folder', 'recent-row'); row.append(raw('span', '', entry.name), raw('small', '', entry.path)); recent.append(row); }
  const columns = raw('div', 'welcome-grid'); columns.append(start, recent); hero.append(columns); host.append(hero);
}
function renderProblems() {
  const host = document.querySelector('#problems-content')!; host.replaceChildren();
  const markers = monaco.editor.getModelMarkers({}).filter(m => m.resource.scheme === 'file');
  if (!markers.length) host.append(el('p', 'muted panel-empty', 'Sin problemas en los archivos abiertos.'));
  for (const marker of markers.sort((a, b) => b.severity - a.severity)) {
    const path = marker.resource.path.slice(1);
    const row = button(`${path}:${marker.startLineNumber}`, () => openFile(path, marker.startLineNumber, marker.startColumn), marker.severity === monaco.MarkerSeverity.Error ? 'CircleX' : marker.severity === monaco.MarkerSeverity.Warning ? 'TriangleAlert' : 'Info', 'problem-row');
    row.append(raw('span', '', marker.message), raw('small', '', `${path}:${marker.startLineNumber}:${marker.startColumn}`)); host.append(row);
  }
  document.querySelector('#problems-tab')!.textContent = `${t('Problemas')}${markers.length ? ` (${markers.length})` : ''}`;
  updateStatus();
}

/* ---------- Settings ---------- */
const SETTINGS_TAB = 'lumen:settings';
const shortcuts = () => commands.map(c => ({ id: c.id, label: c.label, keys: c.keys, defaultKeys: defaultKeys.get(c.id) }));
const settingsContext = (): SettingsContext => ({
  values: () => settings, update: updateSettings,
  get shortcuts() { return shortcuts(); },
  bind(id, keys) {
    const target = keys ?? defaultKeys.get(id);
    // One combination drives one command: the previous owner gives it up.
    if (target) for (const other of commands) if (other.id !== id && other.keys && normalize(other.keys) === normalize(target)) { other.keys = undefined; keybindings[other.id] = ''; }
    command(id).keys = target; if (keys) keybindings[id] = keys; else delete keybindings[id];
    store.set('keybindings', keybindings); rebuildShortcuts();
  },
});
function openSettings() { return editor.openPreview(SETTINGS_TAB, async host => renderSettings(host, settingsContext()), t('Ajustes'), 'Settings2'); }
function applySettings() {
  const root = document.documentElement; const classes = { 'no-activity': !settings.showActivityBar, 'no-status': !settings.showStatusBar, 'no-tabs': !settings.showTabs, 'no-breadcrumbs': !settings.showBreadcrumbs, 'sidebar-right': settings.sidebarPosition === 'right' };
  root.dataset.theme = resolvedTheme(settings); root.style.fontSize = `${settings.uiFontSize}px`;
  for (const [name, on] of Object.entries(classes)) root.classList.toggle(name, on);
  editor.applySettings(settings); terminal.applySettings(settings);
  explorer.indent = settings.explorerIndent; explorer.confirmDelete = settings.explorerConfirmDelete; explorer.setExclude(settings.explorerExclude);
  search.delay = settings.searchDelay; git.smartCommit = settings.gitSmartCommit; git.pullMode = settings.gitPullMode;
  git.onUpdate(); scheduleFetch();
}
function updateSettings(change: Partial<Settings>) {
  const locale = change.locale; settings = { ...settings, ...change } as Settings; store.set('settings', settings); applySettings();
  if (locale && locale !== getLocale()) {
    if (editor.hasDirty()) { toast('Guarda los cambios para cambiar de idioma', true); return; }
    persistSession(); setLocale(locale as Locale); location.reload();
  }
}
let fetchTimer: ReturnType<typeof setInterval> | undefined;
function scheduleFetch() {
  clearInterval(fetchTimer);
  if (settings.gitAutoFetch > 0) fetchTimer = setInterval(() => { if (git.status) void call('git_action', { action: 'fetch', value: '', paths: [] }).then(() => git.refresh()).catch(() => {}); }, settings.gitAutoFetch * 60000);
}

/* ---------- Wiring ---------- */
editor.onChange = () => {
  updateStatus();
  const path = editor.active?.path; if (settings.explorerAutoReveal && path && !editor.active?.title && path !== explorer.selected) void explorer.reveal(path).catch(() => {});
};
terminal.onHide = () => { if (!document.querySelector('dialog[open]')) editor.current.focus(); };
editor.onBlame = text => { blameText = text; updateStatus(); };
editor.onCursor = (line, column) => { cursor = { line, column }; updateStatus(); };
editor.onSaved = () => { void git.refresh(); };
editor.onTabMenu = (event, path) => editor.tabMenu(event, path, path === SETTINGS_TAB ? [] : [{ label: 'Copiar ruta relativa', action: () => navigator.clipboard.writeText(path) }, { label: 'Copiar ruta absoluta', action: () => navigator.clipboard.writeText(absolute(path)) }, { label: 'Abrir a un lado', action: () => openToSide(path) }, { label: 'Mostrar en el explorador del sistema', action: () => call('reveal_entry', { path }) }, { label: 'Comparar con HEAD', action: () => compareHead(path) }, ...(textPreview(path) ? [{ label: 'Abrir vista previa', action: () => openPreview(path) }] : [])]);
explorer.onOpen = path => openFile(path);
explorer.onOpenSide = openToSide;
explorer.beforeMutation = path => editor.closeUnder(path);
explorer.onChanged = () => { void git.refresh(); persistSession(); };
explorer.onEntryMenu = entry => [{ label: 'Copiar ruta absoluta', action: () => navigator.clipboard.writeText(absolute(entry.path)) }, { label: 'Mostrar en el explorador del sistema', action: () => call('reveal_entry', { path: entry.path }) }, ...(entry.isDir ? [] : [{ label: 'Ver historial del archivo', action: () => { setView('git'); return git.history(entry.path); } }, ...(textPreview(entry.path) ? [{ label: 'Abrir vista previa', action: () => openPreview(entry.path) }] : [])]), ...(entry.isDir ? [{ label: 'Abrir terminal aquí', action: () => terminal.run(`cd "${entry.path}"`) }] : [])];
search.onOpen = (path, line, column) => openFile(path, line, column);
search.beforeReplace = () => editor.saveAll();
search.afterReplace = async () => { await editor.syncDisk(); await git.refresh(); };
git.onDiff = (diff, path) => editor.showDiff(diff, path);
git.onOpen = path => openFile(path);
git.onOutput = text => terminal.log(text);
git.onChanged = () => { void editor.syncDisk(); void explorer.refresh(); editor.refreshGutters(); };
git.onUpdate = () => {
  const statuses = new Map((settings.explorerGitStatus ? git.status?.changes ?? [] : []).map(c => [c.path, c.conflict ? 'U' : c.worktree === '?' ? 'A' : c.worktree !== ' ' ? c.worktree : c.index]));
  if (JSON.stringify([...statuses]) !== JSON.stringify([...explorer.statuses])) { explorer.statuses = statuses; explorer.render(); }
  updateStatus(); renderActivity();
};
monaco.editor.onDidChangeMarkers(renderProblems);

window.addEventListener('keydown', event => {
  if (capture.active || document.querySelector('dialog[open]')) return;
  const combo = comboOf(event); if (!combo) return;
  // Spanish keyboards press ñ for the backquote shortcut, as in VS Code.
  const physical = event.code === 'Backquote' || event.key.toLowerCase() === 'ñ' ? combo.replace(/[^+]+$/, '`') : combo;
  const found = SHORTCUTS.get(normalize(physical));
  if (found) { event.preventDefault(); event.stopPropagation(); Promise.resolve().then(found.run).catch(report); }
}, true);
document.addEventListener('contextmenu', event => { if (!(event.target as HTMLElement).closest('input, textarea, .xterm')) event.preventDefault(); });

rebuildShortcuts();
renderActivity(); renderWelcome(); explorer.render(); search.mount(); git.render(); renderProblems(); setView('explorer');
applySettings();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (settings.theme === 'system') applySettings(); });
if (desktop) {
  void getCurrentWindow().onCloseRequested(async event => {
    persistSession();
    if (!editor.hasDirty()) return;
    event.preventDefault();
    const choice = await ask({ title: '¿Salir de Lumen?', detail: 'Hay cambios sin guardar.', choices: [{ label: 'No guardar', value: 'discard', danger: true }, { label: 'Guardar todo', value: 'save' }] });
    if (choice === 'save') await editor.saveAll().catch(report);
    if (choice === 'discard' || (choice === 'save' && !editor.hasDirty())) await getCurrentWindow().destroy();
  });
  void (async () => {
    const last = await call<string | null>('startup_path') ?? (settings.restoreFolder ? store.get<string | null>('last', null) : null);
    if (last) await openFolder(last).catch(report);
  })();
  window.addEventListener('blur', () => { if (settings.autoSaveOnFocusLost) void editor.saveAll().catch(report); });
  window.addEventListener('focus', () => { void editor.syncDisk(); void explorer.refresh().catch(() => {}); void git.refresh(); });
  const poll = () => { if (workspace && !document.hidden) { void editor.syncDisk(); void explorer.refresh().catch(() => {}); void git.refresh(); } setTimeout(poll, settings.pollInterval * 1000); };
  poll();
} else toast('Abre la aplicación de escritorio para acceder a archivos, Git y terminal. Esta ventana es una vista previa de la interfaz.');
