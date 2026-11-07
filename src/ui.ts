import { createElement, Keyboard, PanelsTopLeft, Save, TextCursorInput, Type, WandSparkles, Archive, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, ChevronsDownUp, Circle, CircleAlert, CircleX, Columns2, Eye, File, FileCode2, FilePlus2, Files, Folder, FolderOpen, FolderPlus, GitBranch, GitCommitHorizontal, GitCompareArrows, GitFork, Globe, History, Info, List, Minus, MoreHorizontal, Play, Plus, RefreshCw, Replace, ReplaceAll, Search, Settings2, Tag, Terminal, Trash2, TriangleAlert, Undo2, X } from 'lucide';
import { t } from './i18n';
import { fuzzy } from './types';

const icons = { Keyboard, PanelsTopLeft, Save, TextCursorInput, Type, WandSparkles, Archive, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, ChevronsDownUp, Circle, CircleAlert, CircleX, Columns2, Eye, File, FileCode2, FilePlus2, Files, Folder, FolderOpen, FolderPlus, GitBranch, GitCommitHorizontal, GitCompareArrows, GitFork, Globe, History, Info, List, Minus, MoreHorizontal, Play, Plus, RefreshCw, Replace, ReplaceAll, Search, Settings2, Tag, Terminal, Trash2, TriangleAlert, Undo2, X };
export type Icon = keyof typeof icons;
export function icon(name: Icon, className = ''): SVGElement {
  const node = createElement(icons[name]);
  for (const [key, value] of Object.entries({ width: 16, height: 16, 'stroke-width': 1.65, class: `icon ${className}`, 'aria-hidden': 'true' })) node.setAttribute(key, String(value));
  return node;
}
/** Creates an element with dynamic text that must stay as is (file names, commit subjects…). */
export function raw<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/** Creates an element whose text is an interface string, translated to the active locale. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  return raw(tag, className, text === undefined ? undefined : t(text));
}
export function button(label: string, action: () => unknown, glyph?: Icon, className = ''): HTMLButtonElement {
  const node = raw('button', className); node.type = 'button'; node.title = t(label); node.setAttribute('aria-label', t(label));
  if (glyph) node.append(icon(glyph));
  node.addEventListener('click', () => { Promise.resolve().then(action).catch(report); });
  return node;
}
export function textButton(label: string, action: () => unknown, glyph?: Icon, className = ''): HTMLButtonElement {
  const node = button(label, action, glyph, className); node.append(el('span', '', label)); return node;
}
export function toast(message: string, error = false) {
  const host = document.querySelector('#toasts')!;
  const node = raw('div', `toast ${error ? 'error' : ''}`); node.setAttribute('role', error ? 'alert' : 'status');
  node.append(icon(error ? 'CircleX' : 'Check'), el('span', '', message), button('Cerrar aviso', () => node.remove(), 'X'));
  host.append(node); setTimeout(() => node.remove(), error ? 15000 : 5000);
}
export function report(error: unknown) { console.error(error); toast(String(error instanceof Error ? error.message : error), true); }

interface Choice { label: string; value: string; danger?: boolean }
interface DialogOptions { title: string; detail?: string; value?: string; placeholder?: string; confirm?: string; danger?: boolean; input?: boolean; choices?: Choice[] }
export function ask(options: DialogOptions): Promise<string | null> {
  return new Promise(resolve => {
    const dialog = raw('dialog', 'form-dialog'); const form = raw('form'); form.method = 'dialog';
    const heading = el('h2', '', options.title); heading.id = 'dialog-title'; dialog.setAttribute('aria-labelledby', heading.id); form.append(heading);
    if (options.detail) form.append(el('p', 'muted', options.detail));
    const input = raw('input'); input.value = options.value ?? ''; input.placeholder = t(options.placeholder ?? ''); input.setAttribute('aria-label', t(options.title));
    const textual = options.input !== false && !options.choices;
    if (textual) form.append(input);
    const actions = raw('div', 'dialog-actions');
    let settled = false;
    const finish = (result: string | null) => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(result); };
    actions.append(textButton('Cancelar', () => finish(null), undefined, 'secondary'));
    for (const choice of options.choices ?? []) actions.append(textButton(choice.label, () => finish(choice.value), undefined, choice.danger ? 'danger-button' : 'secondary'));
    let submit: HTMLButtonElement | null = null;
    if (!options.choices) { submit = textButton(options.confirm ?? 'Aceptar', () => {}, undefined, options.danger ? 'danger-button' : 'primary'); submit.type = 'submit'; actions.append(submit); }
    form.append(actions); dialog.append(form); document.body.append(dialog);
    form.addEventListener('submit', event => { event.preventDefault(); finish(textual ? input.value : 'yes'); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.showModal();
    if (textual) { input.focus(); input.select(); } else (submit ?? actions.lastElementChild as HTMLElement).focus();
  });
}

export interface MenuItem { label: string; action?: () => unknown; shortcut?: string; danger?: boolean }
export const separator: MenuItem = { label: '-' };
export function menu(anchor: HTMLElement | { x: number; y: number }, items: MenuItem[]) {
  document.querySelector('.popup-menu')?.remove();
  const popup = raw('div', 'popup-menu'); popup.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.label === '-') { popup.append(raw('hr')); continue; }
    const row = textButton(item.label, () => { popup.remove(); return item.action?.(); }, undefined, item.danger ? 'danger-text' : ''); row.setAttribute('role', 'menuitem');
    if (item.shortcut) row.append(raw('kbd', '', item.shortcut)); popup.append(row);
  }
  document.body.append(popup);
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y };
  popup.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`;
  popup.style.top = `${Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - popup.offsetHeight - 10))}px`;
  popup.querySelector('button')?.focus();
  const close = (event: Event) => { if (!popup.contains(event.target as Node)) { popup.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  popup.addEventListener('keydown', e => {
    const rows = [...popup.querySelectorAll('button')]; const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { popup.remove(); if (anchor instanceof HTMLElement) anchor.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); rows[(index + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus(); }
  });
}

export interface PickItem { label: string; detail?: string; hint?: string; run: () => unknown }
/** VS Code style quick input. `source` may rebuild the list from the query (prefix modes). */
export function quickPick(placeholder: string, source: PickItem[] | ((query: string) => PickItem[]), initial = '') {
  document.querySelector('.palette')?.remove();
  const dialog = raw('dialog', 'palette'); const input = raw('input'); input.placeholder = t(placeholder); input.value = initial; input.setAttribute('aria-label', t(placeholder));
  const list = raw('div', 'palette-list'); list.setAttribute('role', 'listbox');
  const footer = raw('div', 'palette-footer');
  footer.append(raw('kbd', '', '↑↓'), el('span', '', 'para navegar'), raw('kbd', '', '↵'), el('span', '', 'para abrir'), raw('kbd', '', 'esc'), el('span', '', 'para cerrar'));
  dialog.append(input, list, footer); document.body.append(dialog);
  let shown: PickItem[] = [], selected = 0;
  const close = () => { dialog.close(); dialog.remove(); };
  const choose = (item?: PickItem) => { if (!item) return; close(); Promise.resolve().then(item.run).catch(report); };
  const paint = () => [...list.children].forEach((row, index) => { row.classList.toggle('selected', index === selected); if (index === selected) row.scrollIntoView({ block: 'nearest' }); });
  const render = () => {
    const query = input.value; const items = typeof source === 'function' ? source(query) : source;
    const needle = typeof source === 'function' ? query.replace(/^[>:@]/, '') : query;
    shown = !needle ? items.slice(0, 80) : items.map(item => ({ item, score: fuzzy(needle, `${item.label} ${item.detail ?? ''}`) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 80).map(x => x.item);
    selected = 0; list.replaceChildren();
    if (!shown.length) list.append(el('p', 'muted palette-empty', 'Sin resultados'));
    shown.forEach((item, index) => {
      const row = raw('button', 'palette-row'); row.type = 'button'; row.setAttribute('role', 'option');
      row.append(raw('span', '', item.label)); if (item.detail) row.append(raw('small', '', item.detail)); if (item.hint) row.append(raw('kbd', '', item.hint));
      row.addEventListener('click', () => choose(item)); row.addEventListener('pointermove', () => { if (selected !== index) { selected = index; paint(); } });
      list.append(row);
    });
    paint();
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { selected = (selected + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; paint(); } }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[selected]); }
  });
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('pointerdown', e => { if (e.target === dialog) close(); });
  dialog.showModal(); input.focus(); render();
  return render;
}
