import { call } from './api';
import { button, el, raw, textButton } from './ui';

const images = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'];
const audio = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];
const video = ['mp4', 'webm', 'mov', 'mkv'];
const extension = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';
/** Files with no useful text form open straight in the preview. */
export const binaryPreview = (path: string) => [...images, ...audio, ...video, 'pdf'].includes(extension(path));
export const textPreview = (path: string) => ['md', 'markdown', 'csv', 'tsv', 'svg'].includes(extension(path));
const MIME: Record<string, string> = { svg: 'image/svg+xml', ico: 'image/x-icon', jpg: 'image/jpeg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mov: 'video/quicktime' };

async function bytes(path: string, limit?: number) { return new Uint8Array(await call<ArrayBuffer>('read_binary', { path, limit })); }
async function blobUrl(path: string) {
  const ext = extension(path); const family = audio.includes(ext) ? 'audio' : video.includes(ext) ? 'video' : 'image';
  return URL.createObjectURL(new Blob([await bytes(path) as BlobPart], { type: MIME[ext] ?? `${family}/${ext}` }));
}
async function markdown(host: HTMLElement, text: string) {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]);
  const body = raw('article', 'markdown-body'); body.innerHTML = DOMPurify.sanitize(await marked.parse(text));
  // Links must not navigate the app window away.
  body.addEventListener('click', e => { if ((e.target as HTMLElement).closest('a')) e.preventDefault(); });
  host.append(body);
}
async function table(host: HTMLElement, text: string, path: string) {
  const { default: Papa } = await import('papaparse');
  const rows = Papa.parse<string[]>(text, { preview: 500, delimiter: extension(path) === 'tsv' ? '\t' : '' }).data;
  const grid = raw('table', 'csv-table'); const body = raw('tbody');
  rows.forEach((row, index) => { const line = raw('tr'); for (const cell of row) line.append(raw(index ? 'td' : 'th', '', cell)); body.append(line); });
  grid.append(body); host.append(grid);
  if (rows.length === 500) host.append(el('p', 'muted preview-note', 'La tabla muestra las primeras 500 filas.'));
}
async function pdf(host: HTMLElement, path: string) {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const file = await pdfjs.getDocument({ data: await bytes(path) }).promise;
  let page = 1, scale = 1.25, painting: { cancel(): void } | null = null;
  const canvas = raw('canvas', 'pdf-page'); const label = raw('span', 'muted');
  const paint = async () => {
    painting?.cancel(); label.textContent = `${page} / ${file.numPages}`;
    const current = await file.getPage(page); const viewport = current.getViewport({ scale: scale * devicePixelRatio });
    canvas.width = viewport.width; canvas.height = viewport.height; canvas.style.width = `${viewport.width / devicePixelRatio}px`;
    const task = current.render({ canvas, viewport }); painting = task;
    await task.promise.catch(error => { if (error?.name !== 'RenderingCancelledException') throw error; });
  };
  const bar = raw('div', 'preview-bar');
  bar.append(textButton('Anterior', () => { if (page > 1) { page--; return paint(); } }), label, textButton('Siguiente', () => { if (page < file.numPages) { page++; return paint(); } }), textButton('Reducir', () => { scale = Math.max(.5, scale - .25); return paint(); }), textButton('Ampliar', () => { scale = Math.min(4, scale + .25); return paint(); }));
  host.append(bar, canvas); await paint();
}
async function hex(host: HTMLElement, path: string) {
  const limit = 64 * 1024; const data = await bytes(path, limit); const lines: string[] = [];
  for (let at = 0; at < data.length; at += 16) {
    const row = data.subarray(at, at + 16);
    lines.push(`${at.toString(16).padStart(8, '0')}  ${[...row].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${[...row].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')}`);
  }
  host.append(raw('pre', 'hex-view', lines.join('\n')));
  if (data.length === limit) host.append(el('p', 'muted preview-note', 'Se muestran los primeros 64 KB.'));
}
export async function renderPreview(host: HTMLElement, path: string, text: string | undefined, openText: () => unknown) {
  const ext = extension(path); host.replaceChildren();
  const content = raw('div', 'preview-content');
  host.append(content);
  try {
    if (['md', 'markdown', 'csv', 'tsv'].includes(ext)) {
      const source = text ?? await call<string>('read_file', { path });
      if (ext === 'csv' || ext === 'tsv') await table(content, source, path); else await markdown(content, source);
    } else if (ext === 'pdf') await pdf(content, path);
    else if (images.includes(ext) || ext === 'svg') { const image = raw('img', 'preview-image'); image.src = await blobUrl(path); image.alt = path; content.append(image); }
    else if (audio.includes(ext) || video.includes(ext)) {
      const media = raw(audio.includes(ext) ? 'audio' : 'video', 'preview-media'); media.controls = true; media.src = await blobUrl(path);
      media.addEventListener('error', () => content.append(el('p', 'muted preview-note', 'El sistema no dispone del códec necesario para este archivo.'))); content.append(media);
    } else { await hex(content, path); content.prepend(button('Abrir como texto', openText, 'FileCode2', 'preview-open')); }
  } catch (error) { content.append(raw('p', 'muted preview-note', String(error))); }
}
