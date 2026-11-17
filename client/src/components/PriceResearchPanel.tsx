import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Loader2,
  Plus,
  Save,
  Trash2,
  UploadCloud
} from 'lucide-react';
import type { ParsedPriceResearchResult, PesquisaPrecoItem } from '@shared/types';
import { formatCurrencyBRL } from '@shared/labels';

interface PriceResearchPanelProps {
  items: PesquisaPrecoItem[];
  filename: string;
  resumo: string;
  onChange: (next: {
    items: PesquisaPrecoItem[];
    filename: string;
    resumo: string;
    valorTotal: number;
  }) => void;
  onParseFile: (file: File) => Promise<ParsedPriceResearchResult>;
  compact?: boolean;
  onSaveToProcess?: () => Promise<void>;
  savingProcess?: boolean;
  hasUnsavedChanges?: boolean;
}

const ROUND_2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export function recalculatePriceItems(rawItems: PesquisaPrecoItem[]): {
  items: PesquisaPrecoItem[];
  valorTotal: number;
} {
  const items = rawItems.map((it, idx) => {
    const quantidade = Number.isFinite(Number(it.quantidade)) ? Number(it.quantidade) : 0;
    const valor_unitario = Number.isFinite(Number(it.valor_unitario)) ? Number(it.valor_unitario) : 0;
    const computedTotal =
      Number.isFinite(Number(it.valor_total)) && Number(it.valor_total) >= 0
        ? ROUND_2(Number(it.valor_total))
        : ROUND_2(quantidade * valor_unitario);
    return {
      item: idx + 1,
      descricao: it.descricao ?? '',
      medida: it.medida ?? 'UN',
      quantidade,
      valor_unitario,
      valor_total: computedTotal
    };
  });
  const valorTotal = ROUND_2(items.reduce((acc, it) => acc + (it.valor_total || 0), 0));
  return { items, valorTotal };
}

export const PriceResearchPanel: React.FC<PriceResearchPanelProps> = ({
  items,
  filename,
  resumo,
  onChange,
  onParseFile,
  compact = false,
  onSaveToProcess,
  savingProcess = false,
  hasUnsavedChanges = false
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [parseError, setParseError] = useState('');
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [lastFormat, setLastFormat] = useState<'PDF' | 'EXCEL' | 'WORD' | null>(null);
  const [showResumoEditor, setShowResumoEditor] = useState(!compact);

  const totalCalculado = ROUND_2(items.reduce((acc, it) => acc + (Number(it.valor_total) || 0), 0));

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    setUploading(true);
    setParseError('');
    setDiagnostics([]);
    try {
      const parsed = await onParseFile(file);
      const recalculated = recalculatePriceItems(parsed.itens || []);
      setLastFormat(parsed.format);
      setDiagnostics(parsed.diagnostics || []);
      setShowResumoEditor(true);
      onChange({
        items: recalculated.items,
        filename: parsed.filename || file.name,
        resumo: parsed.resumo_texto || '',
        valorTotal: parsed.valor_total_estimado > 0 ? parsed.valor_total_estimado : recalculated.valorTotal
      });
    } catch (err: any) {
      setParseError(err?.message || 'Falha ao processar o arquivo de pesquisa de preço.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const updateRow = (index: number, patch: Partial<PesquisaPrecoItem>, recomputeTotal = true) => {
    const next = items.map((it, idx) => {
      if (idx !== index) return it;
      const merged: PesquisaPrecoItem = { ...it, ...patch };
      if (recomputeTotal) {
        merged.valor_total = ROUND_2((Number(merged.quantidade) || 0) * (Number(merged.valor_unitario) || 0));
      }
      return merged;
    });
    const rec = recalculatePriceItems(next);
    onChange({
      items: rec.items,
      filename,
      resumo,
      valorTotal: rec.valorTotal
    });
  };

  const handleAddRow = () => {
    const rec = recalculatePriceItems([
      ...items,
      {
        item: items.length + 1,
        descricao: '',
        medida: 'UN',
        quantidade: 1,
        valor_unitario: 0,
        valor_total: 0
      }
    ]);
    onChange({
      items: rec.items,
      filename,
      resumo,
      valorTotal: rec.valorTotal
    });
  };

  const handleRemoveRow = (index: number) => {
    const rec = recalculatePriceItems(items.filter((_, idx) => idx !== index));
    onChange({
      items: rec.items,
      filename,
      resumo,
      valorTotal: rec.valorTotal
    });
  };

  const handleClearItems = () => {
    onChange({
      items: [],
      filename: '',
      resumo: '',
      valorTotal: 0
    });
    setDiagnostics([]);
    setLastFormat(null);
    setParseError('');
  };

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#1351B4] text-white flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-[#071D41]">
              Pesquisa de Preço — Upload e Matriz de Itens (Art. 23, Lei 14.133/2021)
            </h4>
            <p className="text-[11px] text-slate-600">
              Envie planilha ou cotação em <strong>PDF, Excel (.xlsx/.xls/.csv) ou Word (.docx)</strong> para extrair{' '}
              <strong>Descrição, Medida, Quantidade e Valor</strong> para todos os agentes.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-white border border-blue-200 px-2.5 py-1 text-[11px] font-bold text-[#071D41]">
            {items.length} {items.length === 1 ? 'item' : 'itens'} • {formatCurrencyBRL(totalCalculado)}
          </span>
          {onSaveToProcess && (
            <button
              type="button"
              disabled={savingProcess}
              onClick={onSaveToProcess}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold cursor-pointer transition-colors ${
                hasUnsavedChanges
                  ? 'bg-[#168821] hover:bg-[#126E1B] text-white shadow-xs'
                  : 'bg-[#1351B4] hover:bg-[#071D41] text-white'
              } disabled:opacity-50`}
            >
              {savingProcess ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {savingProcess ? 'Salvando...' : hasUnsavedChanges ? 'Salvar Pesquisa no Processo*' : 'Salvar Pesquisa no Processo'}
            </button>
          )}
        </div>
      </div>

      {/* Dropzone de Upload PDF / EXCEL / WORD */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) void handleFile(dropped);
        }}
        className={`rounded-lg border-2 border-dashed px-4 py-3 transition-colors flex flex-wrap items-center justify-between gap-3 ${
          dragOver
            ? 'border-[#1351B4] bg-blue-100/70'
            : 'border-slate-300 bg-white hover:border-[#1351B4]/70'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          {uploading ? (
            <Loader2 className="w-5 h-5 text-[#1351B4] animate-spin shrink-0" />
          ) : (
            <UploadCloud className="w-5 h-5 text-[#1351B4] shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-800 truncate">
              {uploading
                ? 'Extraindo Descrição, Medida, Quantidade e Valores do arquivo...'
                : filename
                  ? `Arquivo vinculado: ${filename}`
                  : 'Arraste o arquivo aqui ou clique para selecionar a Pesquisa de Preço'}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-bold">
                PDF
              </span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold">
                EXCEL (.xlsx / .xls / .csv)
              </span>
              <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-bold">
                WORD (.docx / .doc)
              </span>
              {lastFormat && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 ml-1">
                  <CheckCircle2 className="w-3 h-3" /> Formato detectado: {lastFormat}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.xlsx,.xls,.xlsm,.ods,.csv,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,text/csv"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#071D41] hover:bg-[#1351B4] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
          >
            <UploadCloud className="w-3.5 h-3.5" />
            {filename ? 'Substituir Arquivo' : 'Selecionar Arquivo'}
          </button>
          {(items.length > 0 || filename) && (
            <button
              type="button"
              onClick={handleClearItems}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-rose-50 hover:border-rose-300 text-[11px] font-semibold text-slate-600 hover:text-rose-700 cursor-pointer"
            >
              Limpar
            </button>
          )}
        </div>
      </div>

      {parseError && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{parseError}</span>
        </div>
      )}

      {diagnostics.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 space-y-0.5">
          {diagnostics.map((diag, i) => (
            <div key={i}>• {diag}</div>
          ))}
        </div>
      )}

      {/* Tabela Editável de Itens da Pesquisa de Preço */}
      {items.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-[#071D41] text-white sticky top-0 z-10 text-[11px]">
                <tr>
                  <th className="px-2.5 py-2 w-12 text-center">Item</th>
                  <th className="px-2.5 py-2 min-w-[220px]">Descrição</th>
                  <th className="px-2.5 py-2 w-24">Medida</th>
                  <th className="px-2.5 py-2 w-24 text-right">Quantidade</th>
                  <th className="px-2.5 py-2 w-28 text-right">Valor Unit. (R$)</th>
                  <th className="px-2.5 py-2 w-32 text-right">Valor Total (R$)</th>
                  <th className="px-2 py-2 w-10 text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {items.map((it, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/80">
                    <td className="px-2 py-1.5 text-center font-bold text-slate-600">
                      {String(idx + 1).padStart(2, '0')}
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        value={it.descricao}
                        onChange={(e) => updateRow(idx, { descricao: e.target.value }, false)}
                        placeholder="Descrição completa do item/serviço"
                        className="w-full rounded border border-slate-200 px-2 py-1 text-xs focus:border-[#1351B4] focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        value={it.medida}
                        onChange={(e) => updateRow(idx, { medida: e.target.value }, false)}
                        placeholder="UN, CX, MÊS"
                        className="w-full rounded border border-slate-200 px-2 py-1 text-xs uppercase focus:border-[#1351B4] focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={it.quantidade}
                        onChange={(e) => updateRow(idx, { quantidade: Number(e.target.value) || 0 }, true)}
                        className="w-full rounded border border-slate-200 px-2 py-1 text-xs text-right tabular-nums focus:border-[#1351B4] focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={it.valor_unitario}
                        onChange={(e) => updateRow(idx, { valor_unitario: Number(e.target.value) || 0 }, true)}
                        className="w-full rounded border border-slate-200 px-2 py-1 text-xs text-right tabular-nums focus:border-[#1351B4] focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={it.valor_total}
                        onChange={(e) => updateRow(idx, { valor_total: Number(e.target.value) || 0 }, false)}
                        className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-right font-semibold tabular-nums focus:border-[#1351B4] focus:outline-none"
                      />
                    </td>
                    <td className="px-1.5 py-1.5 text-center">
                      <button
                        type="button"
                        onClick={() => handleRemoveRow(idx)}
                        title="Remover item"
                        className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <button
              type="button"
              onClick={handleAddRow}
              className="inline-flex items-center gap-1 text-[#1351B4] hover:text-[#071D41] font-semibold cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Adicionar Item Manualmente
            </button>
            <div className="font-bold text-[#071D41]">
              Total Consolidado da Pesquisa: {formatCurrencyBRL(totalCalculado)}
            </div>
          </div>
        </div>
      )}

      {items.length === 0 && (
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>Nenhum item estruturado ainda. Envie um arquivo ou adicione itens manualmente.</span>
          <button
            type="button"
            onClick={handleAddRow}
            className="inline-flex items-center gap-1 text-[#1351B4] hover:text-[#071D41] font-semibold cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Adicionar Item
          </button>
        </div>
      )}

      {/* Resumo Textual / Parâmetros Art. 23 */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setShowResumoEditor(!showResumoEditor)}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#1351B4] hover:underline cursor-pointer"
        >
          <FileText className="w-3.5 h-3.5" />
          {showResumoEditor
            ? 'Ocultar Memória/Resumo Textual Extraído (Art. 23)'
            : 'Visualizar/Editar Memória/Resumo Textual Extraído (Art. 23)'}
        </button>

        {showResumoEditor && (
          <textarea
            rows={compact ? 2 : 3}
            value={resumo}
            onChange={(e) =>
              onChange({
                items,
                filename,
                resumo: e.target.value,
                valorTotal: totalCalculado
              })
            }
            placeholder="Resumo das fontes consultadas, cotações, PNCP, notas de pesquisa de preços extraídas do arquivo..."
            className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-[#1351B4] focus:outline-none"
          />
        )}
      </div>
    </div>
  );
};
