import type {
  AdminOverview,
  AdminUserSummary,
  AgentPiece,
  AiConnectivityTestResult,
  AiGeminiResetResult,
  AiSettings,
  AppInfo,
  Dotacao,
  Institution,
  ParsedPriceResearchResult,
  PieceVersion,
  PlatformOnlineStatus,
  ProcessBundle,
  ProcurementProcess,
  Secretario,
  SupportChannel,
  SupportTicket,
  SupportTicketStatus,
  TcuJurisprudenceTheme,
  TcuPrecedent,
  UserAccount,
  UserRole
} from '@shared/types';

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers || {})
    }
  });
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/') && unauthorizedHandler) {
      unauthorizedHandler();
    }
    let msg = `Erro HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface ProcessListItem extends ProcurementProcess {
  institution_name: string;
  secretaria_nome: string;
  approved_count: number;
  total_active_agents: number;
}

export const api = {
  // CNPJ & Institution
  lookupCnpj: (cnpj: string) =>
    request<{
      cnpj: string;
      razao_social: string;
      nome_fantasia: string;
      endereco_completo: string;
      cep: string;
      municipio: string;
      uf: string;
      telefone: string;
      email: string;
      situacao_cadastral: string;
      fonte: string;
    }>(`/api/cnpj/${encodeURIComponent(cnpj.replace(/\D/g, ''))}`),

  listInstitutions: () => request<Institution[]>('/api/institutions'),

  getInstitutionDetail: (id: string) =>
    request<{
      institution: Institution;
      secretarios: Secretario[];
      dotacoes: Dotacao[];
    }>(`/api/institutions/${id}`),

  createInstitution: (data: Partial<Institution>) =>
    request<Institution>('/api/institutions', {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  updateInstitution: (id: string, data: Partial<Institution>) =>
    request<Institution>(`/api/institutions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),

  uploadLogoFile: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('logo', file);
    return request<Institution>(`/api/institutions/${id}/logo`, {
      method: 'POST',
      body: fd
    });
  },

  // Secretários
  createSecretario: (instId: string, data: Partial<Secretario>) =>
    request<Secretario>(`/api/institutions/${instId}/secretarios`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  updateSecretario: (instId: string, secId: string, data: Partial<Secretario>) =>
    request<Secretario>(`/api/institutions/${instId}/secretarios/${secId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),

  deleteSecretario: (instId: string, secId: string) =>
    request<{ ok: boolean }>(`/api/institutions/${instId}/secretarios/${secId}`, {
      method: 'DELETE'
    }),

  // Dotações
  createDotacao: (instId: string, data: Partial<Dotacao>) =>
    request<Dotacao>(`/api/institutions/${instId}/dotacoes`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  updateDotacao: (instId: string, dotId: string, data: Partial<Dotacao>) =>
    request<Dotacao>(`/api/institutions/${instId}/dotacoes/${dotId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),

  deleteDotacao: (instId: string, dotId: string) =>
    request<{ ok: boolean }>(`/api/institutions/${instId}/dotacoes/${dotId}`, {
      method: 'DELETE'
    }),

  // Scraping & Import
  scrapePortal: (instId: string, url: string, autoSave: boolean) =>
    request<{
      source_url: string;
      page_title: string;
      secretarios: any[];
      dotacoes: any[];
      diagnostics: string[];
      saved: boolean;
      secretarios_atualizados: Secretario[];
      dotacoes_atualizadas: Dotacao[];
    }>(`/api/institutions/${instId}/scrape`, {
      method: 'POST',
      body: JSON.stringify({ url, autoSave })
    }),

  importData: (instId: string, target: 'secretarios' | 'dotacoes', format: 'csv' | 'json', content: string) =>
    request<{ imported: number; items: any[] }>(`/api/institutions/${instId}/import`, {
      method: 'POST',
      body: JSON.stringify({ target, format, content })
    }),

  // Processes
  listProcesses: () => request<ProcessListItem[]>('/api/processes'),

  createProcess: (data: Partial<ProcurementProcess>) =>
    request<ProcessBundle>('/api/processes', {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  getProcess: (id: string) => request<ProcessBundle>(`/api/processes/${id}`),

  updateProcess: (id: string, data: Partial<ProcurementProcess>) =>
    request<ProcessBundle>(`/api/processes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),

  deleteProcess: (id: string) =>
    request<{ ok: boolean }>(`/api/processes/${id}`, {
      method: 'DELETE'
    }),

  cloneProcess: (
    id: string,
    opts?: { numero_processo_licitatorio?: string; titulo_resumido?: string }
  ) =>
    request<ProcessBundle>(`/api/processes/${id}/clone`, {
      method: 'POST',
      body: JSON.stringify(opts || {})
    }),

  downloadExportFile: async (url: string, fallbackFilename: string): Promise<string> => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      let msg = `Erro HTTP ${res.status} ao gerar arquivo.`;
      try {
        const data = await res.json();
        if (data?.error) msg = data.error;
      } catch {
        // ignore non-JSON error
      }
      throw new Error(msg);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)"?/i);
    const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, '').trim()) : fallbackFilename;

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    return filename;
  },

  parsePriceResearch: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<ParsedPriceResearchResult>('/api/price-research/parse', {
      method: 'POST',
      body: fd
    });
  },

  uploadProcessPriceResearch: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ parsed: ParsedPriceResearchResult; bundle: ProcessBundle }>(
      `/api/processes/${id}/price-research`,
      {
        method: 'POST',
        body: fd
      }
    );
  },

  // Agents
  executeAllAgents: (
    processId: string,
    payload?: { actorName?: string; actorRole?: string; autoApprove?: boolean; feedback?: string }
  ) =>
    request<{ executed_agents: number[]; bundle: ProcessBundle }>(
      `/api/processes/${processId}/agents/execute-all`,
      {
        method: 'POST',
        body: JSON.stringify(payload || {})
      }
    ),

  executeAgent: (
    processId: string,
    agentNumber: number,
    payload?: {
      feedback?: string;
      actorName?: string;
      estimativaPreliminar?: number;
      dataPretendida?: string;
      prioridade?: 'Baixo' | 'Médio' | 'Alto';
      pesquisaMercado?: string;
    }
  ) =>
    request<{ piece: AgentPiece; bundle: ProcessBundle }>(
      `/api/processes/${processId}/agents/${agentNumber}/execute`,
      {
        method: 'POST',
        body: JSON.stringify(payload || {})
      }
    ),

  savePieceEdit: (
    processId: string,
    agentNumber: number,
    payload: { html_content: string; actorName?: string; changeSummary?: string }
  ) =>
    request<{ piece: AgentPiece; bundle: ProcessBundle }>(
      `/api/processes/${processId}/agents/${agentNumber}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload)
      }
    ),

  approvePiece: (
    processId: string,
    agentNumber: number,
    payload: { actorName: string; actorRole: string }
  ) =>
    request<{ piece: AgentPiece; bundle: ProcessBundle }>(
      `/api/processes/${processId}/agents/${agentNumber}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    ),

  listVersions: (processId: string, agentNumber: number) =>
    request<PieceVersion[]>(`/api/processes/${processId}/agents/${agentNumber}/versions`),

  restoreVersion: (processId: string, agentNumber: number, versionNumber: number, actorName?: string) =>
    request<{ piece: AgentPiece; bundle: ProcessBundle }>(
      `/api/processes/${processId}/agents/${agentNumber}/restore`,
      {
        method: 'POST',
        body: JSON.stringify({ versionNumber, actorName })
      }
    ),

  // AI Settings
  getAiSettings: () => request<AiSettings>('/api/settings/ai'),

  updateAiSettings: (data: {
    provider?: 'auto' | 'local' | 'gemini' | 'openai';
    geminiApiKey?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    openaiBaseUrl?: string;
  }) =>
    request<AiSettings>('/api/settings/ai', {
      method: 'PUT',
      body: JSON.stringify(data)
    }),

  testAiSettings: () =>
    request<AiConnectivityTestResult>('/api/settings/ai/test', {
      method: 'POST'
    }),

  resetGeminiCredentials: (options?: { setAutoProvider?: boolean; resetModel?: boolean }) =>
    request<AiGeminiResetResult>('/api/settings/ai/gemini/reset', {
      method: 'POST',
      body: JSON.stringify(options ?? { setAutoProvider: true })
    }),

  // Jurisprudência TCU
  searchTcuAcordaos: (params?: { q?: string; tema?: string; live?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.tema && params.tema !== 'ALL') qs.set('tema', params.tema);
    if (params?.live) qs.set('live', '1');
    const queryStr = qs.toString();
    return request<{
      items: TcuPrecedent[];
      total: number;
      themes: Array<{ value: TcuJurisprudenceTheme; label: string }>;
      live_consulted: boolean;
      live_diagnostics: string;
    }>(`/api/tcu/acordaos${queryStr ? `?${queryStr}` : ''}`);
  },

  // Plataforma / Modo Teste Online
  getOnlineStatus: (probe = false) =>
    request<PlatformOnlineStatus>(`/api/platform/online-status${probe ? '?probe=1' : ''}`),

  setOnlineTestMode: (enabled: boolean) =>
    request<PlatformOnlineStatus>('/api/platform/online-test-mode', {
      method: 'PUT',
      body: JSON.stringify({ enabled })
    }),

  createSandboxProcess: (data?: { institutionId?: string; autoRunAll?: boolean; autoApprove?: boolean }) =>
    request<{ created_sandbox: boolean; executed_agents: number[]; bundle: ProcessBundle }>(
      '/api/platform/sandbox-test',
      {
        method: 'POST',
        body: JSON.stringify(data || {})
      }
    ),

  // Informações do App, Autenticação, Administração e Chamados
  getAppInfo: () => request<AppInfo>('/api/app-info'),

  getMe: () => request<{ authenticated: boolean; user: UserAccount | null }>('/api/auth/me'),

  login: (username: string, password: string) =>
    request<{ authenticated: boolean; user: UserAccount; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    }),

  register: (data: {
    username: string;
    name: string;
    email?: string;
    department?: string;
    password: string;
  }) =>
    request<{ ok: boolean; user: UserAccount; message: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  logout: () =>
    request<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST'
    }),

  updateOwnProfile: (data: {
    name?: string;
    email?: string;
    department?: string;
    currentPassword?: string;
    newPassword?: string;
  }) =>
    request<{ user: UserAccount }>('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(data)
    }),

  getAdminOverview: () => request<AdminOverview>('/api/admin/overview'),

  adminCreateUser: (data: {
    username: string;
    name: string;
    email?: string;
    department?: string;
    role: UserRole;
    is_active: boolean;
    password: string;
  }) =>
    request<AdminUserSummary>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  adminUpdateUser: (
    userId: string,
    data: {
      name?: string;
      email?: string;
      department?: string;
      role?: UserRole;
      is_active?: boolean;
      password?: string;
    }
  ) =>
    request<AdminUserSummary>(`/api/admin/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),

  adminActivateUser: (userId: string) =>
    request<AdminUserSummary>(`/api/admin/users/${userId}/activate`, {
      method: 'POST'
    }),

  adminDeleteUser: (userId: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}`, {
      method: 'DELETE'
    }),

  listSupportTickets: () => request<SupportTicket[]>('/api/support/tickets'),

  createSupportTicket: (data: {
    requester_name?: string;
    requester_email?: string;
    requester_phone?: string;
    channel: SupportChannel;
    subject: string;
    message: string;
  }) =>
    request<{ ticket: SupportTicket }>('/api/support/tickets', {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  replySupportTicket: (ticketId: string, message: string, status?: SupportTicketStatus) =>
    request<{ ticket: SupportTicket }>(`/api/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message, status })
    }),

  updateSupportTicketStatus: (ticketId: string, status: SupportTicketStatus) =>
    request<{ ticket: SupportTicket }>(`/api/support/tickets/${ticketId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    })
};
