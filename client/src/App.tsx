import React, { useCallback, useEffect, useState } from 'react';
import type { AiSettings, Institution, PlatformOnlineStatus, ProcessBundle } from '@shared/types';
import { api, type ProcessListItem } from './api/client';
import { Sidebar, type AppView } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { InstitutionSetupView } from './components/InstitutionSetupView';
import { ProcessWorkspaceView } from './components/ProcessWorkspaceView';
import { CertameConfigModal } from './components/CertameConfigModal';
import { AiSettingsModal } from './components/AiSettingsModal';
import { OnlineTestModal } from './components/OnlineTestModal';

export function App() {
  const [activeView, setActiveView] = useState<AppView>('dashboard');
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [activeInstitutionId, setActiveInstitutionId] = useState<string>('');
  const [processes, setProcesses] = useState<ProcessListItem[]>([]);
  const [activeBundle, setActiveBundle] = useState<ProcessBundle | null>(null);
  const [selectedAgentNumber, setSelectedAgentNumber] = useState<number>(1);
  const [runningAgentNumber, setRunningAgentNumber] = useState<number | null>(null);

  const [showCertameModal, setShowCertameModal] = useState(false);
  const [certameEditMode, setCertameEditMode] = useState(false);
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [showOnlineModal, setShowOnlineModal] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState<PlatformOnlineStatus | null>(null);

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

    if (!activeInstitutionId && instList.length > 0) {
      setActiveInstitutionId(instList[0].id);
    }
    return { instList, procList };
  }, [activeInstitutionId]);

  useEffect(() => {
    loadAll().then(({ procList }) => {
      if (procList.length > 0 && !activeBundle) {
        api.getProcess(procList[0].id).then(setActiveBundle).catch(() => {});
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openProcess = async (processId: string) => {
    const bundle = await api.getProcess(processId);
    setActiveBundle(bundle);
    setActiveInstitutionId(bundle.institution.id);
    const firstPending = bundle.pieces.find(
      (p) => p.status !== 'APROVADO' && p.status !== 'DISPENSADO'
    );
    setSelectedAgentNumber(firstPending ? firstPending.agent_number : 1);
    setActiveView('workspace');
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

  const activeInstitution =
    institutions.find((i) => i.id === activeInstitutionId) || institutions[0] || null;

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[#F3F6FA]">
      <Sidebar
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
        aiSettings={aiSettings}
        onlineStatus={onlineStatus}
      />

      <main className="flex-1 min-w-0 flex flex-col">
        {activeView === 'dashboard' && (
          <DashboardView
            processes={processes}
            activeInstitution={activeInstitution}
            onlineStatus={onlineStatus}
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
    </div>
  );
}

export default App;
