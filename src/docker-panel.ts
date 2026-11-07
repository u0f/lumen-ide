import { call } from './api';
import { ask, button, el, icon, menu, raw, separator, toast, type MenuItem } from './ui';

interface Container { id: string; name: string; image: string; state: string; status: string; ports: string }

/** Lists containers through the docker CLI. It only polls while the view is visible, so it costs nothing otherwise. */
export class DockerPanel {
  containers: Container[] = [];
  error = '';
  visible = false;
  onOutput: (text: string) => void = () => {};
  onRun: (command: string) => Promise<void> = async () => {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = '';

  show(visible: boolean) { this.visible = visible; clearTimeout(this.timer); if (visible) void this.poll(); }
  private async poll() {
    if (!document.hidden) await this.refresh();
    if (this.visible) this.timer = setTimeout(() => this.poll(), 5000);
  }
  async refresh() {
    try { this.containers = await call<Container[]>('docker_list'); this.error = ''; }
    catch (error) { this.containers = []; this.error = String(error); }
    const snapshot = JSON.stringify([this.containers, this.error]);
    if (snapshot !== this.last) { this.last = snapshot; this.render(); }
  }
  private async action(action: string, container: Container) {
    await call('docker_action', { action, id: container.id }); toast('Docker actualizado'); await this.refresh();
  }
  private items(c: Container): MenuItem[] {
    const running = c.state === 'running', paused = c.state === 'paused';
    return [
      ...(running ? [{ label: 'Detener', action: () => this.action('stop', c) }, { label: 'Pausar', action: () => this.action('pause', c) }] : paused ? [{ label: 'Reanudar', action: () => this.action('unpause', c) }] : [{ label: 'Iniciar', action: () => this.action('start', c) }]),
      { label: 'Reiniciar', action: () => this.action('restart', c) },
      separator,
      { label: 'Ver logs', action: async () => this.onOutput(`docker logs ${c.name}\n${await call<string>('docker_logs', { id: c.id })}`) },
      { label: 'Seguir logs en terminal', action: () => this.onRun(`docker logs -f --tail 200 ${c.id}`) },
      ...(running ? [{ label: 'Abrir shell', action: () => this.onRun(`docker exec -it ${c.id} sh`) }] : []),
      separator,
      { label: 'Copiar ID', action: () => navigator.clipboard.writeText(c.id) },
      { label: 'Eliminar contenedor…', danger: true, action: async () => { if (await ask({ title: `¿Eliminar ${c.name}?`, detail: 'Se forzará la parada y se borrará el contenedor. Los volúmenes se conservan.', input: false, confirm: 'Eliminar', danger: true })) await this.action('rm', c); } },
    ];
  }
  render() {
    const host = document.querySelector('#docker-content')!; host.replaceChildren();
    if (this.error || !this.containers.length) {
      const empty = raw('div', 'empty-sidebar'); empty.append(icon('Container'), el('h3', '', this.error ? 'Docker no disponible' : 'Sin contenedores'));
      if (this.error) empty.append(raw('p', '', this.error)); host.append(empty); return;
    }
    const groups = [['En ejecución', this.containers.filter(c => c.state === 'running')], ['Detenidos', this.containers.filter(c => c.state !== 'running')]] as const;
    for (const [title, list] of groups) {
      if (!list.length) continue;
      const heading = raw('div', 'section-heading'); heading.append(el('span', '', title), raw('span', 'count', String(list.length))); host.append(heading);
      for (const c of list) {
        const row = button(`${c.image} · ${c.status}${c.ports ? ` · ${c.ports}` : ''}`, () => {}, 'Container', `docker-row ${c.state}`);
        row.append(raw('span', '', c.name), raw('small', '', c.status));
        const open = (e: MouseEvent) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, this.items(c)); };
        row.addEventListener('contextmenu', open); row.addEventListener('click', open);
        host.append(row);
      }
    }
  }
}
