// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsForm, { AI_AGENT_SETTINGS_KEY } from '../AgentSettingsForm';

const secure = vi.hoisted(() => ({
  kind: vi.fn((): 'os' | 'web' => 'os'),
  save: vi.fn(async () => undefined),
}));

vi.mock('../../core/secureCredentials', () => ({
  credentialStoreKind: secure.kind,
  saveSecureApiKey: secure.save,
}));

beforeEach(() => {
  localStorage.clear();
  secure.kind.mockReset().mockReturnValue('os');
  secure.save.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText('接口地址（OpenAI 兼容）'), { target: { value: 'https://api.example.com/v1' } });
  fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-secret' } });
  fireEvent.change(screen.getByLabelText(/模型名/), { target: { value: 'test-model' } });
}

describe('AgentSettingsForm credential storage', () => {
  it('桌面端把密钥交给系统凭据库，localStorage 只保存空密钥', async () => {
    const onSaved = vi.fn();
    render(<SettingsForm initial={null} onSaved={onSaved} onCancel={() => {}} />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(secure.save).toHaveBeenCalledWith('sk-secret'));
    const stored = JSON.parse(localStorage.getItem(AI_AGENT_SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored).toMatchObject({ baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: '' });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-secret' }));
  });

  it('桌面端关闭“把密钥保存在本机”时删除系统凭据', async () => {
    render(<SettingsForm initial={null} onSaved={() => {}} onCancel={() => {}} />);
    fillRequiredFields();
    fireEvent.click(screen.getByLabelText(/把密钥保存在本机/));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(secure.save).toHaveBeenCalledWith(''));
  });

  it('系统凭据库不可用时退化为仅本次会话使用，不把密钥写进 localStorage', async () => {
    secure.save.mockRejectedValue(new Error('keyring unavailable'));
    const onSaved = vi.fn();
    render(<SettingsForm initial={null} onSaved={onSaved} onCancel={() => {}} />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-secret' })));
    const stored = JSON.parse(localStorage.getItem(AI_AGENT_SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored.apiKey).toBe('');
  });

  it('浏览器版仍只用 localStorage，不调用桌面凭据接口', async () => {
    secure.kind.mockReturnValue('web');
    render(<SettingsForm initial={null} onSaved={() => {}} onCancel={() => {}} />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(AI_AGENT_SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
      expect(stored.apiKey).toBe('sk-secret');
    });
    expect(secure.save).not.toHaveBeenCalled();
  });
});
