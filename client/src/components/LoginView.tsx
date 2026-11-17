import React, { useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  LogIn,
  Scale,
  ShieldCheck,
  UserPlus
} from 'lucide-react';
import type { UserAccount } from '@shared/types';
import { api } from '../api/client';

interface Props {
  onAuthenticated: (user: UserAccount, goToAdmin?: boolean) => void;
}

type AuthTab = 'login' | 'admin' | 'register';

export const LoginView: React.FC<Props> = ({ onAuthenticated }) => {
  const [tab, setTab] = useState<AuthTab>('login');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Register fields
  const [regName, setRegName] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regDept, setRegDept] = useState('');
  const [regPassword, setRegPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    setLoading(true);
    try {
      const res = await api.login(username.trim(), password);
      if (tab === 'admin' && res.user.role !== 'ADMIN') {
        await api.logout().catch(() => {});
        setErrorMsg(
          'Esta conta possui perfil de Usuário padrão. Utilize a aba "Entrar" para sua área individual ou informe credenciais de Administrador.'
        );
        return;
      }
      onAuthenticated(res.user, tab === 'admin');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Não foi possível validar login e senha.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    setLoading(true);
    try {
      const res = await api.register({
        username: regUsername.trim(),
        name: regName.trim(),
        email: regEmail.trim(),
        department: regDept.trim(),
        password: regPassword
      });
      setInfoMsg(res.message);
      setRegName('');
      setRegUsername('');
      setRegEmail('');
      setRegDept('');
      setRegPassword('');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao solicitar cadastro de usuário.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F3F6FA] flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-4xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden grid md:grid-cols-[1.05fr_1.1fr]">
        {/* Painel Institucional */}
        <div className="bg-[#071D41] text-white p-7 sm:p-8 flex flex-col justify-between gap-6">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-[#1351B4] flex items-center justify-center border border-white/20 shadow-inner">
                <Scale className="w-6 h-6 text-white" />
              </div>
              <div>
                <div className="text-base font-bold tracking-tight">GOVFLOW 14.133</div>
                <div className="text-[11px] text-blue-200 font-medium">
                  Plataforma Multi-Agente de Contratações Públicas
                </div>
              </div>
            </div>

            <div className="pt-2 space-y-2.5">
              <h1 className="text-xl font-bold leading-snug">
                Ambiente Individual Seguro & Controle Administrativo Centralizado
              </h1>
              <p className="text-xs text-blue-100/90 leading-relaxed">
                Cada usuário acessa exclusivamente suas próprias prefeituras, processos licitatórios, peças jurídicas geradas e configurações de Inteligência Artificial.
              </p>
            </div>
          </div>

          <div className="space-y-2.5 text-xs text-blue-100/90 border-t border-white/15 pt-4">
            <div className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-emerald-300 shrink-0" />
              <span>Banco de dados interno gerido pelo Administrador do sistema</span>
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-amber-300 shrink-0" />
              <span>Novos usuários passam por ativação administrativa antes do acesso</span>
            </div>
          </div>
        </div>

        {/* Formulário de Acesso */}
        <div className="p-6 sm:p-8 flex flex-col justify-center space-y-5">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => {
                setTab('login');
                setErrorMsg('');
                setInfoMsg('');
              }}
              className={`inline-flex items-center justify-center gap-1 py-2 px-2 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                tab === 'login' ? 'bg-white text-[#1351B4] shadow-2xs' : 'text-slate-600 hover:text-[#071D41]'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" />
              Entrar
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('admin');
                setErrorMsg('');
                setInfoMsg('');
                if (!username) setUsername('admin');
              }}
              className={`inline-flex items-center justify-center gap-1 py-2 px-2 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                tab === 'admin' ? 'bg-[#071D41] text-white shadow-2xs' : 'text-slate-600 hover:text-[#071D41]'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Administração
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('register');
                setErrorMsg('');
                setInfoMsg('');
              }}
              className={`inline-flex items-center justify-center gap-1 py-2 px-2 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                tab === 'register' ? 'bg-white text-[#1351B4] shadow-2xs' : 'text-slate-600 hover:text-[#071D41]'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              Solicitar Acesso
            </button>
          </div>

          {errorMsg && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2.5 text-xs text-rose-800 font-medium">
              {errorMsg}
            </div>
          )}

          {infoMsg && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-xs text-emerald-800 font-medium flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{infoMsg}</span>
            </div>
          )}

          {(tab === 'login' || tab === 'admin') && (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <h2 className="text-base font-bold text-[#071D41]">
                  {tab === 'admin' ? 'Acesso Administrativo Global' : 'Login do Usuário'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tab === 'admin'
                    ? 'Audite todas as informações da plataforma, ative novos usuários e responda chamados.'
                    : 'Entre com seu usuário e senha para acessar sua área individual.'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Usuário (Login)
                </label>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={tab === 'admin' ? 'admin' : 'seu.usuario'}
                  autoComplete="username"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-[#1351B4] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Senha</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-9 text-xs focus:border-[#1351B4] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className={`w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold text-white cursor-pointer disabled:opacity-50 ${
                  tab === 'admin'
                    ? 'bg-[#071D41] hover:bg-[#1351B4]'
                    : 'bg-[#1351B4] hover:bg-[#071D41]'
                }`}
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
                {tab === 'admin' ? 'Entrar no Painel Administrativo' : 'Entrar no Sistema'}
              </button>
            </form>
          )}

          {tab === 'register' && (
            <form onSubmit={handleRegisterSubmit} className="space-y-3">
              <div>
                <h2 className="text-base font-bold text-[#071D41]">Solicitar Novo Usuário</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Seu cadastro será enviado ao Administrador para atualização e ativação de acesso.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Nome Completo *
                  </label>
                  <input
                    type="text"
                    required
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="Ex.: Maria Oliveira"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Login Desejado *
                  </label>
                  <input
                    type="text"
                    required
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="maria.oliveira"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">E-mail</label>
                  <input
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="maria@prefeitura.gov.br"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Setor / Secretaria
                  </label>
                  <input
                    type="text"
                    value={regDept}
                    onChange={(e) => setRegDept(e.target.value)}
                    placeholder="Licitações / Saúde"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Senha (mínimo 6 caracteres) *
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  placeholder="Crie uma senha forte"
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#168821] hover:bg-[#126E1B] disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                Enviar Cadastro para Ativação
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
