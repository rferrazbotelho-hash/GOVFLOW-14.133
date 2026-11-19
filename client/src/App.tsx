import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type {
  AiSettings,
  Institution,
  PlatformOnlineStatus,
  ProcessBundle,
  UserAccount
} from '@shared/types';
import { api, setUnauthorizedHandler, type ProcessListItem } from './api/client';
import { Sidebar, type AppView } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { InstitutionSetupView } from './components/InstitutionSetupView';
import { ProcessWorkspaceView } from './components/ProcessWorkspaceView';
import { ContractAnalysisView } from './components/ContractAnalysisView';
import { AdminPanelView } from './components/AdminPanelView';
import { CertameConfigModal } from './components/CertameConfigModal';
import { AiSettingsModal } from './components/AiSettingsModal';
import { OnlineTestModal } from './components/OnlineTestModal';
import { LoginView } from './components/LoginView';
import { UserProfileModal } from './components/UserProfileModal';
import { AppInfoSupportWidget } from './components/AppInfoSupportWidget';

export function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);

  const [activeView, setActiveView] = useState<AppView>('dashboard');
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [activeInstitutionId, setActiveInstitutionId] = useState<string>('');
  const [processes, setProcesses] = useState<ProcessListItem[]>([]);
  const [activeBundle, setActiveBundle] = useState<ProcessBundle | null>(null);
  const [selectedAgentNumber, setSelectedAgentNumber] = useState<number>(1);
  const [runningAgentNumber, setRunningAgentNumber] = useState<number | null>(null);
  const [openingProcessId, setOpeningProcessId] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState('');

  const [showCertameModal, setShowCertameModal] = useState(false);
  const [certameEditMode, setCertameEditMode] = useState(false);
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [showOnlineModal, setShowOnlineModal] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState<PlatformOnlineStatus | null>(null);

  const clearWorkspaceState = useCallback(() => {
    setInstitutions([]);
    setActiveInstitutionId('');
    setProcesses([]);
    setActiveBundle(null);
    setOpeningProcessId(null);
    setWorkspaceError('');
    setAiSettings(null);
    setOnlineStatus(null);
    setActiveView('dashboard');
    setShowCertameModal(false);
    setShowAiModal(false);
    setShowOnlineModal(false);
    setShowProfileModal(false);
  }, []);

  const loadAll = useCallback(async () => {
    const [instList, procList, ai, online] = await Promise.all([
      api.listInstitutions(),
      api.listProcesses(),
      api.getAiSettings(),
      api.getOnlineStatus(false).catch(() => null)
    ]);
    setInstitutions(instList);
    setProcesses(procList);
    setAiSettings(ai);
    if (online) setOnlineStatus(online);

    setActiveInstitutionId((prev) => {
      if (prev && instList.some((i) => i.id === prev)) return prev;
      return instList[0]?.id || '';
    });
    return { instList, procList };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCurrentUser(null);
      clearWorkspaceState();
    });
    return () => setUnauthorizedHandler(null);
  }, [clearWorkspaceState]);

  useEffect(() => {
    let active = true;
    api
      .getMe()
      .then(async (me) => {
        if (!active) return;
        if (me.authenticated && me.user) {
          setCurrentUser(me.user);
          const { procList } = await loadAll();
          if (active && procList.length > 0) {
            api.getProcess(procList[0].id).then((b) => active && setActiveBundle(b)).catch(() => {});
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setAuthChecking(false);
      });
    return () => {
      active = false;
    };
  }, [loadAll]);

  const handleAuthenticated = async (user: UserAccount, goToAdmin = false) => {
    clearWorkspaceState();
    setCurrentUser(user);
    const { procList } = await loadAll();
    if (procList.length > 0) {
      api.getProcess(procList[0].id).then(setActiveBundle).catch(() => {});
    }
    setActiveView(goToAdmin && user.role === 'ADMIN' ? 'admin' : 'dashboard');
  };

  const handleLogout = async () => {
    await api.logout().catch(() => {});
    setCurrentUser(null);
    clearWorkspaceState();
  };

  const openProcess = async (processId: string) => {
    setWorkspaceError('');
    setOpeningProcessId(processId);
    try {
      const bundle = await api.getProcess(processId);
      if (!bundle || !bundle.process || !bundle.institution) {
        throw new Error('Dados incompletos do processo retornados pelo servidor.');
      }
      setActiveBundle(bundle);
      setActiveInstitutionId(bundle.institution.id);
      const pieces = Array.isArray(bundle.pieces) ? bundle.pieces : [];
      const firstPending = pieces.find(
        (p) => p.status !== 'APROVADO' && p.status !== 'DISPENSADO'
      );
      setSelectedAgentNumber(firstPending ? firstPending.agent_number : pieces[0]?.agent_number ?? 1);
      setActiveView('workspace');
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Não foi possível abrir a esteira do processo.';
      setWorkspaceError(msg);
    } finally {
      setOpeningProcessId(null);
    }
  };

  const handleBundleUpdated = async (updated: ProcessBundle) => {
    setActiveBundle(updated);
    const procList = await api.listProcesses();
    setProcesses(procList);
  };

  const handleInstitutionUpdated = async () => {
    await loadAll();
    if (activeBundle) {
      const refreshed = await api.getProcess(activeBundle.process.id);
      setActiveBundle(refreshed);
    }
  };

  const handleDeleteProcess = async (processId: string) => {
    await api.deleteProcess(processId);
    if (activeBundle?.process.id === processId) {
      setActiveBundle(null);
    }
    await loadAll();
  };

  const handleCloneProcess = async (processId: string) => {
    const cloned = await api.cloneProcess(processId);
    await loadAll();
    await openProcess(cloned.process.id);
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#F3F6FA] flex items-center justify-center">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-[#071D41]">
          <Loader2 className="w-5 h-5 animate-spin text-[#1351B4]" />
          Verificando sessão GOVFLOW 14.133...
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <>
        <LoginView onAuthenticated={handleAuthenticated} />
        <AppInfoSupportWidget currentUser={null} />
      </>
    );
  }

  const activeInstitution =
    institutions.find((i) => i.id === activeInstitutionId) || institutions[0] || null;

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[#F3F6FA]">
      <Sidebar
        currentUser={currentUser}
        activeView={activeView}
        onNavigate={setActiveView}
        activeBundle={activeBundle}
        selectedAgentNumber={selectedAgentNumber}
        runningAgentNumber={runningAgentNumber}
        onSelectAgent={(num) => setSelectedAgentNumber(num)}
        onOpenCertameConfig={() => {
          setCertameEditMode(true);
          setShowCertameModal(true);
        }}
        onOpenAiSettings={() => setShowAiModal(true)}
        onOpenOnlineModal={() => setShowOnlineModal(true)}
        onOpenProfile={() => setShowProfileModal(true)}
        onLogout={handleLogout}
        aiSettings={aiSettings}
        onlineStatus={onlineStatus}
      />

      <main className="flex-1 min-w-0 flex flex-col pb-12">
        {activeView === 'dashboard' && (
          <DashboardView
            processes={processes}
            activeInstitution={activeInstitution}
            onlineStatus={onlineStatus}
            openingProcessId={openingProcessId}
            openError={workspaceError}
            onDismissOpenError={() => setWorkspaceError('')}
            onOpenProcess={openProcess}
            onNewProcess={() => {
              setCertameEditMode(false);
              setShowCertameModal(true);
            }}
            onOpenInstitutionSetup={() => setActiveView('institution')}
            onOpenOnlineModal={() => setShowOnlineModal(true)}
            onDeleteProcess={handleDeleteProcess}
            onCloneProcess={handleCloneProcess}
          />
        )}

        {activeView === 'institution' && (
          <InstitutionSetupView
            institutions={institutions}
            activeInstitutionId={activeInstitution?.id || ''}
            onSelectInstitution={setActiveInstitutionId}
            onInstitutionUpdated={handleInstitutionUpdated}
          />
        )}

        {activeView === 'contracts' && (
          <ContractAnalysisView
            activeInstitution={activeInstitution}
            processes={processes}
          />
        )}

        {activeView === 'admin' && currentUser.role === 'ADMIN' && (
          <AdminPanelView
            currentUser={currentUser}
            openingProcessId={openingProcessId}
            openError={workspaceError}
            onDismissOpenError={() => setWorkspaceError('')}
            onOpenProcess={openProcess}
          />
        )}

        {activeView === 'workspace' && activeBundle && (
          <ProcessWorkspaceView
            bundle={activeBundle}
            selectedAgentNumber={selectedAgentNumber}
            runningAgentNumber={runningAgentNumber}
            onSelectAgent={setSelectedAgentNumber}
            onRunningChange={setRunningAgentNumber}
            onBundleUpdated={handleBundleUpdated}
            onOpenCertameConfig={() => {
              setCertameEditMode(true);
              setShowCertameModal(true);
            }}
          />
        )}
      </main>

      {showCertameModal && activeInstitution && (
        <CertameConfigModal
          institutionId={activeInstitution.id}
          existingProcess={certameEditMode && activeBundle ? activeBundle.process : null}
          onClose={() => setShowCertameModal(false)}
          onSaved={async (procId) => {
            await loadAll();
            await openProcess(procId);
          }}
        />
      )}

      {showAiModal && aiSettings && (
        <AiSettingsModal
          settings={aiSettings}
          onClose={() => setShowAiModal(false)}
          onSaved={setAiSettings}
        />
      )}

      {showOnlineModal && (
        <OnlineTestModal
          status={onlineStatus}
          institutionId={activeInstitution?.id}
          onClose={() => setShowOnlineModal(false)}
          onStatusUpdated={setOnlineStatus}
          onOpenSandboxProcess={async (procId) => {
            await loadAll();
            await openProcess(procId);
          }}
        />
      )}

      {showProfileModal && (
        <UserProfileModal
          user={currentUser}
          onClose={() => setShowProfileModal(false)}
          onUpdated={setCurrentUser}
        />
      )}

      <AppInfoSupportWidget currentUser={currentUser} />
    </div>
  );
}

export default App;
