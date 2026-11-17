import React, { useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, User, X } from 'lucide-react';
import type { UserAccount } from '@shared/types';
import { api } from '../api/client';

interface Props {
  user: UserAccount;
  onClose: () => void;
  onUpdated: (user: UserAccount) => void;
}

export const UserProfileModal: React.FC<Props> = ({ user, onClose, onUpdated }) => {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [department, setDepartment] = useState(user.department);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    setSaving(true);
    try {
      const res = await api.updateOwnProfile({
        name: name.trim(),
        email: email.trim(),
        department: department.trim(),
        ...(newPassword.trim() ? { currentPassword, newPassword } : {})
      });
      onUpdated(res.user);
      setCurrentPassword('');
      setNewPassword('');
      setInfoMsg('Dados da sua conta individual atualizados com sucesso!');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao atualizar sua conta.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
        <div className="bg-[#071D41] text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-blue-200" />
            <div>
              <h3 className="text-sm font-bold">Minha Conta Individual</h3>
              <div className="text-[11px] text-blue-200">
                @{user.username} • Perfil {user.role}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-3.5">
          {errorMsg && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800">
              {errorMsg}
            </div>
          )}
          {infoMsg && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{infoMsg}</span>
            </div>
          )}

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">Nome Completo</label>
            <input
              required
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">E-mail</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">Setor</label>
              <input
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-slate-200 space-y-2.5">
            <div className="text-xs font-bold text-[#071D41] flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-[#1351B4]" />
              Alterar Senha (opcional)
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Senha Atual</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Necessária apenas se for trocar a senha"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Nova Senha</label>
              <input
                type="password"
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Mínimo 6 caracteres"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold cursor-pointer"
            >
              Fechar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-xs font-bold cursor-pointer disabled:opacity-50"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Salvar Conta
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
