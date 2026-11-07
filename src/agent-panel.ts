import { Channel } from '@tauri-apps/api/core';
import { call } from './api';
import { t } from './i18n';
import { button, el, icon, quickPick, raw, report, textButton } from './ui';

export type Agent = 'claude' | 'codex';
type AgentEvent = { kind: 'line'; line: string } | { kind: 'done'; code: number; error: string };
interface Entry { role: 'user' | 'assistant' | 'tool' | 'error' | 'info'; text: string }
interface Chat { id: string; title: string; time: number }
const NAMES: Record<Agent, string> = { claude: 'Claude', codex: 'Codex' };
const MODES = [['read', 'Solo lectura'], ['edit', 'Editar archivos'], ['full', 'Acceso total']] as const;
type Json = Record<string, any>;

let markdown: Promise<(text: string) => string> | null = null;
const renderMarkdown = () => markdown ??= Promise.all([import('marked'), import('dompurify')]).then(([{ marked }, { default: DOMPurify }]) => (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string));

function summary(name: string, input: Json = {}) {
  const detail = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'].map(k => input[k]).find(v => typeof v === 'string') ?? '';
  return detail ? `${name}: ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : name;
}

/** Chat over the Claude Code and Codex CLIs. Each turn runs the CLI once and resumes the session, so the panel costs nothing while idle. */
export class AgentPanel {
  agent: Agent = 'claude';
  visible = false;
  onChanged: () => void = () => {};
  private sessions: Record<Agent, string | null> = { claude: null, codex: null };
  private entries: Record<Agent, Entry[]> = { claude: [], codex: [] };
  private runs: Record<Agent, number | null> = { claude: null, codex: null };
  private mode = (() => { try { return localStorage.getItem('lumen.agentMode') ?? 'edit'; } catch { return 'edit'; } })();
  private host = document.querySelector('#agent-panel') as HTMLElement;
  private log!: HTMLElement;
  private input!: HTMLTextAreaElement;

  toggle(agent: Agent) { if (this.visible && this.agent === agent) this.close(); else this.open(agent); }
  open(agent: Agent) { this.agent = agent; this.visible = true; this.host.classList.remove('hidden'); document.querySelector('#agent-sash')!.classList.remove('hidden'); this.render(); this.input.focus(); }
  close() { this.visible = false; this.host.classList.add('hidden'); document.querySelector('#agent-sash')!.classList.add('hidden'); }
  /** A new folder means other sessions: forget the current chats. */
  reset() { for (const agent of Object.keys(NAMES) as Agent[]) { if (this.runs[agent]) void call('agent_stop', { id: this.runs[agent] }); this.runs[agent] = null; this.sessions[agent] = null; this.entries[agent] = []; } if (this.visible) this.render(); }
  /** Adds text to the prompt, e.g. a file reference from the editor. */
  insert(agent: Agent, text: string) { this.open(agent); const { selectionStart: start, value } = this.input; this.input.value = value.slice(0, start) + text + value.slice(start); this.input.focus(); }

  render() {
    this.host.replaceChildren();
    const header = raw('div', 'agent-header');
    for (const agent of Object.keys(NAMES) as Agent[]) header.append(textButton(NAMES[agent], () => this.open(agent), undefined, `agent-tab ${agent === this.agent ? 'active' : ''}`));
    header.append(raw('span', 'spacer'), button('Nuevo chat', () => this.newChat(), 'Plus'), button('Chats anteriores', () => this.pickChat(), 'History'), button('Cerrar', () => this.close(), 'X'));
    this.log = raw('div', 'agent-log');
    if (!this.entries[this.agent].length) { const empty = raw('div', 'agent-empty'); empty.append(icon('Sparkles'), el('p', '', `Pregunta a ${NAMES[this.agent]} sobre este proyecto.`), el('small', 'muted', 'Usa la CLI instalada con tu propia cuenta. Clic derecho en el editor para enviar líneas.')); this.log.append(empty); }
    for (const entry of this.entries[this.agent]) void this.paint(entry);
    const composer = raw('div', 'agent-composer');
    this.input = raw('textarea'); this.input.rows = 3; this.input.placeholder = t(`Escribe a ${NAMES[this.agent]}… (Enter envía, Mayús+Enter salto)`); this.input.setAttribute('aria-label', this.input.placeholder);
    this.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send().catch(report); } });
    const mode = raw('select'); mode.setAttribute('aria-label', t('Permisos'));
    for (const [value, label] of MODES) { const option = raw('option', '', t(label)); option.value = value; mode.append(option); }
    mode.value = this.mode; mode.addEventListener('change', () => { this.mode = mode.value; try { localStorage.setItem('lumen.agentMode', mode.value); } catch { /* optional */ } });
    const busy = this.runs[this.agent] !== null;
    const row = raw('div', 'agent-row'); row.append(mode, busy ? textButton('Detener', () => this.stop(), 'X', 'secondary') : textButton('Enviar', () => this.send(), 'ArrowUp', 'primary'));
    composer.append(this.input, row);
    this.host.append(header, this.log, composer);
    if (busy) this.log.append(raw('div', 'agent-thinking', t('Trabajando…')));
    this.log.scrollTop = this.log.scrollHeight;
  }
  private async paint(entry: Entry) {
    // Awaiting for every entry keeps them in order even before the markdown module has loaded.
    const toHtml = await renderMarkdown(); const node = raw('div', `agent-msg ${entry.role}`);
    if (entry.role === 'assistant') node.innerHTML = toHtml(entry.text); else node.textContent = entry.text;
    const thinking = this.log.querySelector('.agent-thinking');
    this.log.insertBefore(node, thinking); this.log.scrollTop = this.log.scrollHeight;
  }
  private add(agent: Agent, entry: Entry) { this.entries[agent].push(entry); if (this.visible && this.agent === agent) { this.log.querySelector('.agent-empty')?.remove(); void this.paint(entry); } }

  newChat() { if (this.runs[this.agent]) return; this.sessions[this.agent] = null; this.entries[this.agent] = []; this.render(); this.input.focus(); }
  async pickChat() {
    const agent = this.agent; const chats = await call<Chat[]>('agent_chats', { agent });
    if (!chats.length) { this.add(agent, { role: 'info', text: t('Todavía no hay chats de este proyecto.') }); return; }
    quickPick('Chats anteriores', chats.map(chat => ({ label: chat.title, detail: new Date(chat.time * 1000).toLocaleString(), run: () => this.load(agent, chat.id) })));
  }
  async load(agent: Agent, id: string) {
    if (this.runs[agent]) return;
    const messages = await call<Entry[]>('agent_history', { agent, id });
    this.sessions[agent] = id; this.entries[agent] = messages.slice(-200); this.open(agent);
  }
  async stop() { const id = this.runs[this.agent]; if (id) await call('agent_stop', { id }); }

  async send() {
    const agent = this.agent, prompt = this.input.value.trim();
    if (!prompt || this.runs[agent]) return;
    this.input.value = ''; this.add(agent, { role: 'user', text: prompt });
    const channel = new Channel<AgentEvent>();
    channel.onmessage = event => {
      if (event.kind === 'line') { this.handle(agent, event.line); return; }
      if (event.code !== 0) this.add(agent, { role: 'error', text: event.error.trim() || `${NAMES[agent]} terminó con código ${event.code}` });
      this.runs[agent] = null; if (this.visible && this.agent === agent) this.render(); this.onChanged();
    };
    try { this.runs[agent] = await call<number>('agent_send', { channel, agent, prompt, session: this.sessions[agent], mode: this.mode }); }
    catch (error) { this.add(agent, { role: 'error', text: String(error) }); }
    if (this.visible && this.agent === agent) this.render();
  }
  /** Turns one JSON line from the CLI into chat entries. */
  private handle(agent: Agent, line: string) {
    let event: Json; try { event = JSON.parse(line); } catch { return; }
    if (agent === 'claude') {
      if (event.session_id) this.sessions.claude = event.session_id;
      if (event.type === 'assistant') for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) this.add(agent, { role: 'assistant', text: block.text });
        if (block.type === 'tool_use') this.add(agent, { role: 'tool', text: summary(block.name, block.input) });
      }
      if (event.type === 'result') {
        if (event.is_error) this.add(agent, { role: 'error', text: String(event.result ?? event.subtype) });
        const parts = [event.duration_ms ? `${Math.round(event.duration_ms / 1000)} s` : '', typeof event.total_cost_usd === 'number' ? `$${event.total_cost_usd.toFixed(3)}` : ''].filter(Boolean);
        if (parts.length) this.add(agent, { role: 'info', text: parts.join(' · ') });
      }
      return;
    }
    if (event.type === 'thread.started') this.sessions.codex = event.thread_id;
    const item = event.item ?? {};
    if (event.type === 'item.completed') {
      if (item.type === 'agent_message') this.add(agent, { role: 'assistant', text: item.text ?? '' });
      else if (item.type === 'command_execution') this.add(agent, { role: 'tool', text: `Shell: ${String(item.command ?? '').slice(0, 160)}${item.exit_code ? ` (${item.exit_code})` : ''}` });
      else if (item.type === 'file_change') this.add(agent, { role: 'tool', text: `Edit: ${(item.changes ?? []).map((c: Json) => c.path).join(', ')}` });
      else if (item.type === 'web_search') this.add(agent, { role: 'tool', text: `Web: ${item.query ?? ''}` });
      else if (item.type === 'mcp_tool_call') this.add(agent, { role: 'tool', text: `${item.server ?? 'MCP'}: ${item.tool ?? ''}` });
      else if (item.type === 'error') this.add(agent, { role: 'error', text: item.message ?? '' });
    }
    if (event.type === 'turn.failed' || event.type === 'error') this.add(agent, { role: 'error', text: event.error?.message ?? event.message ?? 'Error' });
    if (event.type === 'turn.completed' && event.usage) this.add(agent, { role: 'info', text: `${event.usage.input_tokens ?? 0} → ${event.usage.output_tokens ?? 0} tokens` });
  }
}
