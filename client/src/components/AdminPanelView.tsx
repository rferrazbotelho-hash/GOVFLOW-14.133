import React, { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  Edit3,
  FileText,
  Loader2,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
  Users,
  X
} from 'lucide-react';
import type {
  AdminOverview,
  AdminUserSummary,
  SupportTicketStatus,
  UserAccount,
  UserRole
} from '@shared/types';
import { formatCurrencyBRL, formatDateTimeBR, getModalidadeLabel } from '@shared/labels';
import { api } from '../api/client';

interface Props {
  currentUser: UserAccount;
  onOpenProcess: (processId: string) => void;
}

type AdminTab = 'users' | 'processes' | 'institutions' | 'audit' | 'tickets';

export const AdminPanelView: React.FC<Props> = ({ currentUser, onOpenProcess }) => {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<AdminTab>('users');
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  // Create / Edit User modal state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newDept, setNewDept] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('USER');
  const [newPassword, setNewPassword] = useState('');
  const [newActive, setNewActive] = useState(true);

  const [editingUser, setEditingUser] = useState<AdminUserSummary | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editDept, setEditDept] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('USER');
  const [editActive, setEditActive] = useState(true);
  const [editPassword, setEditPassword] = useState('');

  const [confirmDeleteUserId, setConfirmDeleteUserId] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [savingForm, setSavingForm] = useState(false);

  // Support tickets reply state
  const [selectedTicketId, setSelectedTicketId] = useState<string>('');
  const [ticketReply, setTicketReply] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  const loadOverview = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const data = await api.getAdminOverview();
      setOverview(data);
      if (data.tickets.length > 0 && !selectedTicketId) {
        setSelectedTicketId(data.tickets[0].id);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao carregar visão administrativa.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleActivateToggle = async (u: AdminUserSummary) => {
    setErrorMsg('');
    setInfoMsg('');
    setBusyUserId(u.id);
    try {
      const updated = await api.adminUpdateUser(u.id, { is_active: !u.is_active });
      setInfoMsg(
        `Usuário @${updated.username} ${updated.is_active ? 'ativado' : 'desativado'} com sucesso.`
      );
      await loadOverview();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao alterar status do usuário.');
    } finally {
      setBusyUserId(null);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    setSavingForm(true);
    try {
      const created = await api.adminCreateUser({
        username: newUsername.trim(),
        name: newName.trim(),
        email: newEmail.trim(),
        department: newDept.trim(),
        role: newRole,
        is_active: newActive,
        password: newPassword
      });
      setInfoMsg(`Usuário @${created.username} cadastrado com sucesso.`);
      setShowCreateForm(false);
      setNewUsername('');
      setNewName('');
      setNewEmail('');
      setNewDept('');
      setNewRole('USER');
      setNewPassword('');
      setNewActive(true);
      await loadOverview();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao cadastrar usuário.');
    } finally {
      setSavingForm(false);
    }
  };

  const startEditUser = (u: AdminUserSummary) => {
    setEditingUser(u);
    setEditName(u.name);
    setEditEmail(u.email);
    setEditDept(u.department);
    setEditRole(u.role);
    setEditActive(u.is_active);
    setEditPassword('');
  };

  const handleSaveEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setErrorMsg('');
    setInfoMsg('');
    setSavingForm(true);
    try {
      const updated = await api.adminUpdateUser(editingUser.id, {
        name: editName.trim(),
        email: editEmail.trim(),
        department: editDept.trim(),
        role: editRole,
        is_active: editActive,
        ...(editPassword.trim() ? { password: editPassword } : {})
      });
      setInfoMsg(`Dados do usuário @${updated.username} atualizados com sucesso.`);
      setEditingUser(null);
      await loadOverview();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao atualizar usuário.');
    } finally {
      setSavingForm(false);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    setErrorMsg('');
    setInfoMsg('');
    setBusyUserId(userId);
    try {
      await api.adminDeleteUser(userId);
      setConfirmDeleteUserId(null);
      setInfoMsg('Usuário removido do sistema.');
      await loadOverview();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao remover usuário.');
    } finally {
      setBusyUserId(null);
    }
  };

  const handleReplyTicket = async () => {
    if (!selectedTicketId || !ticketReply.trim()) return;
    setErrorMsg('');
    setSendingReply(true);
    try {
      await api.replySupportTicket(selectedTicketId, ticketReply.trim(), 'EM_ATENDIMENTO');
      setTicketReply('');
      await loadOverview();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao enviar resposta no chamado.');
    } finally {
      setSendingReply(false);
    }
  };

  const handleTicketStatusChange = async (ticketId: string, status: SupportTicketStatus) => {
    setErrorMsg('');
    try {
      await api.updateSupportTicketStatus(ticketId, status);
      await loadOverview();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao atualizar status do chamado.');
    }
  };

  if (loading && !overview) {
    return (
      <div className="p-8 flex items-center justify-center gap-2 text-sm text-slate-600">
        <Loader2 className="w-5 h-5 animate-spin text-[#1351B4]" />
        Carregando Painel Administrativo Global...
      </div>
    );
  }

  const stats = overview?.stats;
  const selectedTicket = overview?.tickets.find((t) => t.id === selectedTicketId) || null;

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
      {/* Cabeçalho Administrativo */}
      <div className="bg-[#071D41] text-white rounded-2xl p-6 flex flex-wrap items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-[#1351B4] border border-white/20 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-blue-200">
              Administração Global • Banco de Dados Interno
            </div>
            <h1 className="text-xl font-bold">Controle de Usuários & Monitoramento da Aplicação</h1>
            <p className="text-xs text-blue-200/90 mt-0.5">
              Sessão ativa: <strong>{currentUser.name}</strong> (@{currentUser.username})
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadOverview}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar Dados
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('users');
              setShowCreateForm(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#168821] hover:bg-[#126E1B] text-white text-xs font-bold cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Novo Usuário
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-xs text-rose-800 font-medium">
          {errorMsg}
        </div>
      )}
      {infoMsg && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-xs text-emerald-800 font-medium flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{infoMsg}</span>
        </div>
      )}

      {/* KPIs */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-[11px] font-semibold text-slate-500 flex items-center justify-between">
              <span>Usuários Cadastrados</span>
              <Users className="w-4 h-4 text-[#1351B4]" />
            </div>
            <div className="text-2xl font-bold text-[#071D41] mt-1">{stats.total_users}</div>
            <div className="text-[11px] text-slate-500 mt-1">
              <span className="text-emerald-700 font-semibold">{stats.active_users} ativos</span> •{' '}
              <span className={stats.pending_users > 0 ? 'text-amber-700 font-bold' : ''}>
                {stats.pending_users} pendentes
              </span>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-[11px] font-semibold text-slate-500 flex items-center justify-between">
              <span>Processos (Todos Usuários)</span>
              <FileText className="w-4 h-4 text-[#1351B4]" />
            </div>
            <div className="text-2xl font-bold text-[#071D41] mt-1">{stats.total_processes}</div>
            <div className="text-[11px] text-slate-500 mt-1">
              {stats.approved_pieces} / {stats.total_pieces} peças assinadas
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-[11px] font-semibold text-slate-500 flex items-center justify-between">
              <span>Prefeituras / Órgãos</span>
              <Building2 className="w-4 h-4 text-[#1351B4]" />
            </div>
            <div className="text-2xl font-bold text-[#071D41] mt-1">{stats.total_institutions}</div>
            <div className="text-[11px] text-slate-500 mt-1">Dados segregados por conta</div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-[11px] font-semibold text-slate-500 flex items-center justify-between">
              <span>Chamados de Suporte</span>
              <MessageSquare className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="text-2xl font-bold text-[#071D41] mt-1">{stats.total_tickets}</div>
            <div className="text-[11px] text-slate-500 mt-1">
              <span className={stats.open_tickets > 0 ? 'text-amber-700 font-bold' : ''}>
                {stats.open_tickets} em aberto
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Alerta de usuários pendentes */}
      {stats && stats.pending_users > 0 && (
        <div className="rounded-xl bg-amber-50 border border-amber-300 px-4 py-3 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              Há <strong>{stats.pending_users}</strong> novo(s) cadastro(s) aguardando ativação administrativa para acessar o sistema.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setTab('users')}
            className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold cursor-pointer"
          >
            Revisar e Ativar Usuários
          </button>
        </div>
      )}

      {/* Abas */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200">
        {(
          [
            { id: 'users', label: `Usuários & Ativações (${overview?.users.length || 0})`, icon: Users },
            { id: 'processes', label: `Processos Globais (${overview?.processes.length || 0})`, icon: FileText },
            { id: 'institutions', label: `Órgãos & IAs (${overview?.institutions.length || 0})`, icon: Building2 },
            { id: 'audit', label: `Auditoria Global (${overview?.audit_logs.length || 0})`, icon: Activity },
            { id: 'tickets', label: `Chamados (${overview?.tickets.length || 0})`, icon: MessageSquare }
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold rounded-t-lg border-b-2 transition-colors cursor-pointer ${
                tab === item.id
                  ? 'border-[#1351B4] text-[#1351B4] bg-white'
                  : 'border-transparent text-slate-600 hover:text-[#071D41]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Tab 1: Usuários */}
      {tab === 'users' && overview && (
        <div className="space-y-4">
          {showCreateForm && (
            <form
              onSubmit={handleCreateUser}
              className="bg-white rounded-xl border border-blue-200 p-5 space-y-3 shadow-xs"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-[#071D41]">Cadastrar Novo Usuário</h2>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Login *</label>
                  <input
                    required
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="joao.silva"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Nome Completo *</label>
                  <input
                    required
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="João Silva"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Senha Inicial *</label>
                  <input
                    required
                    minLength={6}
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Mínimo 6 caracteres"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">E-mail</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="joao@prefeitura.gov.br"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Setor / Secretaria</label>
                  <input
                    type="text"
                    value={newDept}
                    onChange={(e) => setNewDept(e.target.value)}
                    placeholder="Compras e Licitações"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Perfil</label>
                    <select
                      value={newRole}
                      onChange={(e) => setNewRole(e.target.value as UserRole)}
                      className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    >
                      <option value="USER">Usuário</option>
                      <option value="ADMIN">Administrador</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 pt-5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newActive}
                      onChange={(e) => setNewActive(e.target.checked)}
                    />
                    Ativo
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingForm}
                  className="px-4 py-1.5 rounded-lg bg-[#1351B4] text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  {savingForm ? 'Salvando...' : 'Criar Usuário'}
                </button>
              </div>
            </form>
          )}

          {editingUser && (
            <form
              onSubmit={handleSaveEditUser}
              className="bg-blue-50/60 rounded-xl border border-blue-300 p-5 space-y-3"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-[#071D41]">
                  Atualizar Usuário: @{editingUser.username}
                </h2>
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="text-slate-500 hover:text-slate-800 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Nome Completo</label>
                  <input
                    required
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">E-mail</label>
                  <input
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Setor / Secretaria</label>
                  <input
                    type="text"
                    value={editDept}
                    onChange={(e) => setEditDept(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Perfil de Acesso</label>
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value as UserRole)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                  >
                    <option value="USER">Usuário Individual</option>
                    <option value="ADMIN">Administrador Global</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Redefinir Senha (opcional)
                  </label>
                  <input
                    type="password"
                    minLength={6}
                    value={editPassword}
                    onChange={(e) => setEditPassword(e.target.value)}
                    placeholder="Deixe vazio para manter atual"
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs font-bold text-[#071D41] pt-5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editActive}
                    onChange={(e) => setEditActive(e.target.checked)}
                  />
                  Conta Ativa (Liberada)
                </label>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingForm}
                  className="px-4 py-1.5 rounded-lg bg-[#071D41] text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  {savingForm ? 'Salvando...' : 'Salvar Alterações'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Usuário</th>
                  <th className="px-4 py-3">Perfil & Status</th>
                  <th className="px-4 py-3">Espaço Individual</th>
                  <th className="px-4 py-3">Configuração IA</th>
                  <th className="px-4 py-3">Último Acesso</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overview.users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3">
                      <div className="font-bold text-[#071D41]">{u.name}</div>
                      <div className="text-[11px] text-slate-500">
                        @{u.username} {u.email ? `• ${u.email}` : ''}
                      </div>
                      {u.department && (
                        <div className="text-[10px] text-slate-400">{u.department}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                            u.role === 'ADMIN'
                              ? 'bg-[#071D41] text-white'
                              : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {u.role}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                            u.is_active
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {u.is_active ? 'Ativo' : 'Pendente / Inativo'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-slate-700">
                      <div>{u.institutions_count} órgão(s)</div>
                      <div>{u.processes_count} processo(s)</div>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-slate-600">
                      <div className="uppercase font-semibold">{u.ai_provider}</div>
                      <div className="text-[10px] text-slate-400">{u.ai_model}</div>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-slate-500">
                      {u.last_login_at ? formatDateTimeBR(u.last_login_at) : 'Nunca acessou'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {u.id !== currentUser.id && (
                          <button
                            type="button"
                            disabled={busyUserId === u.id}
                            onClick={() => handleActivateToggle(u)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold cursor-pointer ${
                              u.is_active
                                ? 'border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                                : 'bg-[#168821] hover:bg-[#126E1B] text-white'
                            }`}
                          >
                            {u.is_active ? (
                              <>
                                <UserX className="w-3 h-3" /> Desativar
                              </>
                            ) : (
                              <>
                                <UserCheck className="w-3 h-3" /> Ativar
                              </>
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startEditUser(u)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:border-[#1351B4] text-slate-700 text-[11px] font-semibold cursor-pointer"
                        >
                          <Edit3 className="w-3 h-3" />
                          Editar
                        </button>
                        {u.id !== currentUser.id &&
                          (confirmDeleteUserId === u.id ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleDeleteUser(u.id)}
                                className="px-2 py-1 rounded bg-rose-600 text-white text-[10px] font-bold cursor-pointer"
                              >
                                Confirmar
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteUserId(null)}
                                className="px-1.5 py-1 rounded border border-slate-300 bg-white text-[10px] cursor-pointer"
                              >
                                Não
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteUserId(u.id)}
                              title="Excluir usuário"
                              className="p-1.5 rounded-md border border-slate-300 text-slate-500 hover:text-rose-600 hover:border-rose-300 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 2: Processos Globais */}
      {tab === 'processes' && overview && (
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {overview.processes.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">Nenhum processo registrado.</div>
          ) : (
            overview.processes.map((proc) => (
              <div
                key={proc.id}
                className="p-4 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50/70"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-blue-50 border border-blue-200 text-[#1351B4] text-[11px] font-bold">
                      Lic. {proc.numero_processo_licitatorio}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-semibold">
                      Proprietário: @{proc.owner_username || 'admin'} ({proc.owner_name || 'Sistema'})
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {getModalidadeLabel(proc.modalidade)} • {proc.status_geral}
                    </span>
                  </div>
                  <div className="text-sm font-bold text-[#071D41]">{proc.titulo_resumido}</div>
                  <div className="text-[11px] text-slate-500">
                    {proc.institution_name} • {proc.secretaria_nome} • {formatCurrencyBRL(proc.valor_estimado_global)} • Peças assinadas: {proc.approved_count}/{proc.total_active_agents}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenProcess(proc.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#071D41] hover:bg-[#1351B4] text-white text-xs font-semibold cursor-pointer"
                >
                  Inspecionar na Esteira
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab 3: Órgãos & IAs */}
      {tab === 'institutions' && overview && (
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {overview.institutions.map((inst) => (
            <div key={inst.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-[#071D41]">
                  {inst.nome_fantasia || inst.razao_social}
                </div>
                <div className="text-xs text-slate-500">
                  CNPJ {inst.cnpj} • {inst.municipio}/{inst.uf} • Prefeito(a): {inst.prefeito_nome}
                </div>
              </div>
              <div className="text-right text-xs">
                <div className="font-semibold text-[#1351B4]">
                  Proprietário: @{inst.owner_username || 'admin'}
                </div>
                <div className="text-[11px] text-slate-500">{inst.owner_name}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tab 4: Auditoria Global */}
      {tab === 'audit' && overview && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Data/Hora</th>
                <th className="px-4 py-2.5">Ação</th>
                <th className="px-4 py-2.5">Processo</th>
                <th className="px-4 py-2.5">Ator</th>
                <th className="px-4 py-2.5">Detalhes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {overview.audit_logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-2.5 whitespace-nowrap text-[11px] text-slate-500">
                    {formatDateTimeBR(log.created_at)}
                  </td>
                  <td className="px-4 py-2.5 font-bold text-[#1351B4] text-[11px]">{log.action}</td>
                  <td className="px-4 py-2.5 text-[11px]">
                    {log.numero_processo_licitatorio || log.process_id.slice(0, 8)}{' '}
                    {log.owner_username ? `(@${log.owner_username})` : ''}
                  </td>
                  <td className="px-4 py-2.5 text-[11px]">{log.actor_name}</td>
                  <td className="px-4 py-2.5 text-[11px] text-slate-600">{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tab 5: Chamados */}
      {tab === 'tickets' && overview && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden grid md:grid-cols-[290px_1fr] min-h-[340px]">
          <div className="border-r border-slate-200 divide-y divide-slate-100 max-h-[460px] overflow-y-auto">
            {overview.tickets.length === 0 ? (
              <div className="p-6 text-xs text-slate-500 text-center">Nenhum chamado aberto.</div>
            ) : (
              overview.tickets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedTicketId(t.id)}
                  className={`w-full text-left p-3.5 cursor-pointer ${
                    selectedTicketId === t.id ? 'bg-blue-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#1351B4]">
                      {t.channel === 'EMAIL' ? <Mail className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
                      {t.channel}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        t.status === 'RESOLVIDO'
                          ? 'bg-emerald-100 text-emerald-800'
                          : t.status === 'EM_ATENDIMENTO'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {t.status}
                    </span>
                  </div>
                  <div className="font-bold text-xs text-[#071D41] mt-1 truncate">{t.subject}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                    {t.requester_name} ({t.requester_email})
                  </div>
                </button>
              ))
            )}
          </div>

          {selectedTicket ? (
            <div className="p-4 flex flex-col justify-between gap-3">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-200">
                  <div>
                    <div className="text-sm font-bold text-[#071D41]">{selectedTicket.subject}</div>
                    <div className="text-[11px] text-slate-500">
                      De: <strong>{selectedTicket.requester_name}</strong> ({selectedTicket.requester_email}
                      {selectedTicket.requester_phone ? ` • ${selectedTicket.requester_phone}` : ''})
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {(['ABERTO', 'EM_ATENDIMENTO', 'RESOLVIDO'] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => handleTicketStatusChange(selectedTicket.id, st)}
                        className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                          selectedTicket.status === st
                            ? 'bg-[#071D41] text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {selectedTicket.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-xl px-3.5 py-2.5 text-xs ${
                        m.sender_role === 'ADMIN'
                          ? 'bg-blue-50 border border-blue-200'
                          : 'bg-slate-100'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 mb-1">
                        <span>{m.sender_name}</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDateTimeBR(m.created_at)}
                        </span>
                      </div>
                      <div className="text-slate-800 whitespace-pre-wrap">{m.message}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-slate-200">
                <input
                  type="text"
                  value={ticketReply}
                  onChange={(e) => setTicketReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleReplyTicket();
                  }}
                  placeholder="Responder chamado para o usuário..."
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-[#1351B4] focus:outline-none"
                />
                <button
                  type="button"
                  disabled={sendingReply || !ticketReply.trim()}
                  onClick={handleReplyTicket}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1351B4] hover:bg-[#071D41] disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
                >
                  {sendingReply ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  Responder
                </button>
              </div>
            </div>
          ) : (
            <div className="p-8 flex items-center justify-center text-xs text-slate-500">
              Selecione um chamado ao lado para visualizar o histórico e responder.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
