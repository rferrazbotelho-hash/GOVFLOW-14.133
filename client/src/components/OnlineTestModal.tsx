import React, { useState } from 'react';
import {
  Activity,
  Check,
  CheckCircle2,
  Copy,
  FlaskConical,
  Globe,
  Loader2,
  Power,
  RefreshCw,
  Server,
  X
} from 'lucide-react';
import type { PlatformOnlineStatus } from '@shared/types';
import { api } from '../api/client';

interface Props {
  status: PlatformOnlineStatus | null;
  institutionId?: string;
  onClose: () => void;
  onStatusUpdated: (next: PlatformOnlineStatus) => void;
  onOpenSandboxProcess: (processId: string) => Promise<void>;
}

export const OnlineTestModal: React.FC<Props> = ({
  status,
  institutionId,
  onClose,
  onStatusUpdated,
  onOpenSandboxProcess
}) => {
  const [probing, setProbing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [creatingSandbox, setCreatingSandbox] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState('');

  const handleProbe = async () => {
    setProbing(true);
    setErrorMsg('');
    try {
      const next = await api.getOnlineStatus(true);
      onStatusUpdated(next);
    } catch (err: any) {
      setErrorMsg(err.message || 'Falha ao executar diagnóstico online.');
    } finally {
      setProbing(false);
    }
  };

  const handleToggleMode = async () => {
    if (!status) return;
    setToggling(true);
    setErrorMsg('');
    try {
      const next = await api.setOnlineTestMode(!status.test_mode);
      onStatusUpdated(next);
    } catch (err: any) {
      setErrorMsg(err.message || 'Falha ao alternar Modo Teste Online.');
    } finally {
      setToggling(false);
    }
  };

  const handleCreateSandbox = async () => {
    setCreatingSandbox(true);
    setErrorMsg('');
    try {
      const res = await api.createSandboxProcess({
        institutionId,
        autoRunAll: true,
        autoApprove: false
      });
      await onOpenSandboxProcess(res.bundle.process.id);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao gerar Processo Sandbox de Teste.');
    } finally {
      setCreatingSandbox(false);
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(''), 1800);
    } catch {
      // Fallback ignored if clipboard API restricted
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-4 bg-gradient-to-r from-[#071D41] to-[#1351B4] text-white flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-2.5">
            <FlaskConical className="w-5 h-5 text-emerald-300" />
            <div>
              <h2 className="font-bold text-base">Plataforma Oficial — Modo Teste Online & Sandbox</h2>
              <p className="text-[11px] text-blue-200">
                Operação ao vivo (Express + SQLite + TCU Dados Abertos + Rede Local)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-300 hover:text-white p-1 cursor-pointer"
            aria-label="Fechar Modo Teste Online"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Status Card */}
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-emerald-600 text-white flex items-center justify-center">
                <Activity className="w-5 h-5" />
              </div>
              <div>
                <div className="text-xs font-bold text-emerald-950 flex items-center gap-2">
                  <span>{status?.mode_label || 'MODO TESTE ONLINE ATIVO'}</span>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-600 text-white text-[10px]">
                    ONLINE · :{status?.port || 3001}
                  </span>
                </div>
                <div className="text-[11px] text-emerald-800 mt-0.5">
                  Servidor escutando em <code>{status?.host || '0.0.0.0'}:{status?.port || 3001}</code> • Banco SQLite:{' '}
                  <strong>{status?.database_ok ? 'Conectado' : 'Verificar'}</strong> • Motor:{' '}
                  <strong>{(status?.ai_effective_provider || 'local').toUpperCase()}</strong>
                </div>
              </div>
            </div>

            <button
              type="button"
              disabled={toggling || !status}
              onClick={handleToggleMode}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors disabled:opacity-50 ${
                status?.test_mode
                  ? 'bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              }`}
            >
              {toggling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
              {status?.test_mode ? 'Pausar Modo Teste' : 'Ativar Modo Teste Online'}
            </button>
          </div>

          {/* Endereços de Acesso Ao Vivo */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-bold text-[#071D41]">
              <Server className="w-4 h-4 text-[#1351B4]" />
              Endereços de Acesso Operacional (Browser Local & Rede LAN)
            </div>
            <div className="space-y-1.5">
              {[status?.local_url || 'http://localhost:3001', ...(status?.network_urls || [])].map((url) => (
                <div
                  key={url}
                  className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs"
                >
                  <code className="font-mono text-[#071D41] font-semibold">{url}</code>
                  <button
                    type="button"
                    onClick={() => copyUrl(url)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 hover:border-[#1351B4] text-[11px] font-semibold text-slate-700 cursor-pointer"
                  >
                    {copiedUrl === url ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        Copiado
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        Copiar URL
                      </>
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Diagnóstico Online TCU + Sandbox 1-Clique */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-200 p-4 space-y-2.5 flex flex-col justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-bold text-[#071D41]">
                  <Globe className="w-4 h-4 text-[#1351B4]" />
                  Teste de Conectividade Online
                </div>
                <p className="text-[11px] text-slate-600">
                  Verifica tempo de resposta da API Express, SQLite e consulta em tempo real ao portal Dados Abertos do TCU.
                </p>
              </div>

              {status?.tcu_probe && (
                <div
                  className={`rounded-lg p-2.5 text-[11px] flex items-start gap-1.5 border ${
                    status.tcu_probe.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-amber-50 border-amber-200 text-amber-900'
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    {status.tcu_probe.message} ({status.tcu_probe.latency_ms} ms)
                  </span>
                </div>
              )}

              <button
                type="button"
                onClick={handleProbe}
                disabled={probing}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-[#1351B4] text-[#1351B4] hover:bg-blue-50 text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                {probing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {probing ? 'Diagnosticando...' : 'Testar Conectividade TCU Online'}
              </button>
            </div>

            <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-2.5 flex flex-col justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-bold text-[#071D41]">
                  <FlaskConical className="w-4 h-4 text-indigo-700" />
                  Processo Sandbox Automatizado (01→11)
                </div>
                <p className="text-[11px] text-slate-600">
                  Cria um processo completo de teste com Pesquisa de Preços (3 itens), Acórdãos TCU vinculados e executa todos os 11 agentes imediatamente.
                </p>
              </div>

              <button
                type="button"
                onClick={handleCreateSandbox}
                disabled={creatingSandbox}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-xs font-semibold cursor-pointer disabled:opacity-50 shadow-xs"
              >
                {creatingSandbox ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Executando Sandbox (01–11)...
                  </>
                ) : (
                  <>
                    <FlaskConical className="w-3.5 h-3.5" />
                    Gerar & Testar Processo Sandbox
                  </>
                )}
              </button>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800">
              {errorMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
