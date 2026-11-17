import React, { useState } from 'react';
import type { AiConnectivityTestResult, AiProviderMode, AiSettings } from '@shared/types';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  X
} from 'lucide-react';
import { api } from '../api/client';

interface AiSettingsModalProps {
  settings: AiSettings;
  onClose: () => void;
  onSaved: (updated: AiSettings) => void;
}

const PROVIDER_OPTIONS: {
  id: AiProviderMode;
  title: string;
  badge?: string;
  description: string;
}[] = [
  {
    id: 'auto',
    title: 'Automático (Gemini Zero-Token + Fallback Local)',
    badge: 'Recomendado',
    description:
      'Detecta automaticamente GEMINI_API_KEY, GOOGLE_API_KEY, arquivo .env ou Google Cloud ADC (gcloud auth application-default login) sem digitar token na tela. Se não houver credencial externa, opera via Motor Local 14.133.'
  },
  {
    id: 'local',
    title: 'Motor Jurídico Especialista Local (100% Offline)',
    description:
      'Execução determinística local em conformidade com a Lei nº 14.133/2021, Decreto nº 11.462/2023 e INs SEGES, sem chamadas externas.'
  },
  {
    id: 'gemini',
    title: 'Google Gemini API',
    description:
      'Prioriza Gemini usando credencial automática do ambiente/.env/ADC (ou chave opcional salva), mantendo fallback local automático se indisponível.'
  },
  {
    id: 'openai',
    title: 'OpenAI / Endpoint Compatível',
    description:
      'Utiliza API padrão OpenAI / Ollama / vLLM compatível com chat completions.'
  }
];

export function AiSettingsModal({ settings, onClose, onSaved }: AiSettingsModalProps) {
  const [provider, setProvider] = useState<AiProviderMode>(settings.provider || 'auto');
  const [geminiModel, setGeminiModel] = useState(settings.geminiModel || 'gemini-4-hydrogen');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState(settings.openaiModel || 'gpt-4o-mini');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(
    settings.openaiBaseUrl || 'https://api.openai.com/v1'
  );
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [showManualKey, setShowManualKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<AiConnectivityTestResult | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateAiSettings({
        provider,
        geminiModel,
        geminiApiKey: geminiApiKey ? geminiApiKey : undefined,
        openaiModel,
        openaiBaseUrl,
        openaiApiKey: openaiApiKey ? openaiApiKey : undefined
      });
      onSaved(updated);
      setGeminiApiKey('');
      setOpenaiApiKey('');
      const diagnostic = await api.testAiSettings();
      setTestResult(diagnostic);
    } catch (err: any) {
      setError(err.message || 'Falha ao salvar configuração de motor de agentes.');
    } finally {
      setSaving(false);
    }
  };

  const handleClearSavedGeminiKey = async () => {
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateAiSettings({ geminiApiKey: '' });
      onSaved(updated);
      setGeminiApiKey('');
      const diagnostic = await api.testAiSettings();
      setTestResult(diagnostic);
    } catch (err: any) {
      setError(err.message || 'Falha ao remover chave salva.');
    } finally {
      setSaving(false);
    }
  };

  const handleResetGeminiCredentials = async () => {
    setResetting(true);
    setError('');
    try {
      const res = await api.resetGeminiCredentials({ setAutoProvider: true });
      onSaved(res.settings);
      setProvider(res.settings.provider);
      setGeminiModel(res.settings.geminiModel || 'gemini-4-hydrogen');
      setGeminiApiKey('');
      const prefix = res.clearedDbKey
        ? 'Chave manual anterior removida e cache OAuth2 renovado. '
        : 'Cache OAuth2 limpo e origens (.env / sistema / ADC) revalidadas. ';
      setTestResult({
        ...res.diagnostic,
        message: `${prefix}${res.diagnostic.message}`
      });
    } catch (err: any) {
      setError(err.message || 'Falha ao refazer e redetectar credenciais Gemini.');
    } finally {
      setResetting(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError('');
    try {
      const diagnostic = await api.testAiSettings();
      setTestResult(diagnostic);
    } catch (err: any) {
      setError(err.message || 'Erro ao testar conectividade do motor de IA.');
    } finally {
      setTesting(false);
    }
  };

  const isGeminiActive = settings.effectiveProvider === 'gemini';
  const isOpenaiActive = settings.effectiveProvider === 'openai';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-4 bg-gradient-to-r from-[#0F243E] to-[#1E3A5F] text-white flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-2.5">
            <Cpu className="w-5 h-5 text-blue-300" />
            <div>
              <h2 className="font-bold text-base">Motor de Inteligência Jurídica & IA</h2>
              <p className="text-[11px] text-blue-200">
                Integração automatizada Gemini (Zero-Token) + Motor Local 14.133
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-300 hover:text-white p-1 cursor-pointer"
            aria-label="Fechar configurações de IA"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-5">
          {/* Painel de status e detecção automática em tempo real */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {isGeminiActive || isOpenaiActive ? (
                  <Sparkles className="w-4 h-4 text-emerald-600" />
                ) : (
                  <ShieldCheck className="w-4 h-4 text-blue-700" />
                )}
                <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Diagnóstico de Autenticação Automática
                </span>
              </div>
              <span
                className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${
                  isGeminiActive
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                    : isOpenaiActive
                      ? 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                      : 'bg-blue-100 text-blue-900 border border-blue-200'
                }`}
              >
                Motor Efetivo: {settings.effectiveProvider.toUpperCase()}
              </span>
            </div>

            <div className="text-xs text-slate-700 space-y-1">
              <p>
                <span className="font-semibold">Origem detectada:</span>{' '}
                <span>{settings.authSourceLabel}</span>
              </p>
              {settings.geminiAuthDetail && (
                <p className="text-[11px] text-slate-600">{settings.geminiAuthDetail}</p>
              )}
              <p className="text-[11px] text-slate-500">
                Código de origem: <code>{settings.authSource}</code> · Política:{' '}
                <code>{settings.provider}</code> · Modelo Gemini: <code>{settings.geminiModel}</code>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || resetting || saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testing ? 'animate-spin' : ''}`} />
                {testing ? 'Testando...' : 'Testar Conexão Agora'}
              </button>
              <button
                type="button"
                onClick={handleResetGeminiCredentials}
                disabled={resetting || testing || saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 border border-blue-200 text-blue-800 hover:bg-blue-100 cursor-pointer disabled:opacity-50"
                title="Remove chave salva inválida, limpa cache OAuth2, recarrega .env e redetecta credenciais Gemini"
              >
                <RotateCcw className={`w-3.5 h-3.5 ${resetting ? 'animate-spin' : ''}`} />
                {resetting ? 'Refazendo...' : 'Refazer Credenciais Gemini'}
              </button>
              <span className="text-[11px] text-slate-500">
                Limpa cache OAuth2 e revalida .env / ADC automaticamente.
              </span>
            </div>

            {testResult && (
              <div
                className={`rounded-lg p-2.5 text-xs flex items-start gap-2 border ${
                  testResult.ok
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-amber-50 border-amber-200 text-amber-900'
                }`}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
                )}
                <div className="space-y-1 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span>{testResult.message}</span>
                    {!testResult.ok && testResult.errorCode && (
                      <code className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 border border-amber-300 text-amber-900">
                        {testResult.errorCode}
                      </code>
                    )}
                  </div>
                  {testResult.hint && (
                    <p className="text-[11px] opacity-90">{testResult.hint}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Seletor de Política */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
              Política de Execução dos 11 Agentes
            </label>
            <div className="space-y-2">
              {PROVIDER_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                    provider === opt.id
                      ? 'border-blue-600 bg-blue-50/70'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="provider"
                    checked={provider === opt.id}
                    onChange={() => setProvider(opt.id)}
                    className="mt-1 accent-blue-700"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-900">{opt.title}</span>
                      {opt.badge && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-700 text-white uppercase">
                          {opt.badge}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">{opt.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Configurações Gemini (Automático + Modelo + Sobrescrita Manual Opcional) */}
          {(provider === 'auto' || provider === 'gemini') && (
            <div className="space-y-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Parâmetros Gemini (Detecção Automática)
                </span>
                <span className="text-[11px] font-medium text-slate-600">
                  {settings.hasGeminiKey ? 'Credencial detectada' : 'Fallback Local pronto'}
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Modelo Gemini preferencial
                </label>
                <input
                  type="text"
                  value={geminiModel}
                  onChange={(e) => setGeminiModel(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                  placeholder="gemini-4-hydrogen"
                />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {[
                    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (Padrão)' },
                    { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
                    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
                    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
                  ].map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setGeminiModel(preset.id)}
                      className={`text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${
                        geminiModel.trim().toLowerCase() === preset.id
                          ? 'bg-blue-700 text-white border-blue-700 font-semibold'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg bg-white border border-slate-200 p-3 text-xs text-slate-600 space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                  <Terminal className="w-3.5 h-3.5 text-blue-700" />
                  <span>Como ativar o Gemini automaticamente (zero token na tela):</span>
                </div>
                <ul className="list-disc pl-4 space-y-1 text-[11px]">
                  <li>
                    <strong>Google Cloud ADC (OAuth2):</strong> execute{' '}
                    <code>gcloud auth application-default login</code> neste computador ou defina{' '}
                    <code>GOOGLE_APPLICATION_CREDENTIALS</code>.
                  </li>
                  <li>
                    <strong>Arquivo .env / Ambiente:</strong> defina <code>GEMINI_API_KEY</code> ou{' '}
                    <code>GOOGLE_API_KEY</code> no sistema ou em <code>.env</code> (detecção imediata).
                  </li>
                  <li>
                    Sem credencial externa, os 11 agentes operam imediatamente pelo{' '}
                    <strong>Motor Jurídico Especialista Local (14.133)</strong>.
                  </li>
                </ul>
              </div>

              <div className="pt-1 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowManualKey((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Chave API manual opcional (somente se desejar sobrescrever o ambiente)</span>
                  {showManualKey ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>

                {showManualKey && (
                  <div className="mt-2.5 space-y-2">
                    <input
                      type="password"
                      value={geminiApiKey}
                      onChange={(e) => setGeminiApiKey(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      placeholder={
                        settings.authSource === 'db_api_key'
                          ? 'Chave salva no banco local (digite para substituir)'
                          : 'Opcional: informe uma API Key apenas para sobrescrever'
                      }
                    />
                    {settings.authSource === 'db_api_key' && (
                      <button
                        type="button"
                        onClick={handleClearSavedGeminiKey}
                        disabled={saving}
                        className="text-[11px] font-semibold text-red-700 hover:underline cursor-pointer"
                      >
                        Remover chave salva manualmente e voltar à detecção automática
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Configurações OpenAI */}
          {provider === 'openai' && (
            <div className="space-y-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Endpoint Base URL
                </label>
                <input
                  type="text"
                  value={openaiBaseUrl}
                  onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Modelo</label>
                <input
                  type="text"
                  value={openaiModel}
                  onChange={(e) => setOpenaiModel(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                  placeholder="gpt-4o-mini"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  API Key{' '}
                  {settings.hasOpenaiKey ? '(Chave detectada)' : '(Opcional — fallback Local)'}
                </label>
                <input
                  type="password"
                  value={openaiApiKey}
                  onChange={(e) => setOpenaiApiKey(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                  placeholder={
                    settings.hasOpenaiKey ? '•••••••• (deixe vazio para manter)' : 'sk-...'
                  }
                />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 px-3 py-2 text-xs">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg cursor-pointer"
            >
              Fechar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 text-sm font-semibold text-white bg-[#1E3A5F] hover:bg-[#152B47] rounded-lg cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Salvando...' : 'Salvar Configuração'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
