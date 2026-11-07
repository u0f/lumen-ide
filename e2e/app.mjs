// End-to-end check of the real desktop build, driven over the WebView2 debug port.
// Usage: node e2e/app.mjs [path to lumen-ide.exe]
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve(process.argv[2] ?? 'src-tauri/target/release/lumen-ide.exe');
const shots = resolve('test-results'); mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'lumen e2e '));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

git('init', '-b', 'main'); git('config', 'user.name', 'Lumen e2e'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'core.autocrlf', 'false');
writeFileSync(join(root, 'hello.ts'), 'export const greeting: string = "hola";\nconsole.log(greeting);\n');
writeFileSync(join(root, 'README.md'), '# Proyecto\n\nTexto **fuerte**.\n');
writeFileSync(join(root, 'data.csv'), 'a,b\n1,2\n');
writeFileSync(join(root, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(join(root, 'merge.txt'), 'base\n');
git('add', '-A'); git('commit', '-m', 'Inicial');
git('switch', '-c', 'otra'); writeFileSync(join(root, 'merge.txt'), 'otra\n'); git('commit', '-am', 'Cambio en otra');
git('switch', 'main'); writeFileSync(join(root, 'merge.txt'), 'principal\n'); git('commit', '-am', 'Cambio en main');

// A clean profile keeps settings from a failed run out of this one.
rmSync(join(tmpdir(), 'lumen-e2e-profile'), { recursive: true, force: true });
const app = spawn(exe, [root], { stdio: 'ignore' });
let browser, failed = 0, passed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`); };
const step = async (name, run) => { try { const value = await run(); check(name, value !== false); } catch (error) { check(name, false, String(error).split('\n')[0]); await page?.screenshot({ path: join(shots, `fail-${passed + failed}.png`) }).catch(() => {}); } };
let page;
try {
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch { await new Promise(r => setTimeout(r, 500)); } }
  if (!browser) throw new Error('Could not attach to WebView2');
  page = browser.contexts()[0].pages()[0];
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const key = async combo => { await page.keyboard.press(combo); await page.waitForTimeout(250); };
  const palette = async text => { await key('Control+Shift+P'); await page.keyboard.type(text); await page.waitForTimeout(250); await key('Enter'); };
  const tree = name => page.locator(`.tree-row[title="${name}"]`);

  await step('opens workspace from argv', () => page.locator('.tree-row', { hasText: 'hello.ts' }).waitFor({ timeout: 15000 }));
  await step('status bar shows branch', () => page.locator('#status-left', { hasText: 'main' }).waitFor({ timeout: 5000 }));
  await page.screenshot({ path: join(shots, '1-opened.png') });

  await step('opens file in Monaco', async () => { await tree('hello.ts').click(); await page.locator('.view-line', { hasText: 'greeting' }).first().waitFor({ timeout: 10000 }); });
  await step('TS syntax highlighting', async () => { await page.waitForFunction(() => document.querySelector('.view-line span span[class*="mtk"]:not(.mtk1)'), null, { timeout: 15000 }); });
  await step('TS completions from worker', async () => {
    await page.locator('#code-editor .view-lines').click(); await key('Control+End'); await page.keyboard.type('consol'); await key('Control+Space');
    await page.locator('.suggest-widget .monaco-list-row').first().waitFor({ timeout: 15000 }); await key('Escape');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  });
  await step('edit marks tab dirty, save clears and writes disk', async () => {
    await key('Control+End'); await page.keyboard.type('// editado'); await page.locator('.tab-close.dirty').waitFor({ timeout: 3000 });
    await key('Control+S'); await page.locator('.tab-close.dirty').waitFor({ state: 'detached', timeout: 3000 });
    return readFileSync(join(root, 'hello.ts'), 'utf8').includes('// editado');
  });
  await step('external change reloads clean tab', async () => {
    writeFileSync(join(root, 'hello.ts'), 'export const fuera = 1;\n');
    await page.locator('.view-line', { hasText: 'fuera' }).first().waitFor({ timeout: 8000 });
    git('checkout', 'hello.ts'); await page.waitForTimeout(100);
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.locator('.view-line', { hasText: 'greeting' }).first().waitFor({ timeout: 8000 });
  });
  await step('save conflict dialog when disk changed under edits', async () => {
    await page.locator('#code-editor .view-lines').click(); await key('Control+End'); await page.keyboard.type('// local');
    writeFileSync(join(root, 'hello.ts'), 'export const otro = 2;\n'); await key('Control+S');
    await page.getByRole('heading', { name: 'El archivo cambió en disco' }).waitFor({ timeout: 4000 });
    await page.getByRole('button', { name: 'Usar versión del disco' }).click();
    await page.locator('.view-line', { hasText: 'otro' }).first().waitFor({ timeout: 4000 }); git('checkout', 'hello.ts');
  });
  await step('git gutter decoration after edit', async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.locator('.view-line', { hasText: 'greeting' }).first().waitFor({ timeout: 8000 });
    await page.locator('#code-editor .view-lines').click(); await key('Control+Home'); await page.keyboard.type('// top\n'); await key('Control+S');
    await page.locator('.gutter-added, .gutter-modified').first().waitFor({ timeout: 6000 });
  });
  await step('quick open finds file', async () => { await key('Control+P'); await page.keyboard.type('READ'); await page.locator('.palette-row', { hasText: 'README.md' }).waitFor({ timeout: 3000 }); await key('Enter'); await page.locator('.editor-tab.active', { hasText: 'README.md' }).waitFor({ timeout: 4000 }); });
  await step('markdown preview', async () => { await key('Control+Shift+V'); await page.locator('.markdown-body strong', { hasText: 'fuerte' }).waitFor({ timeout: 6000 }); });
  await step('image preview', async () => { await tree('tiny.png').click(); await page.waitForFunction(() => document.querySelector('.preview-image')?.naturalWidth === 1, null, { timeout: 6000 }); });
  await step('csv preview', async () => { await tree('data.csv').click(); await page.locator('.editor-tab.active', { hasText: 'data.csv' }).waitFor({ timeout: 4000 }); await key('Control+Shift+V'); await page.locator('.csv-table td', { hasText: '2' }).waitFor({ timeout: 6000 }); });
  await step('command palette lists Monaco actions', async () => { await key('Control+Shift+P'); await page.keyboard.type('fold all'); await page.locator('.palette-row').first().waitFor({ timeout: 3000 }); await key('Escape'); });
  await page.screenshot({ path: join(shots, '2-editor.png') });

  await step('search across files', async () => { await key('Control+Shift+F'); await page.locator('#search-content input').first().fill('Proyecto'); await page.locator('.search-result').first().waitFor({ timeout: 5000 }); });
  await step('replace across files', async () => {
    await page.locator('#search-content input').nth(1).fill('Lumen');
    await page.getByRole('button', { name: 'Reemplazar todo' }).click(); await page.locator('dialog .danger-button').click();
    await page.locator('.toast', { hasText: 'reemplazos' }).waitFor({ timeout: 5000 });
    return readFileSync(join(root, 'README.md'), 'utf8').startsWith('# Lumen');
  });

  await step('terminal runs a command in the workspace', async () => {
    await key('Control+J'); await page.locator('.xterm-rows').waitFor({ timeout: 15000 }); await page.waitForTimeout(2500);
    await page.keyboard.type('Set-Content -Path desde-terminal.txt -Value hola\r');
    for (let i = 0; i < 40 && !existsSync(join(root, 'desde-terminal.txt')); i++) await page.waitForTimeout(250);
    if (!existsSync(join(root, 'desde-terminal.txt'))) throw new Error('command did not create file');
  });
  await step('explorer follows file created by terminal', async () => { await key('Control+Shift+E'); await tree('desde-terminal.txt').waitFor({ timeout: 9000 }); });
  await page.screenshot({ path: join(shots, '3-terminal.png') });

  await step('SCM lists changes with diff', async () => {
    await key('Control+Shift+G'); await page.locator('.change-row', { hasText: 'desde-terminal.txt' }).waitFor({ timeout: 6000 });
    await page.locator('.change-name', { hasText: 'README.md' }).click(); await page.locator('#diff-editor .editor.modified .view-line', { hasText: 'Lumen' }).first().waitFor({ timeout: 6000 });
  });
  await page.screenshot({ path: join(shots, '4-diff.png') });
  await step('stage and commit from panel', async () => {
    await page.locator('.change-row', { hasText: 'desde-terminal.txt' }).hover(); await page.locator('.change-row', { hasText: 'desde-terminal.txt' }).getByRole('button', { name: 'Preparar archivo' }).click();
    await page.locator('.section-heading', { hasText: 'Preparados' }).waitFor({ timeout: 5000 });
    await page.locator('.commit-composer textarea').fill('Añade archivo'); await page.locator('.commit-row button').first().click();
    await page.locator('.section-heading', { hasText: 'Preparados' }).waitFor({ state: 'detached', timeout: 6000 });
    return git('log', '-1', '--format=%s').trim() === 'Añade archivo';
  });
  await step('discard change', async () => {
    const row = page.locator('.change-row', { hasText: 'README.md' }); await row.hover(); await row.getByRole('button', { name: 'Descartar cambios' }).click(); await page.locator('dialog .danger-button').click();
    await row.waitFor({ state: 'detached', timeout: 6000 }); return readFileSync(join(root, 'README.md'), 'utf8').startsWith('# Proyecto');
  });
  await step('commit all (smart commit)', async () => {
    await page.locator('.commit-composer textarea').fill('Comenta'); await page.locator('.commit-row button').first().click(); await page.locator('dialog .primary').click();
    await page.waitForFunction(() => document.querySelector('.clean-state'), null, { timeout: 6000 });
  });
  await step('history graph and commit files', async () => {
    await page.locator('.scm-tabs button', { hasText: 'Historial' }).click(); await page.locator('.history-row', { hasText: 'Comenta' }).click();
    await page.locator('.commit-file', { hasText: 'hello.ts' }).waitFor({ timeout: 5000 }); return await page.locator('.graph circle').count() >= 4;
  });
  await page.screenshot({ path: join(shots, '5-history.png') });
  await step('branches view lists sections', async () => { await page.locator('.scm-tabs button', { hasText: 'Ramas' }).click(); await page.locator('.branch-row', { hasText: 'otra' }).waitFor({ timeout: 5000 }); });
  await step('merge conflict flow with CodeLens', async () => {
    await page.locator('.branch-row', { hasText: 'otra' }).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Fusionar en la rama actual' }).click();
    await page.locator('.toast.error', { hasText: 'CONFLICT' }).first().waitFor({ timeout: 6000 }); await page.locator('.toast.error button').first().click();
    await page.locator('.scm-tabs button', { hasText: 'Cambios' }).click(); await page.locator('.conflict-banner').waitFor({ timeout: 6000 });
    await page.locator('.change-name', { hasText: 'merge.txt' }).click(); await page.locator('.codelens-decoration a', { hasText: 'Aceptar entrante' }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: join(shots, '6-conflict.png') });
    await page.locator('.codelens-decoration a', { hasText: 'Aceptar entrante' }).click(); await page.waitForTimeout(300); await key('Control+S');
    if (readFileSync(join(root, 'merge.txt'), 'utf8').trim() !== 'otra') throw new Error('conflict not resolved');
    const row = page.locator('.change-row', { hasText: 'merge.txt' }); await row.hover(); await row.getByRole('button', { name: 'Marcar como resuelto' }).click();
    await page.locator('.commit-composer textarea').waitFor(); await page.getByRole('button', { name: 'Continuar' }).click();
    await page.locator('.conflict-banner').waitFor({ state: 'detached', timeout: 6000 });
    return git('status', '--porcelain').trim() === '' && git('log', '-1', '--format=%p').trim().split(' ').length === 2;
  });
  await step('Ctrl+J toggles the console', async () => {
    await key('Control+J'); await page.locator('#bottom-panel').waitFor({ state: 'hidden', timeout: 3000 });
    await key('Control+J'); await page.locator('#bottom-panel').waitFor({ state: 'visible', timeout: 3000 }); await key('Control+J');
  });
  await step('settings open in their own tab', async () => { await key('Control+,'); await page.locator('.editor-tab.active', { hasText: 'Ajustes' }).waitFor({ timeout: 3000 }); await page.locator('.settings-page').waitFor({ timeout: 3000 }); });
  await page.screenshot({ path: join(shots, '7-settings.png') });
  await step('theme setting applies and resets', async () => {
    await page.getByRole('combobox', { name: 'Tema' }).selectOption('light');
    const theme = await page.evaluate(() => document.documentElement.dataset.theme); await page.screenshot({ path: join(shots, '7-settings-light.png') });
    await page.locator('.setting-row[data-key="theme"] .setting-reset').click();
    return theme === 'light' && await page.evaluate(() => document.documentElement.dataset.theme) === 'dark';
  });
  await step('search filters settings across categories', async () => {
    await page.locator('.settings-search input').fill('cursor'); await page.locator('.setting-row[data-key="terminalCursorStyle"]').waitFor({ timeout: 3000 });
    await page.locator('.setting-row[data-key="cursorBlinking"]').waitFor({ timeout: 3000 }); await page.locator('.settings-search input').fill('');
  });
  await step('Monaco option reaches the editor', async () => {
    await page.locator('.settings-category', { hasText: 'Cursor y edición' }).click(); await page.getByRole('combobox', { name: 'Forma del cursor' }).first().selectOption('block');
    await page.locator('.editor-tab', { hasText: 'hello.ts' }).click(); await page.waitForTimeout(300);
    const block = await page.locator('#code-editor .cursors-layer.cursor-block-style').count();
    await key('Control+,'); await page.locator('.setting-row[data-key="cursorStyle"] .setting-reset').click(); return block > 0;
  });
  await step('shortcut can be rebound', async () => {
    await page.locator('.settings-category', { hasText: 'Atajos de teclado' }).click();
    const row = page.locator('.shortcut-row', { hasText: 'Mostrar u ocultar terminal' });
    await row.locator('.key-chip').click(); await page.keyboard.press('Control+Alt+T'); await page.waitForTimeout(200);
    await row.locator('.key-chip', { hasText: 'Ctrl+Alt+T' }).waitFor({ timeout: 2000 });
    await key('Control+Alt+T'); await page.locator('#bottom-panel').waitFor({ state: 'visible', timeout: 3000 }); await key('Control+Alt+T');
    await row.hover(); await row.locator('.setting-reset').click(); await row.locator('.key-chip', { hasText: 'Ctrl+J' }).waitFor({ timeout: 2000 });
  });
  await step('settings survive reload', async () => {
    await page.locator('.settings-category', { hasText: 'Ventana' }).click(); await page.locator('.setting-row[data-key="showBreadcrumbs"] .switch').click();
    await page.reload(); await page.locator('.editor-tab.active').waitFor({ timeout: 15000 }); await page.waitForTimeout(1500);
    const hidden = await page.evaluate(() => document.documentElement.classList.contains('no-breadcrumbs'));
    await key('Control+,'); await page.locator('.setting-row[data-key="showBreadcrumbs"] .setting-reset').click(); await key('Control+W'); return hidden;
  });
  await step('tabs show the folder only for duplicate names', async () => {
    mkdirSync(join(root, 'sub')); writeFileSync(join(root, 'sub', 'hello.ts'), 'export const b = 2;\n'); await key('Control+Shift+E');
    await tree('hello.ts').click(); await page.locator('.editor-tab.active', { hasText: 'hello.ts' }).waitFor({ timeout: 4000 });
    if (await page.locator('.editor-tab.active small').count()) throw new Error('folder shown without a twin');
    await page.locator('.tree-row', { hasText: 'sub' }).click(); await page.locator('.tree-row', { hasText: 'hello.ts' }).first().waitFor();
    await page.locator('.tree-row[title="sub/hello.ts"]').click(); await page.locator('.editor-tab.active small', { hasText: 'sub' }).waitFor({ timeout: 4000 });
    await key('Control+W');
  });
  await step('diff tab shows only the file name', async () => {
    writeFileSync(join(root, 'sub', 'hello.ts'), 'export const b = 3;\n'); await key('Control+Shift+G');
    await page.locator('.change-name', { hasText: 'hello.ts' }).click(); await page.locator('.diff-tab').waitFor({ timeout: 5000 });
    const text = await page.locator('.diff-tab span').innerText(); await key('Control+W'); if (text.includes('/')) throw new Error(text);
  });
  await step('split shows two files and edits each', async () => {
    await key('Control+Shift+E'); await tree('README.md').click(); await page.locator('.editor-tab.active', { hasText: 'README.md' }).waitFor({ timeout: 4000 });
    await key('Control+\\'); await page.locator('#split-editor .monaco-editor').waitFor({ timeout: 4000 });
    await tree('hello.ts').click(); await page.locator('#split-editor .view-line', { hasText: 'greeting' }).first().waitFor({ timeout: 4000 });
    await page.locator('#left-pane .view-line', { hasText: 'Proyecto' }).first().waitFor({ timeout: 4000 });
    await page.screenshot({ path: join(shots, '9-split.png') });
    await page.locator('#left-pane .view-lines').click(); await key('Control+End'); await page.keyboard.type('izquierda'); await key('Control+S');
    await page.locator('#split-editor .view-lines').click(); await key('Control+End'); await page.keyboard.type('// derecha'); await key('Control+S');
    await page.waitForTimeout(400);
    if (!readFileSync(join(root, 'README.md'), 'utf8').includes('izquierda')) throw new Error('left pane not saved');
    if (!readFileSync(join(root, 'hello.ts'), 'utf8').includes('// derecha')) throw new Error('right pane not saved');
    await page.locator('.editor-tab', { hasText: 'data.csv' }).first().click(); await page.locator('#split-editor .view-line', { hasText: '1,2' }).first().waitFor({ timeout: 4000 });
    await page.locator('#right-pane .pane-close').click(); await page.locator('#right-pane').waitFor({ state: 'hidden', timeout: 3000 });
    await page.locator('.editor-tab.active', { hasText: 'README.md' }).waitFor({ timeout: 3000 });
  });
  await step('inline blame is visible', async () => {
    git('add', '-A'); git('commit', '-m', 'Para blame');
    await tree('merge.txt').click(); await page.locator('.blame-text').first().waitFor({ timeout: 6000 });
    const text = await page.locator('.blame-text').first().innerText(); await page.screenshot({ path: join(shots, '10-blame.png') });
    await page.locator('#status-left', { hasText: 'Lumen e2e' }).waitFor({ timeout: 3000 }); return text.replace(/\s+/g, ' ').includes('Lumen e2e');
  });
  await step('tasks picker reads project tasks', async () => {
    writeFileSync(join(root, 'package.json'), '{"scripts":{"hola":"echo hola"}}'); await key('Control+Shift+B'); await page.locator('.palette-row', { hasText: 'npm: hola' }).waitFor({ timeout: 4000 }); await key('Escape'); rmSync(join(root, 'package.json'));
  });
  await step('Escape never empties the interface', async () => {
    await tree('hello.ts').click(); await key('Escape'); await key('Control+Shift+P'); await key('Escape'); await key('Escape');
    await page.locator('#menubar button').first().click(); await key('Escape'); await key('Control+,'); await key('Escape'); await key('Control+W');
    return await page.locator('#workbench').isVisible();
  });
  await step('recovers from an aborted page load', async () => {
    await page.reload({ waitUntil: 'commit' }); await page.evaluate(() => window.stop()).catch(() => {});
    await page.locator('#workbench').waitFor({ timeout: 20000 }); await page.locator('.tree-row').first().waitFor({ timeout: 15000 });
  });
  await step('no page errors', () => { const real = errors.filter(e => !/ResizeObserver|^Canceled|CONFLICT/.test(e)); if (real.length) throw new Error(JSON.stringify(real.slice(0, 4))); });
  await page.screenshot({ path: join(shots, '8-final.png') });
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  await browser?.close().catch(() => {});
  app.kill();
  process.exitCode = failed ? 1 : 0;
}
