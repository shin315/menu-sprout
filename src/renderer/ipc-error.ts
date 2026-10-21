// Surfaces the real reason an IPC call failed.
// Electron wraps IPC rejections as "Error invoking remote method '...': Error: <real>",
// so we keep only the trailing message the main process actually threw.
export function ipcErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:(?:[A-Za-z][A-Za-z0-9]*Error|Error):\s*)+/, "")
    .trim();
  return message || null;
}
