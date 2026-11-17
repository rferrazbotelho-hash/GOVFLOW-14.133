import React from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock,
  Cpu,
  FolderKanban,
  Loader2,
  LogOut,
  MinusCircle,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  UserCog
} from 'lucide-react';
import {
  AGENT_DEFINITIONS,
  type AgentPiece,
  type AgentStatus,
  type AiSettings,
  type PlatformOnlineStatus,
  type ProcessBundle,
  type UserAccount
} from '@shared/types';
import { AGENT_STATUS_LABELS } from '@shared/labels';

export type AppView = 'dashboard' | 'institution' | 'workspace' | 'admin';

interface Props {
  currentUser: UserAccount;
  activeView: AppView;
  onNavigate: (view: AppView) => void;
  activeBundle: ProcessBundle | null;
  selectedAgentNumber: number;
  runningAgentNumber: number | null;
  onSelectAgent: (num: number) => void;
  onOpenCertameConfig: () => void;
  onOpenAiSettings: () => void;
  onOpenOnlineModal: () => void;
  onOpenProfile: () => void;
  onLogout: () => void;
  aiSettings: AiSettings | null;
  onlineStatus: PlatformOnlineStatus | null;
}

function StatusIcon({ status, running }: { status: AgentStatus; running: boolean }) {
  if (running || status === 'GERANDO') {
    return <Loader2 className="w-4 h-4 text-[#1351B4] animate-spin shrink-0" />;
  }
  switch (status) {
    case 'APROVADO':
      return <CheckCircle2 className="w-4 h-4 text-[#168821] shrink-0" />;
    case 'AGUARDANDO_REVISAO':
      return <Clock className="w-4 h-4 text-[#C2850C] shrink-0" />;
    case 'DESATUALIZADO':
      return <AlertTriangle className="w-4 h-4 text-[#D13438] shrink-0" />;
    case 'DISPENSADO':
      return <MinusCircle className="w-4 h-4 text-slate-400 shrink-0" />;
    default:
      return <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-300 shrink-0 ml-0.5" />;
  }
}

function statusPillClass(status: AgentStatus, running: boolean): string {
  if (running || status === 'GERANDO') return 'bg-blue-100 text-[#1351B4]';
  switch (status) {
    case 'APROVADO':
      return 'bg-emerald-100 text-emerald-800';
    case 'AGUARDANDO_REVISAO':
      return 'bg-amber-100 text-amber-800';
    case 'DESATUALIZADO':
      return 'bg-rose-100 text-rose-800';
    case 'DISPENSADO':
      return 'bg-slate-100 text-slate-500';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

export const Sidebar: React.FC<Props> = ({
  currentUser,
  activeView,
  onNavigate,
  activeBundle,
  selectedAgentNumber,
  runningAgentNumber,
  onSelectAgent,
  onOpenCertameConfig,
  onOpenAiSettings,
  onOpenOnlineModal,
  onOpenProfile,
  onLogout,
  aiSettings,
  onlineStatus
}) => {
  const piecesMap = new Map<number, AgentPiece>();
  if (activeBundle) {
    for (const p of activeBundle.pieces) {
      piecesMap.set(p.agent_number, p);
    }
  }

  const activePieces = activeBundle?.pieces.filter((p) => p.status !== 'DISPENSADO') || [];
  const approvedCount = activePieces.filter((p) => p.status === 'APROVADO').length;
  const progressPct = activePieces.length > 0 ? Math.round((approvedCount / activePieces.length) * 100) : 0;

  return (
    <aside className="w-full lg:w-72 bg-[#071D41] text-white flex flex-col shrink-0 lg:h-screen lg:sticky lg:top-0 border-r border-slate-800 select-none">
      {/* Brand */}
      <div className="px-5 py-4 border-b border-white/10 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-[#1351B4] flex items-center justify-center shadow-inner border border-white/20">
          <Scale className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="font-bold text-sm tracking-tight text-white">GOVFLOW 14.133</div>
          <div className="text-[10px] text-blue-200 font-medium">
            Multi-Agente • Lei nº 14.133/2021
          </div>
        </div>
      </div>

      {/* Navegação Principal */}
      <nav className="p-3 space-y-1 border-b border-white/10">
        <button
          type="button"
          onClick={() => onNavigate('dashboard')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
            activeView === 'dashboard'
              ? 'bg-[#1351B4] text-white shadow-xs'
              : 'text-slate-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <FolderKanban className="w-4 h-4 shrink-0" />
          <span>Dashboard de Processos</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('institution')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
            activeView === 'institution'
              ? 'bg-[#1351B4] text-white shadow-xs'
              : 'text-slate-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Building2 className="w-4 h-4 shrink-0" />
          <span>Configurações da Prefeitura</span>
        </button>

        {currentUser.role === 'ADMIN' && (
          <button
            type="button"
            onClick={() => onNavigate('admin')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              activeView === 'admin'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-xs'
                : 'text-amber-200 hover:bg-white/10 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Painel Administrativo</span>
            </span>
            <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-white/15 uppercase">ADMIN</span>
          </button>
        )}

        <button
          type="button"
          onClick={onOpenAiSettings}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2.5">
            <Cpu className="w-4 h-4 shrink-0" />
            <span>Motor de Agentes</span>
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-blue-200 uppercase">
            {aiSettings
              ? aiSettings.provider === 'auto' || aiSettings.effectiveProvider !== aiSettings.provider
                ? `${aiSettings.provider} · ${aiSettings.effectiveProvider}`
                : aiSettings.provider
              : 'auto'}
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenOnlineModal}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 border border-emerald-400/25 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                onlineStatus?.test_mode !== false ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}
            />
            <span>Modo Teste Online</span>
          </span>
          <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/30 text-emerald-100 uppercase">
            {onlineStatus?.test_mode !== false ? 'ATIVO' : 'PAUSADO'}
          </span>
        </button>
      </nav>

      {/* Pipeline do Processo Atual */}
      {activeBundle ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-white/10 bg-[#0A2552]">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wider text-blue-200 font-semibold">
                Pipeline do Processo
              </div>
              <button
                type="button"
                onClick={onOpenCertameConfig}
                className="inline-flex items-center gap-1 text-[10px] text-blue-200 hover:text-white bg-white/10 px-2 py-0.5 rounded cursor-pointer"
              >
                <SlidersHorizontal className="w-3 h-3" />
                Certame
              </button>
            </div>
            <div className="text-xs font-bold text-white mt-1 truncate">
              Lic. {activeBundle.process.numero_processo_licitatorio} • PA {activeBundle.process.numero_processo_administrativo}
            </div>
            <div className="mt-2">
              <div className="flex justify-between text-[10px] text-blue-200 mb-1">
                <span>Progresso de Aprovação</span>
                <span className="font-semibold text-white">
                  {approvedCount}/{activePieces.length} ({progressPct}%)
                </span>
              </div>
              <div className="h-1.5 w-full bg-white/15 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-400 transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          </div>

          <div className="max-h-64 lg:max-h-none flex-1 overflow-y-auto p-2.5 space-y-1">
            {AGENT_DEFINITIONS.map((def) => {
              const piece = piecesMap.get(def.number);
              const status: AgentStatus = piece?.status || 'PENDENTE';
              const isRunning = runningAgentNumber === def.number;
              const isSelected = activeView === 'workspace' && selectedAgentNumber === def.number;
              const displayLabel = isRunning ? 'Gerando...' : AGENT_STATUS_LABELS[status];

              return (
                <button
                  key={def.number}
                  type="button"
                  onClick={() => {
                    onNavigate('workspace');
                    onSelectAgent(def.number);
                  }}
                  className={`w-full text-left px-2.5 py-2 rounded-lg transition-all flex items-start gap-2.5 cursor-pointer ${
                    isSelected
                      ? 'bg-white text-slate-900 shadow-sm'
                      : status === 'DISPENSADO'
                        ? 'opacity-55 hover:bg-white/5 text-slate-300'
                        : 'hover:bg-white/10 text-slate-100'
                  }`}
                >
                  <div className="mt-0.5">
                    <StatusIcon status={status} running={isRunning} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className={`text-[11px] font-bold truncate ${
                          isSelected ? 'text-[#071D41]' : 'text-white'
                        }`}
                      >
                        {String(def.number).padStart(2, '0')}. {def.shortName}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-1 mt-0.5">
                      <span
                        className={`text-[9.5px] truncate ${
                          isSelected ? 'text-slate-500' : 'text-blue-200/80'
                        }`}
                      >
                        {def.legalBasis.split(' da Lei')[0]}
                      </span>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded font-semibold shrink-0 ${statusPillClass(
                          status,
                          isRunning
                        )}`}
                      >
                        {displayLabel}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex-1 p-5 flex flex-col justify-center text-center text-xs text-blue-200/70">
          Selecione ou crie um processo no Dashboard para acompanhar a esteira dos 11 agentes autônomos.
        </div>
      )}

      {/* Rodapé do Usuário Logado */}
      <div className="p-3 border-t border-white/10 bg-[#061836] flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onOpenProfile}
          title="Minha Conta Individual e Senha"
          className="min-w-0 flex-1 text-left flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/10 transition-colors cursor-pointer"
        >
          <div className="w-7 h-7 rounded-full bg-[#1351B4] flex items-center justify-center shrink-0">
            <UserCog className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-white truncate">{currentUser.name}</div>
            <div className="text-[10px] text-blue-200 truncate">
              @{currentUser.username} • {currentUser.role === 'ADMIN' ? 'Admin' : 'Individual'}
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={onLogout}
          title="Sair do Sistema"
          className="p-2 rounded-lg text-slate-300 hover:text-rose-300 hover:bg-white/10 transition-colors cursor-pointer shrink-0"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
