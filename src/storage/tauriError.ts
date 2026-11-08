/**
 * Tauri 命令错误 → 可读文案。
 *
 * 后端命令统一返回 `{ code, message }`（见 src-tauri/src/lib.rs 的 AppError）。
 * 经过 IPC 之后拿到的不是 Error 实例，直接 `String(e)` 会变成 `[object Object]`、
 * `(e as Error).message` 会变成 undefined。所有命令调用方都从这里取文案。
 */
export interface TauriCommandError {
  code?: string;
  message?: string;
}

export function tauriErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as TauriCommandError;
    if (typeof e.message === 'string' && e.message.trim()) return e.message;
    if (typeof e.code === 'string' && e.code.trim()) return e.code;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
