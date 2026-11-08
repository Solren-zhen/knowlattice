/**
 * AI 助手配置的读取出口。
 *
 * 原来这段逻辑只写在 `views/AiAgentPanel.tsx` 里，课程工坊也要用同一份配置（同一组
 * Base URL / Key / 模型名），再抄一份就会出现「AI 面板里改了模型，课程笔记还在用旧的」。
 * 放到 core 是因为它只依赖 storage 与 secureCredentials，不认识任何视图。
 *
 * 桌面端的 Key 在系统凭据库里，localStorage 只留空串；旧版明文 Key 在首次读取时迁移。
 */
import { isAllowedAgentBaseUrl, type AgentSettings } from './aiAgent';
import { cachedSecureApiKey, credentialStoreKind, saveSecureApiKey } from './secureCredentials';

/** 助手配置的存储键（与 kv.ts 的 KV_KEYS 登记一致） */
export const AI_AGENT_SETTINGS_KEY = 'knowlattice-ai-agent-settings';

export function loadAgentSettings(): AgentSettings | null {
  try {
    const raw = localStorage.getItem(AI_AGENT_SETTINGS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AgentSettings;
    if (typeof s.baseUrl !== 'string' || !isAllowedAgentBaseUrl(s.baseUrl)) return null;
    if (typeof s.model !== 'string' || !s.model.trim()) return null;
    const localKey = typeof s.apiKey === 'string' ? s.apiKey : '';
    const secureKey = cachedSecureApiKey();
    // 旧版桌面用户把 Key 明文存进了 localStorage：首次读取即迁入系统凭据库，
    // 成功后才清空 Web 存储。失败时仍用内存里的旧 Key，不阻断当前会话。
    if (credentialStoreKind() === 'os' && localKey && !secureKey) {
      void saveSecureApiKey(localKey)
        .then(() => {
          localStorage.setItem(AI_AGENT_SETTINGS_KEY, JSON.stringify({ ...s, apiKey: '' }));
        })
        .catch((error) => {
          console.warn('API Key 迁移到系统凭据库失败：', error);
        });
    }
    return {
      baseUrl: s.baseUrl,
      apiKey: secureKey || localKey,
      model: s.model,
    };
  } catch {
    return null;
  }
}
