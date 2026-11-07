import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Channel } from '@tauri-apps/api/core';
import '@xterm/xterm/css/xterm.css';
import { call } from './api';
import { t } from './i18n';
import { resolvedTheme, type Settings } from './settings';
import { ask, button, raw, report, textButton } from './ui';

type TerminalEvent = { kind: 'data'; data: number[] } | { kind: 'exit'; code: number };
type PanelTab = 'terminal' | 'output' | 'problems';
interface Session { id: number; name: string; terminal: Terminal; fit: FitAddon; host: HTMLElement; exited: boolean }
const THEMES = { dark: { background: '#111419', foreground: '#ced5df', cursor: '#8ce8c2', selectionBackground: '#35554f' }, light: { background: '#f4f4f2', foreground: '#2b3138', cursor: '#17795c', selectionBackground: '#b5e6d5' } };
export class TerminalPanel {
  sessions: Session[] = [];
  active: Session | null = null;
  visible = false;
  tab: PanelTab = 'terminal';
  onHide: () => void = () => {};
  private starting = false;
  private output: HTMLElement;
  private panel = document.querySelector('#bottom-panel') as HTMLElement;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private startSequence = 0;
  private outputText = '';
  constructor(private settings: Settings) {
    this.output = document.querySelector('#output-content') as HTMLElement;
    new ResizeObserver(() => { clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.fit(), 80); }).observe(this.panel);
    for (const tab of ['terminal', 'output', 'problems'] as const) document.querySelector(`#${tab}-tab`)!.addEventListener('click', () => this.show(tab));
    document.querySelector('#terminal-actions')!.append(button('Nueva terminal', () => this.create(), 'Plus'), button('Limpiar terminal', () => this.active?.terminal.clear(), 'List'), button('Cerrar terminal activa', () => this.closeActive(), 'Trash2'), button('Ocultar panel', () => this.hide(), 'X'));
    document.querySelector('#terminal-start')!.addEventListener('click', () => void this.create().catch(report));
  }
  private options() {
    const s = this.settings;
    return { fontFamily: s.terminalFontFamily, fontSize: s.terminalFontSize, lineHeight: s.terminalLineHeight, cursorStyle: s.terminalCursorStyle as 'block' | 'underline' | 'bar', cursorBlink: s.terminalCursorBlink, scrollback: s.terminalScrollback, theme: THEMES[resolvedTheme(s)] };
  }
  applySettings(settings: Settings) {
    this.settings = settings;
    for (const { terminal } of this.sessions) Object.assign(terminal.options, this.options());
    this.fit();
  }
  show(tab: PanelTab = 'terminal') {
    this.visible = true; this.tab = tab; this.panel.classList.remove('hidden');
    for (const name of ['terminal', 'output', 'problems'] as const) { document.querySelector(`#${name}-content`)!.classList.toggle('hidden', tab !== name); document.querySelector(`#${name}-tab`)!.classList.toggle('active', tab === name); }
    if (tab === 'terminal') { this.fit(); this.active?.terminal.focus(); }
  }
  hide() { this.visible = false; this.panel.classList.add('hidden'); this.onHide(); }
  toggle() { if (this.visible && this.tab === 'terminal') this.hide(); else { this.show(); if (!this.sessions.length) void this.create().catch(report); } }
  async create(name?: string) {
    if (this.starting) return;
    this.starting = true; const sequence = this.startSequence; this.show();
    let terminal: Terminal | null = null; let host: HTMLElement | null = null;
    try {
      const session: Session = { id: 0, name: name ?? `${t('Consola')} ${this.sessions.length + 1}`, terminal: null!, fit: new FitAddon(), host: raw('div', 'terminal-instance'), exited: false };
      session.terminal = terminal = new Terminal({ ...this.options(), allowProposedApi: false });
      session.host = host = raw('div', 'terminal-instance'); document.querySelector('#terminal-instances')!.append(host);
      terminal.loadAddon(session.fit); terminal.open(host);
      terminal.onSelectionChange(() => { if (this.settings.terminalCopyOnSelect && session.terminal.hasSelection()) void navigator.clipboard.writeText(session.terminal.getSelection()); });
      terminal.attachCustomKeyEventHandler(e => {
        if (e.type !== 'keydown' || !e.ctrlKey) return true;
        const key = e.key.toLowerCase();
        if (key === 'c' && session.terminal.hasSelection()) { void navigator.clipboard.writeText(session.terminal.getSelection()); session.terminal.clearSelection(); return false; }
        return key !== 'v'; // The native paste event reaches xterm by itself.
      });
      const channel = new Channel<TerminalEvent>();
      channel.onmessage = event => {
        if (sequence !== this.startSequence) return;
        if (event.kind === 'data') session.terminal.write(new Uint8Array(event.data));
        else { session.exited = true; session.terminal.writeln(`\r\n\x1b[90m[${t('Proceso terminado')}: ${event.code}]\x1b[0m`); this.renderTabs(); }
      };
      const pending: string[] = [];
      terminal.onData(data => { if (session.exited) return; if (!session.id) pending.push(data); else void call('terminal_write', { id: session.id, data }).catch(report); });
      const id = await call<number>('terminal_start', { channel, shell: this.settings.shell || null }); session.id = id;
      if (sequence !== this.startSequence) { await call('terminal_close', { id }); terminal.dispose(); host.remove(); return; }
      if (pending.length) await call('terminal_write', { id, data: pending.join('') });
      terminal.onResize(size => { if (!session.exited) void call('terminal_resize', { id, rows: size.rows, cols: size.cols }).catch(report); });
      this.sessions.push(session); this.activate(session);
    } catch (error) { terminal?.dispose(); host?.remove(); throw error; }
    finally { this.starting = false; }
  }
  /** Focuses the live console called `name`, or opens one that runs `command` (an agent CLI such as claude or codex). */
  async agent(name: string, command: string) {
    const session = this.sessions.find(s => s.name === name && !s.exited);
    if (session) { this.activate(session); return false; }
    await this.create(name);
    if (this.active?.name === name) await call('terminal_write', { id: this.active.id, data: `${command}\r` });
    return true;
  }
  /** Types a command into the active console, starting one if needed. */
  async run(command: string) {
    if (!this.active || this.active.exited) await this.create();
    this.show();
    if (this.active) await call('terminal_write', { id: this.active.id, data: `${command}\r` });
  }
  activate(session: Session) { this.active = session; this.sessions.forEach(s => s.host.classList.toggle('hidden', s !== session)); document.querySelector('#terminal-empty')!.classList.add('hidden'); this.renderTabs(); this.show(); }
  renderTabs() {
    const tabs = document.querySelector('#terminal-sessions')!; tabs.replaceChildren();
    for (const session of this.sessions) { const tab = textButton(session.name, () => this.activate(session), 'Terminal', session === this.active ? 'active' : ''); if (session.exited) tab.append(raw('span', 'muted', ` · ${t('fin')}`)); tabs.append(tab); }
  }
  fit() { if (this.active && this.visible && this.tab === 'terminal') { try { this.active.fit.fit(); } catch { /* Element may be hidden during a layout change. */ } } }
  log(text: string) { this.outputText = (this.outputText + `${new Date().toLocaleTimeString()}  ${text}\n`).slice(-100000); this.output.textContent = this.outputText; this.output.scrollTop = this.output.scrollHeight; }
  async closeActive() {
    if (!this.active) return;
    if (!this.active.exited && this.settings.terminalConfirmClose && !await ask({ title: '¿Cerrar esta terminal?', detail: 'Se cerrará el proceso de consola. Comprueba que no haya una tarea en curso.', input: false, confirm: 'Cerrar terminal' })) return;
    const session = this.active; await call('terminal_close', { id: session.id }); session.terminal.dispose(); session.host.remove(); this.sessions = this.sessions.filter(s => s !== session); this.active = null;
    if (this.sessions.length) this.activate(this.sessions[this.sessions.length - 1]); else { this.renderTabs(); document.querySelector('#terminal-empty')!.classList.remove('hidden'); }
  }
  reset() { this.startSequence++; this.sessions.forEach(s => { s.terminal.dispose(); s.host.remove(); }); this.sessions = []; this.active = null; this.renderTabs(); document.querySelector('#terminal-empty')!.classList.remove('hidden'); }
}
