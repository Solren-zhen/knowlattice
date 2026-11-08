import { isTauri } from '../storage/tauriEnv';
import { tauriErrorText } from '../storage/tauriError';
import { invokeCommand } from '../storage/tauriCommands';

export type CredentialStoreKind = 'os' | 'web';

let cachedApiKey = '';
let lastError = '';

export function credentialStoreKind(): CredentialStoreKind {
  return isTauri() ? 'os' : 'web';
}

/** 最近一次凭据库错误的可读原因（启动时为『读不到』提供线索）。 */
export function secureApiKeyError(): string {
  return lastError;
}

/** 在首屏渲染前把桌面端密钥读入内存，配置表单与助手共用这一份。 */
export async function hydrateSecureApiKey(): Promise<void> {
  if (!isTauri()) return;
  try {
    cachedApiKey = await invokeCommand<string>('load_ai_api_key');
    lastError = '';
  } catch (error) {
    cachedApiKey = '';
    lastError = tauriErrorText(error);
  }
}

export function cachedSecureApiKey(): string {
  return cachedApiKey;
}

/** 桌面端写入系统凭据库；空串表示删除。浏览器端调用方不应走这里。 */
export async function saveSecureApiKey(key: string): Promise<void> {
  if (!isTauri()) throw new Error('浏览器版没有系统凭据库');
  try {
    await invokeCommand('save_ai_api_key', { key });
    cachedApiKey = key;
    lastError = '';
  } catch (error) {
    lastError = tauriErrorText(error);
    throw error;
  }
}
