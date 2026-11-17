import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  Send,
  ShieldCheck,
  User,
  X
} from 'lucide-react';
import type { AppInfo, SupportTicket, UserAccount } from '@shared/types';
import { api } from '../api/client';

interface Props {
  currentUser: UserAccount | null;
}

const DEFAULT_APP_INFO: AppInfo = {
  name: 'GOVFLOW 14.133',
  version: '1.0.0',
  developer: 'Rodrigo Ferraz Botelho',
  support_email: 'rodrigofb@live.com',
  support_whatsapp: '+5537999654266',
  support_whatsapp_digits: '5537999654266'
};

export const AppInfoSupportWidget: React.FC<Props> = ({ currentUser }) => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'info' | 'email' | 'chat'>('info');
  const [appInfo, setAppInfo] = useState<AppInfo>(DEFAULT_APP_INFO);

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState<string>('');
  const [replyText, setReplyText] = useState('');

  // Form states for opening Email or Chat ticket
  const [reqName, setReqName] = useState(currentUser?.name || '');
  const [reqEmail, setReqEmail] = useState(currentUser?.email || '');
  const [reqPhone, setReqPhone] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');
  const [copiedField, setCopiedField] = useState('');
  const [lastEmailMailto, setLastEmailMailto] = useState('');

  useEffect(() => {
    api.getAppInfo().then(setAppInfo).catch(() => {});
  }, []);

  useEffect(() => {
    if (currentUser) {
      setReqName((prev) => prev || currentUser.name);
      setReqEmail((prev) => prev || currentUser.email);
    }
  }, [currentUser]);

  const loadTickets = async () => {
    if (!currentUser) {
      setTickets([]);
      return;
    }
    setLoadingTickets(true);
    try {
      const list = await api.listSupportTickets();
      setTickets(list);
      if (list.length > 0 && !selectedTicketId) {
        setSelectedTicketId(list[0].id);
      }
    } catch {
      // ignore if session expired
    } finally {
      setLoadingTickets(false);
    }
  };

  useEffect(() => {
    if (open && currentUser) {
      loadTickets();
    }
  }, [open, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = async (label: string, val: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedField(label);
      setTimeout(() => setCopiedField(''), 2000);
    } catch {
      // ignore clipboard restrictions
    }
  };

  const buildMailtoHref = (subj: string, bodyText: string, name: string, email: string) => {
    const fullBody = [
      `Sistema: ${appInfo.name} (v${appInfo.version})`,
      `Solicitante: ${name || currentUser?.name || 'Usuário'} (${email || currentUser?.email || 'sem e-mail'})`,
      '',
      bodyText
    ].join('\n');
    return `mailto:${appInfo.support_email}?subject=${encodeURIComponent(`[${appInfo.name}] ${subj}`)}&body=${encodeURIComponent(fullBody)}`;
  };

  const buildWhatsappHref = (textMsg?: string) => {
    const baseText =
      textMsg?.trim() ||
      `Olá ${appInfo.developer}, preciso de suporte no ${appInfo.name} v${appInfo.version}${
        currentUser ? ` (Usuário: ${currentUser.name} / @${currentUser.username})` : ''
      }.`;
    return `https://wa.me/${appInfo.support_whatsapp_digits}?text=${encodeURIComponent(baseText)}`;
  };

  const handleCreateTicket = async (channel: 'EMAIL' | 'CHAT') => {
    setErrorMsg('');
    setInfoMsg('');
    setSubmitting(true);
    try {
      const { ticket } = await api.createSupportTicket({
        requester_name: reqName || currentUser?.name || '',
        requester_email: reqEmail || currentUser?.email || '',
        requester_phone: reqPhone,
        channel,
        subject,
        message
      });

      const proto = ticket.id.slice(0, 8).toUpperCase();
      if (channel === 'EMAIL') {
        const href = buildMailtoHref(subject, message, reqName, reqEmail);
        setLastEmailMailto(href);
        setInfoMsg(
          `Chamado #${proto} registrado para atendimento por E-mail (${appInfo.support_email}). Você também pode disparar sua mensagem pelo botão abaixo.`
        );
      } else {
        setInfoMsg(`Chamado via Chat #${proto} aberto com sucesso! Acompanhe a conversa abaixo ou acione no WhatsApp.`);
      }

      setSubject('');
      setMessage('');
      if (currentUser) {
        await loadTickets();
        setSelectedTicketId(ticket.id);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao registrar chamado de suporte.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendChatReply = async () => {
    if (!selectedTicketId || !replyText.trim()) return;
    setErrorMsg('');
    setSubmitting(true);
    try {
      const { ticket } = await api.replySupportTicket(selectedTicketId, replyText.trim());
      setTickets((prev) => prev.map((t) => (t.id === ticket.id ? ticket : t)));
      setReplyText('');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao enviar mensagem.');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedTicket = tickets.find((t) => t.id === selectedTicketId) || null;

  return (
    <>
      {/* Botão discreto no canto inferior direito */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Informações do App (v${appInfo.version}) e Suporte Técnico`}
        className="fixed bottom-3 right-3 z-40 inline-flex items-center gap-1.5 rounded-full border border-slate-300/90 bg-white/90 backdrop-blur-xs px-3 py-1.5 text-[11px] font-medium text-slate-600 shadow-sm hover:border-[#1351B4] hover:text-[#1351B4] hover:bg-white transition-all cursor-pointer"
      >
        <Info className="w-3.5 h-3.5 text-[#1351B4]" />
        <span>v{appInfo.version}</span>
        <span className="text-slate-300">•</span>
        <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />
        <span>Suporte</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="bg-[#071D41] text-white px-5 py-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-blue-200">
                  Sobre o Sistema & Atendimento
                </div>
                <h3 className="text-base font-bold">
                  {appInfo.name} — Versão {appInfo.version}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tabs */}
            <div className="px-5 pt-3 border-b border-slate-200 bg-slate-50 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setTab('info');
                  setErrorMsg('');
                  setInfoMsg('');
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-colors cursor-pointer ${
                  tab === 'info'
                    ? 'border-[#1351B4] text-[#1351B4] bg-white'
                    : 'border-transparent text-slate-600 hover:text-[#071D41]'
                }`}
              >
                <Info className="w-3.5 h-3.5" />
                Informações do App
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab('email');
                  setErrorMsg('');
                  setInfoMsg('');
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-colors cursor-pointer ${
                  tab === 'email'
                    ? 'border-[#1351B4] text-[#1351B4] bg-white'
                    : 'border-transparent text-slate-600 hover:text-[#071D41]'
                }`}
              >
                <Mail className="w-3.5 h-3.5" />
                Chamado por E-mail
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab('chat');
                  setErrorMsg('');
                  setInfoMsg('');
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-colors cursor-pointer ${
                  tab === 'chat'
                    ? 'border-[#1351B4] text-[#1351B4] bg-white'
                    : 'border-transparent text-slate-600 hover:text-[#071D41]'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Chamado via Chat
              </button>
            </div>

            {/* Body */}
            <div className="p-5 overflow-y-auto space-y-4">
              {errorMsg && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800">
                  {errorMsg}
                </div>
              )}
              {infoMsg && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{infoMsg}</span>
                </div>
              )}

              {tab === 'info' && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 grid sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        Aplicação
                      </div>
                      <div className="font-bold text-[#071D41] text-sm mt-0.5">{appInfo.name}</div>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        Versão Oficial
                      </div>
                      <div className="font-bold text-[#1351B4] text-sm mt-0.5">v{appInfo.version}</div>
                    </div>
                    <div className="sm:col-span-2 pt-2 border-t border-slate-200">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        Desenvolvido por
                      </div>
                      <div className="font-bold text-[#071D41] text-sm mt-0.5 flex items-center gap-1.5">
                        <User className="w-4 h-4 text-[#1351B4]" />
                        {appInfo.developer}
                      </div>
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-200 p-4 space-y-2">
                      <div className="flex items-center gap-2 text-xs font-bold text-[#071D41]">
                        <Mail className="w-4 h-4 text-[#1351B4]" />
                        E-mail de Suporte
                      </div>
                      <div className="text-xs font-mono text-slate-700 break-all">
                        {appInfo.support_email}
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => setTab('email')}
                          className="px-2.5 py-1.5 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-[11px] font-semibold cursor-pointer"
                        >
                          Abrir Chamado por E-mail
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopy('email', appInfo.support_email)}
                          className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-600 cursor-pointer"
                          title="Copiar e-mail"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        {copiedField === 'email' && (
                          <span className="text-[10px] text-emerald-700 font-semibold">Copiado!</span>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 p-4 space-y-2">
                      <div className="flex items-center gap-2 text-xs font-bold text-[#071D41]">
                        <Phone className="w-4 h-4 text-emerald-600" />
                        WhatsApp Suporte
                      </div>
                      <div className="text-xs font-mono text-slate-700">{appInfo.support_whatsapp}</div>
                      <div className="flex items-center gap-2 pt-1">
                        <a
                          href={buildWhatsappHref()}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#168821] hover:bg-[#126E1B] text-white text-[11px] font-semibold"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                          Chat WhatsApp
                          <ExternalLink className="w-3 h-3" />
                        </a>
                        <button
                          type="button"
                          onClick={() => handleCopy('wpp', appInfo.support_whatsapp)}
                          className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-600 cursor-pointer"
                          title="Copiar WhatsApp"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        {copiedField === 'wpp' && (
                          <span className="text-[10px] text-emerald-700 font-semibold">Copiado!</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {(tab === 'email' || tab === 'chat') && (
                <div className="space-y-4">
                  {tab === 'chat' && (
                    <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs text-emerald-900">
                        <strong>Atendimento Direto via Chat / WhatsApp:</strong> abra um chamado no chat interno abaixo ou fale diretamente pelo WhatsApp <strong>{appInfo.support_whatsapp}</strong>.
                      </div>
                      <a
                        href={buildWhatsappHref(
                          subject ? `${subject}: ${message}` : undefined
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#168821] hover:bg-[#126E1B] text-white text-[11px] font-bold shrink-0"
                      >
                        <MessageCircle className="w-3.5 h-3.5" />
                        WhatsApp Direto
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  )}

                  {tab === 'email' && lastEmailMailto && (
                    <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-blue-900">
                        Envie a cópia diretamente pelo seu aplicativo de e-mail para <strong>{appInfo.support_email}</strong>:
                      </span>
                      <a
                        href={lastEmailMailto}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#1351B4] text-white text-[11px] font-bold"
                      >
                        <Mail className="w-3.5 h-3.5" />
                        Abrir App de E-mail
                      </a>
                    </div>
                  )}

                  {/* Formulário de Abertura de Chamado */}
                  <div className="rounded-xl border border-slate-200 p-4 space-y-3 bg-slate-50/70">
                    <div className="text-xs font-bold text-[#071D41]">
                      {tab === 'email'
                        ? `Novo Chamado via E-mail (${appInfo.support_email})`
                        : 'Abrir Novo Chamado no Chat Interno'}
                    </div>
                    <div className="grid sm:grid-cols-3 gap-2.5">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 mb-1">
                          Seu Nome *
                        </label>
                        <input
                          type="text"
                          value={reqName}
                          onChange={(e) => setReqName(e.target.value)}
                          placeholder="Nome completo"
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 mb-1">
                          E-mail de Retorno *
                        </label>
                        <input
                          type="email"
                          value={reqEmail}
                          onChange={(e) => setReqEmail(e.target.value)}
                          placeholder="nome@prefeitura.gov.br"
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 mb-1">
                          WhatsApp / Telefone
                        </label>
                        <input
                          type="text"
                          value={reqPhone}
                          onChange={(e) => setReqPhone(e.target.value)}
                          placeholder="(37) 99999-9999"
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 mb-1">
                        Assunto *
                      </label>
                      <input
                        type="text"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        placeholder="Ex.: Liberação de acesso, dúvida sobre Lei 14.133 ou suporte técnico"
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 mb-1">
                        Mensagem / Descrição *
                      </label>
                      <textarea
                        rows={3}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Descreva detalhadamente o chamado..."
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] text-slate-500">
                        Desenvolvedor: <strong>{appInfo.developer}</strong> • {appInfo.support_email}
                      </span>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => handleCreateTicket(tab === 'email' ? 'EMAIL' : 'CHAT')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1351B4] hover:bg-[#071D41] disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
                      >
                        {submitting ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Send className="w-3.5 h-3.5" />
                        )}
                        {tab === 'email' ? 'Registrar Chamado por E-mail' : 'Iniciar Chamado no Chat'}
                      </button>
                    </div>
                  </div>

                  {/* Histórico de Chat Interno (usuário logado) */}
                  {tab === 'chat' && currentUser && (
                    <div className="rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-3.5 py-2.5 bg-slate-100 border-b border-slate-200 flex items-center justify-between">
                        <span className="text-xs font-bold text-[#071D41]">
                          Meus Chamados & Conversa em Andamento ({tickets.length})
                        </span>
                        {loadingTickets && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1351B4]" />}
                      </div>
                      {tickets.length === 0 ? (
                        <div className="p-4 text-xs text-slate-500 text-center">
                          Nenhum chamado anterior registrado nesta conta.
                        </div>
                      ) : (
                        <div className="grid md:grid-cols-[200px_1fr] min-h-[200px]">
                          <div className="border-r border-slate-200 divide-y divide-slate-100 max-h-64 overflow-y-auto">
                            {tickets.map((t) => (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => setSelectedTicketId(t.id)}
                                className={`w-full text-left p-2.5 text-xs cursor-pointer ${
                                  selectedTicketId === t.id ? 'bg-blue-50' : 'hover:bg-slate-50'
                                }`}
                              >
                                <div className="font-bold text-[#071D41] truncate">{t.subject}</div>
                                <div className="flex items-center justify-between text-[10px] text-slate-500 mt-1">
                                  <span>{t.channel}</span>
                                  <span className="font-semibold text-[#1351B4]">{t.status}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                          {selectedTicket && (
                            <div className="flex flex-col justify-between p-3 bg-white">
                              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                                {selectedTicket.messages.map((m) => (
                                  <div
                                    key={m.id}
                                    className={`rounded-lg px-3 py-2 text-xs ${
                                      m.sender_role === 'ADMIN'
                                        ? 'bg-blue-50 border border-blue-200 text-slate-800'
                                        : 'bg-slate-100 text-slate-800'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 mb-0.5">
                                      <span className="flex items-center gap-1">
                                        {m.sender_role === 'ADMIN' && (
                                          <ShieldCheck className="w-3 h-3 text-[#1351B4]" />
                                        )}
                                        {m.sender_name}
                                      </span>
                                      <span>{new Date(m.created_at).toLocaleString('pt-BR')}</span>
                                    </div>
                                    <div>{m.message}</div>
                                  </div>
                                ))}
                              </div>
                              <div className="flex items-center gap-2 pt-2 mt-2 border-t border-slate-100">
                                <input
                                  type="text"
                                  value={replyText}
                                  onChange={(e) => setReplyText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSendChatReply();
                                  }}
                                  placeholder="Enviar nova mensagem neste chamado..."
                                  className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-[#1351B4] focus:outline-none"
                                />
                                <button
                                  type="button"
                                  disabled={submitting || !replyText.trim()}
                                  onClick={handleSendChatReply}
                                  className="px-3 py-1.5 rounded-lg bg-[#071D41] hover:bg-[#1351B4] disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
                                >
                                  Enviar
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
