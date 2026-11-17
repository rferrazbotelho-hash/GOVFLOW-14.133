import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpenCheck,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe,
  Loader2,
  Plus,
  Scale,
  Search,
  Trash2
} from 'lucide-react';
import type { ProcessBundle, TcuJurisprudenceTheme, TcuPrecedent } from '@shared/types';
import { api } from '../api/client';

interface Props {
  bundle: ProcessBundle;
  onBundleUpdated: (updated: ProcessBundle) => void;
}

export const TcuJurisprudencePanel: React.FC<Props> = ({ bundle, onBundleUpdated }) => {
  const pinned = bundle.process.tcu_acordaos_vinculados || [];
  const [expanded, setExpanded] = useState(pinned.length > 0);
  const [query, setQuery] = useState('');
  const [tema, setTema] = useState('ALL');
  const [consultLive, setConsultLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [results, setResults] = useState<TcuPrecedent[]>([]);
  const [themes, setThemes] = useState<Array<{ value: TcuJurisprudenceTheme; label: string }>>([]);
  const [liveDiag, setLiveDiag] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const runSearch = useCallback(
    async (opts?: { q?: string; tema?: string; live?: boolean }) => {
      setLoading(true);
      setErrorMsg('');
      try {
        const res = await api.searchTcuAcordaos({
          q: opts?.q !== undefined ? opts.q : query,
          tema: opts?.tema !== undefined ? opts.tema : tema,
          live: opts?.live !== undefined ? opts.live : consultLive
        });
        setResults(res.items);
        setThemes(res.themes);
        setLiveDiag(res.live_diagnostics || '');
      } catch (err: any) {
        setErrorMsg(err.message || 'Erro ao consultar base de jurisprudência do TCU.');
      } finally {
        setLoading(false);
      }
    },
    [query, tema, consultLive]
  );

  useEffect(() => {
    if (expanded && results.length === 0) {
      runSearch();
    }
  }, [expanded, results.length, runSearch]);

  const isPinned = (item: TcuPrecedent) =>
    pinned.some((p) => p.id === item.id || p.numero.toLowerCase() === item.numero.toLowerCase());

  const handleTogglePin = async (item: TcuPrecedent) => {
    setSavingId(item.id);
    setErrorMsg('');
    try {
      const exists = isPinned(item);
      const nextList = exists
        ? pinned.filter((p) => p.id !== item.id && p.numero.toLowerCase() !== item.numero.toLowerCase())
        : [...pinned, item];
      const updated = await api.updateProcess(bundle.process.id, {
        tcu_acordaos_vinculados: nextList
      });
      onBundleUpdated(updated);
    } catch (err: any) {
      setErrorMsg(err.message || 'Falha ao atualizar acórdãos vinculados ao processo.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-indigo-200 shadow-xs overflow-hidden">
      <div
        onClick={() => setExpanded((v) => !v)}
        className="px-4 py-3 bg-indigo-50/80 border-b border-indigo-100 flex flex-wrap items-center justify-between gap-2 cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <Scale className="w-4 h-4 text-[#071D41]" />
          <div>
            <div className="text-xs font-bold text-[#071D41]">
              Módulo de Jurisprudência do TCU (Acórdãos e Súmulas — Art. 53)
            </div>
            <div className="text-[11px] text-slate-600">
              Consulte a base curada TCU + Dados Abertos e vincule precedentes específicos diretamente ao Parecer Jurídico.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#1351B4] text-white">
            {pinned.length} vinculado(s)
          </span>
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-4">
          {pinned.length > 0 && (
            <div className="bg-emerald-50/70 border border-emerald-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-900">
                <BookOpenCheck className="w-3.5 h-3.5" />
                Precedentes Vinculados a Este Processo (inseridos na Matriz 4.4 do Agente 10):
              </div>
              <div className="flex flex-wrap gap-1.5">
                {pinned.map((p) => (
                  <span
                    key={p.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-emerald-300 text-[11px] font-semibold text-emerald-900"
                  >
                    <span>{p.numero}</span>
                    <button
                      type="button"
                      disabled={savingId === p.id}
                      onClick={() => handleTogglePin(p)}
                      className="text-rose-600 hover:text-rose-800 cursor-pointer"
                      title="Remover vínculo"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Barra de Consulta */}
          <div className="flex flex-col md:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    runSearch();
                  }
                }}
                placeholder="Buscar nº do Acórdão, Súmula, Artigo ou tema (ex: 1875, marca, Súmula 247, pesquisa)..."
                className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs focus:border-[#1351B4] focus:outline-none"
              />
            </div>

            <select
              value={tema}
              onChange={(e) => {
                const nextTema = e.target.value;
                setTema(nextTema);
                runSearch({ tema: nextTema });
              }}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:border-[#1351B4] focus:outline-none"
            >
              <option value="ALL">Todos os Temas TCU</option>
              {themes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>

            <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-700 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={consultLive}
                onChange={(e) => {
                  const next = e.target.checked;
                  setConsultLive(next);
                  runSearch({ live: next });
                }}
                className="accent-[#1351B4]"
              />
              <Globe className="w-3.5 h-3.5 text-[#1351B4]" />
              Consultar Dados Abertos TCU
            </label>

            <button
              type="button"
              onClick={() => runSearch()}
              disabled={loading}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#1351B4] hover:bg-[#071D41] text-white text-xs font-semibold cursor-pointer disabled:opacity-50 shrink-0"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              Buscar
            </button>
          </div>

          {liveDiag && (
            <div className="text-[11px] px-3 py-1.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
              {liveDiag}
            </div>
          )}

          {errorMsg && (
            <div className="text-xs px-3 py-2 rounded bg-rose-50 text-rose-800 border border-rose-200">
              {errorMsg}
            </div>
          )}

          <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
            {results.map((item) => {
              const linked = isPinned(item);
              const busy = savingId === item.id;
              return (
                <div
                  key={item.id}
                  className={`rounded-lg border p-3 transition-colors ${
                    linked ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200 bg-slate-50/40'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-bold text-xs text-[#071D41]">{item.numero}</span>
                        <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px] font-semibold">
                          {item.colegiado}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-blue-100 text-[#1351B4] text-[10px] font-semibold">
                          {item.tema_label}
                        </span>
                        {item.fonte === 'DADOS_ABERTOS_TCU' && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                            API TCU Online
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-medium text-[#1351B4]">{item.artigos_relacionados}</div>
                      <p className="text-xs text-slate-700 leading-relaxed">{item.ementa}</p>
                      <p className="text-[11px] text-slate-500">
                        <strong>Aplicação no Parecer:</strong> {item.aplicacao_pratica}
                      </p>
                    </div>

                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleTogglePin(item)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer transition-colors disabled:opacity-50 ${
                          linked
                            ? 'bg-emerald-600 hover:bg-rose-600 text-white'
                            : 'bg-white border border-[#1351B4] text-[#1351B4] hover:bg-[#1351B4] hover:text-white'
                        }`}
                      >
                        {busy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : linked ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                        {linked ? 'Vinculado' : 'Vincular'}
                      </button>

                      {item.url_referencia && (
                        <a
                          href={item.url_referencia}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-[#1351B4]"
                        >
                          Portal TCU <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {!loading && results.length === 0 && (
              <div className="text-center py-6 text-xs text-slate-500">
                Nenhum acórdão encontrado para este filtro. Tente outro termo ou ative a consulta em Dados Abertos TCU.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
