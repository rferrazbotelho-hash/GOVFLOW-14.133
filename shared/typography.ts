export const CANONICAL_DOCUMENT_FONT = 'Arial';
export const CANONICAL_MONO_FONT = 'Consolas';
export const CANONICAL_UI_FONT_STACK =
  "'Arial', 'Segoe UI', 'Liberation Sans', 'DejaVu Sans', system-ui, -apple-system, sans-serif";

/**
 * Normaliza texto UTF-8 em Forma C (NFC) e remove caracteres de controle inválidos
 * preservando integralmente acentuação em português e símbolos jurídicos (§, º, ª, –, —, “, ”, •, ≥, ≤).
 */
export function normalizeUtf8Text(input: unknown): string {
  const raw = String(input ?? '');
  return raw
    .normalize('NFC')
    .replace(/\uFFFD/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Fallback seguro apenas quando não houver fonte TrueType Unicode disponível (fontes Type1 WinAnsi no PDFKit).
 */
export function normalizeWinAnsiFallback(input: unknown): string {
  return normalizeUtf8Text(input)
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/→/g, '->')
    .replace(/×/g, 'x')
    .replace(/✓|✔/g, '[OK]')
    .replace(/⚠[\uFE0F]?/g, '[ALERTA]')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}
