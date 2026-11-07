import { invoke, isTauri } from '@tauri-apps/api/core';

export const desktop = isTauri();
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!desktop) throw new Error('Abre la aplicación de escritorio para acceder a archivos, Git y terminal. Esta ventana es una vista previa de la interfaz.');
  return invoke<T>(command, args);
}
