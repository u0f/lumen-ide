import type * as monaco from 'monaco-editor';
import type { Icon } from './ui';

export type SettingValue = string | number | boolean;
export interface Setting {
  key: string; title: string; description: string; default: SettingValue;
  type: 'boolean' | 'number' | 'text' | 'select';
  options?: [string, string][]; min?: number; max?: number; step?: number; placeholder?: string;
  /** Monaco option path this value feeds; `true` means the key itself is the path. */
  monaco?: string | true;
  map?: (value: SettingValue) => unknown;
}
export interface Category { id: string; label: string; icon: Icon; settings: Setting[] }

const bool = (key: string, title: string, description: string, value: boolean, extra: Partial<Setting> = {}): Setting => ({ key, title, description, default: value, type: 'boolean', ...extra });
const num = (key: string, title: string, description: string, value: number, min: number, max: number, extra: Partial<Setting> = {}): Setting => ({ key, title, description, default: value, type: 'number', min, max, ...extra });
const text = (key: string, title: string, description: string, value: string, extra: Partial<Setting> = {}): Setting => ({ key, title, description, default: value, type: 'text', ...extra });
const pick = (key: string, title: string, description: string, value: string, options: [string, string][], extra: Partial<Setting> = {}): Setting => ({ key, title, description, default: value, type: 'select', options, ...extra });
const m = { monaco: true } as const;
const onOff: [string, string][] = [['on', 'Activado'], ['off', 'Desactivado']];

export const CATEGORIES: Category[] = [
  { id: 'window', label: 'Ventana', icon: 'PanelsTopLeft', settings: [
    pick('theme', 'Tema', 'Apariencia general del editor, la interfaz y la terminal.', 'dark', [['dark', 'Oscuro'], ['light', 'Claro'], ['system', 'Según el sistema']]),
    pick('locale', 'Idioma', 'Idioma de la interfaz. Lumen se recarga al cambiarlo.', 'es', [['es', 'Español'], ['en', 'English'], ['ca', 'Català']]),
    num('uiFontSize', 'Tamaño de la interfaz', 'Tamaño de letra de menús, paneles y barra de estado, en píxeles.', 13, 10, 20),
    bool('showActivityBar', 'Barra de actividad', 'Muestra la columna de iconos del lateral.', true),
    bool('showStatusBar', 'Barra de estado', 'Muestra la barra inferior con rama, errores y posición del cursor.', true),
    pick('sidebarPosition', 'Posición de la barra lateral', 'Lado de la ventana en el que aparece la barra lateral.', 'left', [['left', 'Izquierda'], ['right', 'Derecha']]),
    bool('showTabs', 'Pestañas de archivos', 'Muestra la fila de pestañas sobre el editor.', true),
    bool('showBreadcrumbs', 'Ruta de navegación', 'Muestra la ruta del archivo activo sobre el editor.', true),
    bool('restoreFolder', 'Reabrir última carpeta', 'Abre al iniciar la carpeta de la sesión anterior.', true),
    bool('restoreSession', 'Restaurar pestañas', 'Reabre los archivos que tenías abiertos en cada carpeta.', true),
  ] },
  { id: 'text', label: 'Texto y fuente', icon: 'Type', settings: [
    num('fontSize', 'Tamaño de letra', 'Tamaño de la letra del editor, en píxeles.', 14, 6, 72, m),
    text('fontFamily', 'Familia de fuente', 'Lista de fuentes del editor separadas por comas, por orden de preferencia.', "'Cascadia Code', 'Cascadia Mono', Consolas, monospace", m),
    pick('fontWeight', 'Grosor de fuente', 'Peso de la letra del editor.', 'normal', [['300', 'Fina'], ['normal', 'Normal'], ['500', 'Media'], ['600', 'Seminegrita'], ['bold', 'Negrita']], m),
    bool('fontLigatures', 'Ligaduras', 'Une secuencias como => o != en un solo glifo si la fuente lo admite.', false, m),
    num('lineHeight', 'Altura de línea', 'Altura de cada línea en píxeles. 0 la calcula a partir del tamaño de letra.', 0, 0, 100, m),
    num('letterSpacing', 'Espaciado entre letras', 'Espacio adicional entre caracteres, en píxeles.', 0, -5, 20, { ...m, step: 0.1 }),
    num('tabSize', 'Tamaño de tabulación', 'Número de espacios que ocupa un tabulador.', 4, 1, 16),
    bool('insertSpaces', 'Usar espacios', 'Inserta espacios al pulsar Tab en lugar de tabuladores.', true),
    bool('detectIndentation', 'Detectar sangría', 'Deduce tabulación y sangría del contenido de cada archivo al abrirlo.', true),
    pick('wordWrap', 'Ajuste de línea', 'Cómo se parten las líneas largas.', 'off', [['off', 'Sin ajuste'], ['on', 'Al ancho de la ventana'], ['wordWrapColumn', 'En la columna indicada'], ['bounded', 'Lo que ocurra antes']], m),
    num('wordWrapColumn', 'Columna de ajuste', 'Columna usada por los modos de ajuste por columna.', 80, 20, 400, m),
    pick('wrappingIndent', 'Sangría al ajustar', 'Sangría de las líneas partidas.', 'same', [['none', 'Ninguna'], ['same', 'Igual que la línea'], ['indent', 'Un nivel más'], ['deepIndent', 'Dos niveles más']], m),
  ] },
  { id: 'cursor', label: 'Cursor y edición', icon: 'TextCursorInput', settings: [
    pick('cursorStyle', 'Forma del cursor', 'Aspecto del cursor de texto.', 'line', [['line', 'Línea'], ['block', 'Bloque'], ['underline', 'Subrayado'], ['line-thin', 'Línea fina'], ['block-outline', 'Bloque hueco'], ['underline-thin', 'Subrayado fino']], m),
    pick('cursorBlinking', 'Parpadeo del cursor', 'Animación del cursor.', 'blink', [['blink', 'Parpadeo'], ['smooth', 'Suave'], ['phase', 'Fase'], ['expand', 'Expandir'], ['solid', 'Fijo']], m),
    pick('cursorSmoothCaretAnimation', 'Movimiento suave del cursor', 'Anima el desplazamiento del cursor.', 'off', [['off', 'Desactivado'], ['explicit', 'Solo al mover'], ['on', 'Siempre']], m),
    num('cursorSurroundingLines', 'Líneas alrededor del cursor', 'Líneas que se mantienen visibles por encima y debajo del cursor.', 0, 0, 50, m),
    pick('multiCursorModifier', 'Tecla de multicursor', 'Tecla que añade cursores al hacer clic.', 'alt', [['alt', 'Alt'], ['ctrlCmd', 'Ctrl']], m),
    pick('autoClosingBrackets', 'Cerrar corchetes', 'Inserta el corchete de cierre automáticamente.', 'languageDefined', [['always', 'Siempre'], ['languageDefined', 'Según el lenguaje'], ['beforeWhitespace', 'Antes de un espacio'], ['never', 'Nunca']], m),
    pick('autoClosingQuotes', 'Cerrar comillas', 'Inserta la comilla de cierre automáticamente.', 'languageDefined', [['always', 'Siempre'], ['languageDefined', 'Según el lenguaje'], ['beforeWhitespace', 'Antes de un espacio'], ['never', 'Nunca']], m),
    pick('autoSurround', 'Envolver selección', 'Rodea la selección al escribir comillas o corchetes.', 'languageDefined', [['languageDefined', 'Comillas y corchetes'], ['quotes', 'Solo comillas'], ['brackets', 'Solo corchetes'], ['never', 'Nunca']], m),
    pick('autoIndent', 'Sangría automática', 'Ajusta la sangría al escribir, pegar o mover líneas.', 'full', [['none', 'Ninguna'], ['keep', 'Conservar'], ['brackets', 'Corchetes'], ['advanced', 'Avanzada'], ['full', 'Completa']], m),
    bool('formatOnPaste', 'Formatear al pegar', 'Da formato al texto pegado si el lenguaje tiene formateador.', false, m),
    bool('formatOnType', 'Formatear al escribir', 'Da formato a la línea al terminar de escribirla.', false, m),
    bool('dragAndDrop', 'Arrastrar selección', 'Permite mover texto seleccionado arrastrándolo.', true, m),
    bool('emptySelectionClipboard', 'Copiar línea sin selección', 'Copiar o cortar sin selección actúa sobre la línea entera.', true, m),
    bool('copyWithSyntaxHighlighting', 'Copiar con colores', 'Conserva el resaltado de sintaxis en el portapapeles.', true, m),
    bool('mouseWheelZoom', 'Zoom con Ctrl + rueda', 'Cambia el tamaño de letra con la rueda del ratón.', false, m),
    bool('columnSelection', 'Selección en columna', 'Seleccionar con el ratón crea un bloque rectangular.', false, m),
  ] },
  { id: 'display', label: 'Visualización', icon: 'Eye', settings: [
    pick('lineNumbers', 'Números de línea', 'Cómo se numeran las líneas.', 'on', [['on', 'Absolutos'], ['relative', 'Relativos'], ['interval', 'Cada 10'], ['off', 'Ocultos']], m),
    pick('renderLineHighlight', 'Resaltar línea actual', 'Cómo se marca la línea del cursor.', 'all', [['none', 'Sin resaltar'], ['gutter', 'Solo margen'], ['line', 'Solo línea'], ['all', 'Margen y línea']], m),
    pick('renderWhitespace', 'Espacios en blanco', 'Cuándo se dibujan los espacios y tabuladores.', 'selection', [['none', 'Nunca'], ['boundary', 'Entre palabras no'], ['selection', 'En la selección'], ['trailing', 'Al final de línea'], ['all', 'Siempre']], m),
    bool('renderControlCharacters', 'Caracteres de control', 'Muestra los caracteres invisibles de control.', true, m),
    text('rulers', 'Reglas verticales', 'Columnas con una guía vertical, separadas por comas.', '', { monaco: 'rulers', placeholder: '80, 120', map: value => String(value).split(',').map(Number).filter(n => n > 0) }),
    bool('minimap', 'Minimapa', 'Muestra la vista reducida del archivo.', false, { monaco: 'minimap.enabled' }),
    pick('minimap.side', 'Lado del minimapa', 'Lado del editor en el que aparece.', 'right', [['right', 'Derecha'], ['left', 'Izquierda']], m),
    pick('minimap.size', 'Tamaño del minimapa', 'Cómo se adapta a la altura del editor.', 'proportional', [['proportional', 'Proporcional'], ['fill', 'Rellenar'], ['fit', 'Ajustar']], m),
    bool('minimap.renderCharacters', 'Letras en el minimapa', 'Dibuja caracteres reales en lugar de bloques.', true, m),
    pick('minimap.showSlider', 'Control del minimapa', 'Cuándo se ve el área visible.', 'mouseover', [['mouseover', 'Al pasar el ratón'], ['always', 'Siempre']], m),
    bool('stickyScroll', 'Encabezados fijos', 'Mantiene visibles las funciones y clases al desplazarse.', true, { monaco: 'stickyScroll.enabled' }),
    num('stickyScroll.maxLineCount', 'Líneas fijas', 'Máximo de encabezados fijos a la vez.', 5, 1, 20, m),
    bool('bracketPairColorization.enabled', 'Colorear corchetes', 'Da un color distinto a cada nivel de corchetes.', true, m),
    pick('guides.bracketPairs', 'Guías de corchetes', 'Líneas que unen cada pareja de corchetes.', 'active', [['false', 'Ocultas'], ['active', 'Solo la activa'], ['true', 'Todas']], { monaco: true, map: value => value === 'active' ? 'active' : value === 'true' }),
    bool('guides.indentation', 'Guías de sangría', 'Líneas verticales en cada nivel de sangría.', true, m),
    pick('matchBrackets', 'Resaltar corchete pareja', 'Cuándo se marca el corchete correspondiente.', 'always', [['always', 'Siempre'], ['near', 'Cerca del cursor'], ['never', 'Nunca']], m),
    pick('occurrencesHighlight', 'Resaltar apariciones', 'Marca otras apariciones del símbolo bajo el cursor.', 'singleFile', [['off', 'Desactivado'], ['singleFile', 'En el archivo'], ['multiFile', 'En archivos abiertos']], m),
    bool('selectionHighlight', 'Resaltar coincidencias', 'Marca el texto igual al seleccionado.', true, m),
    bool('links', 'Detectar enlaces', 'Convierte las URL en enlaces.', true, m),
    bool('colorDecorators', 'Muestras de color', 'Dibuja un cuadro de color junto a los valores CSS.', true, m),
    pick('unicodeHighlight.ambiguousCharacters', 'Caracteres ambiguos', 'Avisa de caracteres que se confunden con otros.', 'true', [['true', 'Resaltar'], ['false', 'Ignorar']], { monaco: true, map: value => value === 'true' }),
    bool('folding', 'Plegado de código', 'Permite plegar bloques.', true, m),
    pick('foldingStrategy', 'Estrategia de plegado', 'Cómo se calculan los bloques plegables.', 'auto', [['auto', 'Automática'], ['indentation', 'Por sangría']], m),
    pick('showFoldingControls', 'Controles de plegado', 'Cuándo se ven las flechas de plegado.', 'mouseover', [['mouseover', 'Al pasar el ratón'], ['always', 'Siempre'], ['never', 'Nunca']], m),
    bool('glyphMargin', 'Margen de símbolos', 'Reserva una columna a la izquierda de los números.', true, m),
    bool('scrollBeyondLastLine', 'Desplazar tras la última línea', 'Permite seguir bajando más allá del final del archivo.', false, m),
    bool('smoothScrolling', 'Desplazamiento suave', 'Anima el desplazamiento.', true, m),
    num('mouseWheelScrollSensitivity', 'Velocidad de la rueda', 'Multiplicador del desplazamiento con la rueda.', 1, 0.1, 10, { ...m, step: 0.1 }),
    pick('scrollbar.vertical', 'Barra de desplazamiento vertical', 'Cuándo se muestra.', 'auto', [['auto', 'Automática'], ['visible', 'Siempre'], ['hidden', 'Oculta']], m),
    pick('scrollbar.horizontal', 'Barra de desplazamiento horizontal', 'Cuándo se muestra.', 'auto', [['auto', 'Automática'], ['visible', 'Siempre'], ['hidden', 'Oculta']], m),
  ] },
  { id: 'suggest', label: 'Sugerencias', icon: 'WandSparkles', settings: [
    bool('quickSuggestions', 'Sugerir al escribir', 'Abre las sugerencias automáticamente mientras escribes.', true, m),
    num('quickSuggestionsDelay', 'Retardo de sugerencias', 'Milisegundos antes de mostrarlas.', 10, 0, 2000, m),
    bool('suggestOnTriggerCharacters', 'Sugerir tras caracteres clave', 'Abre las sugerencias tras escribir por ejemplo un punto.', true, m),
    pick('acceptSuggestionOnEnter', 'Aceptar con Enter', 'Si Enter acepta la sugerencia.', 'on', [['on', 'Siempre'], ['smart', 'Solo si cambia el texto'], ['off', 'Nunca']], m),
    bool('acceptSuggestionOnCommitCharacter', 'Aceptar con caracteres', 'Teclas como el punto y coma aceptan la sugerencia.', true, m),
    pick('tabCompletion', 'Completar con Tab', 'Qué completa la tecla Tab.', 'off', [['off', 'Nada'], ['on', 'Sugerencias'], ['onlySnippets', 'Solo fragmentos']], m),
    pick('wordBasedSuggestions', 'Sugerir palabras', 'De dónde salen las palabras sugeridas.', 'matchingDocuments', [['off', 'Desactivado'], ['currentDocument', 'Archivo actual'], ['matchingDocuments', 'Mismo lenguaje'], ['allDocuments', 'Todos los abiertos']], m),
    pick('snippetSuggestions', 'Fragmentos', 'Posición de los fragmentos en la lista.', 'inline', [['top', 'Arriba'], ['bottom', 'Abajo'], ['inline', 'Mezclados'], ['none', 'Ocultos']], m),
    pick('suggestSelection', 'Selección inicial', 'Sugerencia preseleccionada.', 'first', [['first', 'La primera'], ['recentlyUsed', 'La más reciente'], ['recentlyUsedByPrefix', 'Reciente por prefijo']], m),
    bool('suggest.preview', 'Vista previa', 'Muestra el resultado de la sugerencia en el editor.', false, m),
    bool('suggest.showIcons', 'Iconos en sugerencias', 'Muestra el icono de cada tipo de elemento.', true, m),
    bool('parameterHints.enabled', 'Ayuda de parámetros', 'Muestra la firma al escribir argumentos.', true, m),
    bool('hover.enabled', 'Información al pasar el ratón', 'Muestra documentación sobre el símbolo.', true, m),
    num('hover.delay', 'Retardo de información', 'Milisegundos antes de mostrarla.', 300, 0, 5000, m),
    pick('inlayHints.enabled', 'Pistas en línea', 'Anotaciones de tipos dentro del código.', 'on', [['on', 'Activadas'], ['off', 'Desactivadas'], ['onUnlessPressed', 'Ocultas al pulsar Ctrl+Alt'], ['offUnlessPressed', 'Visibles al pulsar Ctrl+Alt']], m),
    bool('codeLens', 'CodeLens', 'Muestra acciones sobre el código, como resolver conflictos.', true, m),
    pick('lightbulb.enabled', 'Bombilla de acciones', 'Ofrece correcciones rápidas.', 'onCode', [['off', 'Desactivada'], ['on', 'Siempre'], ['onCode', 'Solo sobre código']], m),
  ] },
  { id: 'files', label: 'Archivos', icon: 'Save', settings: [
    bool('autoSave', 'Guardado automático', 'Guarda tras dejar de escribir.', false),
    num('autoSaveDelay', 'Retardo de guardado', 'Milisegundos de inactividad antes de guardar.', 1200, 200, 60000),
    bool('autoSaveOnFocusLost', 'Guardar al cambiar de ventana', 'Guarda todo al salir de Lumen hacia otra ventana.', false),
    bool('formatOnSave', 'Formatear al guardar', 'Da formato al documento antes de guardarlo.', false),
    bool('trimTrailingWhitespace', 'Recortar espacios finales', 'Quita los espacios al final de cada línea al guardar.', false),
    bool('insertFinalNewline', 'Línea final', 'Garantiza un salto de línea al final al guardar.', false),
    num('pollInterval', 'Comprobar cambios externos', 'Segundos entre comprobaciones de archivos y Git.', 4, 1, 300),
  ] },
  { id: 'explorer', label: 'Explorador', icon: 'Files', settings: [
    text('explorerExclude', 'Ocultar archivos', 'Nombres de archivo o carpeta ocultos, separados por comas.', '', { placeholder: 'node_modules, dist, *.log' }),
    num('explorerIndent', 'Sangría del árbol', 'Píxeles por cada nivel.', 15, 4, 40),
    bool('explorerAutoReveal', 'Seguir archivo activo', 'Selecciona en el árbol el archivo de la pestaña activa.', true),
    bool('explorerGitStatus', 'Colores de Git', 'Colorea los archivos modificados.', true),
    bool('explorerConfirmDelete', 'Confirmar papelera', 'Pregunta antes de enviar algo a la papelera.', true),
  ] },
  { id: 'search', label: 'Búsqueda', icon: 'Search', settings: [
    num('searchDelay', 'Retardo de búsqueda', 'Milisegundos tras escribir antes de buscar.', 250, 0, 3000),
    bool('searchSeed', 'Usar la selección', 'Rellena la búsqueda con el texto seleccionado.', true),
    bool('find.loop', 'Búsqueda circular', 'Vuelve al principio al llegar al final del archivo.', true, m),
    pick('find.seedSearchStringFromSelection', 'Buscar selección en el archivo', 'Rellena Ctrl+F con la selección.', 'always', [['never', 'Nunca'], ['always', 'Siempre'], ['selection', 'Solo si hay selección']], m),
    pick('find.autoFindInSelection', 'Buscar en la selección', 'Limita Ctrl+F a la selección.', 'never', [['never', 'Nunca'], ['always', 'Siempre'], ['multiline', 'Si ocupa varias líneas']], m),
  ] },
  { id: 'terminal', label: 'Terminal', icon: 'Terminal', settings: [
    text('shell', 'Consola predeterminada', 'Programa y argumentos. Vacío usa la consola del sistema.', '', { placeholder: 'pwsh.exe, cmd.exe, wsl.exe' }),
    num('terminalFontSize', 'Tamaño de letra', 'Tamaño de letra de la terminal, en píxeles.', 13, 6, 40),
    text('terminalFontFamily', 'Familia de fuente', 'Fuentes de la terminal separadas por comas.', "'Cascadia Mono', Consolas, monospace"),
    num('terminalLineHeight', 'Altura de línea', 'Multiplicador de la altura de cada línea.', 1, 1, 3, { step: 0.1 }),
    pick('terminalCursorStyle', 'Forma del cursor', 'Aspecto del cursor de la terminal.', 'block', [['block', 'Bloque'], ['underline', 'Subrayado'], ['bar', 'Línea']]),
    bool('terminalCursorBlink', 'Parpadeo del cursor', 'Hace parpadear el cursor.', true),
    num('terminalScrollback', 'Historial de líneas', 'Líneas que se conservan al desplazarse.', 5000, 100, 100000),
    bool('terminalCopyOnSelect', 'Copiar al seleccionar', 'Copia automáticamente el texto seleccionado.', false),
    bool('terminalConfirmClose', 'Confirmar al cerrar', 'Pregunta antes de cerrar una consola activa.', true),
  ] },
  { id: 'git', label: 'Git', icon: 'GitBranch', settings: [
    bool('gitGutter', 'Marcas en el margen', 'Señala las líneas añadidas, cambiadas o borradas.', true),
    bool('blame', 'Blame en línea', 'Muestra autor, fecha y mensaje del último commit de la línea actual, al final de la línea y en la barra de estado.', true),
    pick('gitSmartCommit', 'Commit sin preparar', 'Qué hacer al crear un commit sin archivos preparados.', 'prompt', [['prompt', 'Preguntar'], ['always', 'Incluir todo'], ['never', 'No hacer nada']]),
    pick('gitPullMode', 'Modo de pull', 'Cómo se integran los cambios remotos.', 'pull', [['pull', 'Solo avance rápido'], ['pull-merge', 'Merge'], ['pull-rebase', 'Rebase']]),
    num('gitAutoFetch', 'Fetch automático', 'Minutos entre fetch automáticos. 0 lo desactiva.', 0, 0, 1440),
  ] },
];
export const ALL_SETTINGS = CATEGORIES.flatMap(c => c.settings);
const byKey = new Map(ALL_SETTINGS.map(s => [s.key, s]));
export const settingOf = (key: string) => byKey.get(key);

export interface Settings {
  [key: string]: SettingValue;
  fontSize: number; tabSize: number; insertSpaces: boolean; detectIndentation: boolean; theme: string; locale: string; wordWrap: string; minimap: boolean; blame: boolean;
  autoSave: boolean; autoSaveDelay: number; autoSaveOnFocusLost: boolean; formatOnSave: boolean; trimTrailingWhitespace: boolean; insertFinalNewline: boolean;
  uiFontSize: number; showActivityBar: boolean; showStatusBar: boolean; showTabs: boolean; showBreadcrumbs: boolean; sidebarPosition: string; restoreFolder: boolean; restoreSession: boolean;
  pollInterval: number; explorerExclude: string; explorerIndent: number; explorerAutoReveal: boolean; explorerGitStatus: boolean; explorerConfirmDelete: boolean;
  searchDelay: number; searchSeed: boolean; shell: string; terminalFontSize: number; terminalFontFamily: string; terminalLineHeight: number; terminalCursorStyle: string;
  terminalCursorBlink: boolean; terminalScrollback: number; terminalCopyOnSelect: boolean; terminalConfirmClose: boolean;
  gitGutter: boolean; gitSmartCommit: string; gitPullMode: string; gitAutoFetch: number;
}
export const defaultSettings = Object.fromEntries(ALL_SETTINGS.map(s => [s.key, s.default])) as Settings;

/** Fills gaps from the defaults and upgrades values saved by earlier versions (booleans became modes). */
export function loadSettings(saved: Record<string, SettingValue>): Settings {
  const settings = { ...defaultSettings, ...saved };
  // Inline blame became a default; older saved settings recorded it as off without anyone choosing that.
  if (saved.settingsVersion === undefined) settings.blame = true;
  settings.settingsVersion = 2;
  if (typeof saved.wordWrap === 'boolean') settings.wordWrap = saved.wordWrap ? 'on' : 'off';
  if (typeof saved.lineNumbers === 'boolean') settings.lineNumbers = saved.lineNumbers ? 'on' : 'off';
  if (typeof saved.renderWhitespace === 'boolean') settings.renderWhitespace = saved.renderWhitespace ? 'all' : 'selection';
  return settings;
}
export function monacoOptions(settings: Settings): monaco.editor.IStandaloneEditorConstructionOptions {
  const options: Record<string, unknown> = {};
  for (const setting of ALL_SETTINGS) {
    if (!setting.monaco) continue;
    const path = (setting.monaco === true ? setting.key : setting.monaco).split('.'); const last = path.pop()!;
    let target = options;
    for (const part of path) target = (target[part] ??= {}) as Record<string, unknown>;
    target[last] = setting.map ? setting.map(settings[setting.key]) : settings[setting.key];
  }
  return options;
}
export function resolvedTheme(settings: Settings): 'dark' | 'light' {
  if (settings.theme === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return settings.theme === 'light' ? 'light' : 'dark';
}
/** Readable key combination for an event, or null while only modifiers are held. */
export function comboOf(event: KeyboardEvent) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
  const name = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : '', name].filter(Boolean).join('+');
}
