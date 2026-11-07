import { t } from './i18n';
import { ALL_SETTINGS, CATEGORIES, comboOf, defaultSettings, type Setting, type Settings } from './settings';
import { ask, button, el, icon, raw, textButton } from './ui';

export interface Shortcut { id: string; label: string; keys?: string; defaultKeys?: string }
export interface SettingsContext { values: () => Settings; update: (change: Partial<Settings>) => void; shortcuts: Shortcut[]; bind: (id: string, keys: string | null) => void }

const SHORTCUTS_ID = 'shortcuts';
const state = { category: 'window', query: '' };
/** True while a row is recording a key combination, so global shortcuts stay quiet. */
export const capture = { active: false };

const modified = (ctx: SettingsContext, setting: Setting) => ctx.values()[setting.key] !== setting.default;

function control(ctx: SettingsContext, setting: Setting, changed: () => void) {
  const value = ctx.values()[setting.key]; const commit = (next: Settings[string]) => { ctx.update({ [setting.key]: next }); changed(); };
  if (setting.type === 'boolean') {
    const label = raw('label', 'switch'); const input = raw('input'); input.type = 'checkbox'; input.checked = value as boolean; input.setAttribute('aria-label', t(setting.title));
    input.addEventListener('change', () => commit(input.checked)); label.append(input, raw('span')); return label;
  }
  if (setting.type === 'select') {
    const select = raw('select'); select.setAttribute('aria-label', t(setting.title));
    for (const [id, name] of setting.options!) { const option = el('option', '', name); option.value = id; option.selected = id === String(value); select.append(option); }
    select.addEventListener('change', () => commit(select.value)); return select;
  }
  const input = raw('input', setting.type === 'number' ? 'number-input' : 'text-input'); input.type = setting.type; input.value = String(value); input.setAttribute('aria-label', t(setting.title));
  if (setting.placeholder) input.placeholder = setting.placeholder;
  if (setting.type === 'number') { input.min = String(setting.min); input.max = String(setting.max); input.step = String(setting.step ?? 1); }
  input.addEventListener('change', () => {
    if (setting.type !== 'number') { commit(input.value); return; }
    const number = Math.min(setting.max ?? Infinity, Math.max(setting.min ?? -Infinity, Number(input.value) || 0)); input.value = String(number); commit(number);
  });
  return input;
}
function row(ctx: SettingsContext, setting: Setting, refresh: () => void): HTMLElement {
  const node = raw('div', 'setting-row'); node.dataset.key = setting.key;
  const text = raw('div', 'setting-text'); const title = raw('div', 'setting-title'); title.append(el('span', '', setting.title));
  const tag = el('span', 'setting-tag', 'Modificado'); title.append(tag);
  text.append(title, el('p', 'muted', setting.description));
  const side = raw('div', 'setting-control');
  const reset = button('Restablecer', () => { ctx.update({ [setting.key]: setting.default }); node.replaceWith(row(ctx, setting, refresh)); refresh(); }, 'Undo2', 'setting-reset');
  const mark = () => { node.classList.toggle('modified', modified(ctx, setting)); refresh(); };
  side.append(reset, control(ctx, setting, mark)); node.append(text, side);
  node.classList.toggle('modified', modified(ctx, setting));
  return node;
}
function shortcutRow(ctx: SettingsContext, shortcut: Shortcut, repaint: () => void) {
  const node = raw('div', `setting-row shortcut-row ${shortcut.keys !== shortcut.defaultKeys ? 'modified' : ''}`);
  const text = raw('div', 'setting-text'); text.append(raw('div', 'setting-title', t(shortcut.label)));
  const side = raw('div', 'setting-control');
  const chip = raw('button', 'key-chip', shortcut.keys ?? t('Sin asignar')); chip.type = 'button';
  chip.addEventListener('click', () => {
    if (capture.active) return;
    capture.active = true; chip.textContent = t('Pulsa la combinación…'); chip.classList.add('recording');
    const stop = () => { capture.active = false; window.removeEventListener('keydown', listen, true); };
    const listen = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { stop(); repaint(); return; }
      const combo = comboOf(event); if (!combo) return;
      stop(); ctx.bind(shortcut.id, combo); repaint();
    };
    window.addEventListener('keydown', listen, true);
  });
  const reset = button('Restablecer', () => { ctx.bind(shortcut.id, null); repaint(); }, 'Undo2', 'setting-reset');
  side.append(reset, chip); node.append(text, side); return node;
}

export function renderSettings(host: HTMLElement, ctx: SettingsContext) {
  host.replaceChildren();
  const page = raw('div', 'settings-page'); const nav = raw('aside', 'settings-nav'); const body = raw('section', 'settings-body');
  const heading = raw('div', 'settings-heading'); heading.append(el('h1', '', 'Ajustes'));
  const field = raw('div', 'settings-search'); const input = raw('input'); input.type = 'search'; input.placeholder = t('Buscar ajustes'); input.setAttribute('aria-label', input.placeholder); input.value = state.query; field.append(icon('Search'), input);
  const list = raw('nav', 'settings-categories'); list.setAttribute('aria-label', t('Ajustes'));
  const footer = textButton('Restablecer todo', async () => {
    if (!await ask({ title: '¿Restablecer todos los ajustes?', detail: 'Los valores volverán a los predeterminados. Los atajos de teclado no cambian.', input: false, confirm: 'Restablecer todo', danger: true })) return;
    ctx.update(Object.fromEntries(ALL_SETTINGS.filter(s => s.key !== 'locale').map(s => [s.key, defaultSettings[s.key]]))); paint();
  }, 'Undo2', 'settings-reset-all');
  nav.append(heading, field, list, footer);
  const counts = () => { for (const category of CATEGORIES) { const count = category.settings.filter(s => modified(ctx, s)).length; const badge = list.querySelector(`[data-id="${category.id}"] .nav-count`); if (badge) badge.textContent = count ? String(count) : ''; } };
  const section = (title: string) => { const heading = el('h2', '', title); body.append(heading); };
  function paintList() {
    list.replaceChildren();
    for (const category of [...CATEGORIES, { id: SHORTCUTS_ID, label: 'Atajos de teclado', icon: 'Keyboard' as const, settings: [] }]) {
      const item = textButton(category.label, () => { state.category = category.id; state.query = ''; input.value = ''; paint(); }, category.icon, `settings-category ${!state.query && state.category === category.id ? 'active' : ''}`);
      item.dataset.id = category.id; item.append(raw('span', 'nav-count')); list.append(item);
    }
    counts();
  }
  function paint() {
    paintList(); body.replaceChildren(); body.scrollTop = 0;
    const needle = state.query.trim().toLowerCase();
    const matches = (...parts: string[]) => parts.some(part => part.toLowerCase().includes(needle) || t(part).toLowerCase().includes(needle));
    if (needle) {
      let found = 0;
      for (const category of CATEGORIES) {
        const settings = category.settings.filter(s => matches(s.title, s.description, s.key)); if (!settings.length) continue;
        found += settings.length; section(category.label); for (const setting of settings) body.append(row(ctx, setting, counts));
      }
      const shortcuts = ctx.shortcuts.filter(s => matches(s.label, s.keys ?? '')); found += shortcuts.length;
      if (shortcuts.length) { section('Atajos de teclado'); for (const shortcut of shortcuts) body.append(shortcutRow(ctx, shortcut, paint)); }
      if (!found) body.append(el('p', 'muted settings-empty', 'Sin resultados'));
      return;
    }
    if (state.category === SHORTCUTS_ID) {
      section('Atajos de teclado'); body.append(el('p', 'muted settings-intro', 'Haz clic en una combinación y pulsa la nueva. Esc cancela.'));
      for (const shortcut of ctx.shortcuts) body.append(shortcutRow(ctx, shortcut, paint));
      return;
    }
    const category = CATEGORIES.find(c => c.id === state.category)!;
    section(category.label); for (const setting of category.settings) body.append(row(ctx, setting, counts));
  }
  input.addEventListener('input', () => { state.query = input.value; paint(); });
  page.append(nav, body); host.append(page); paint();
}
