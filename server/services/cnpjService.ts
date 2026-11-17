import { formatCnpj } from '../../shared/labels.js';

export interface CnpjLookupResult {
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
  fonte: 'BrasilAPI' | 'ReceitaWS';
}

export function cleanCnpj(cnpj: string): string {
  return (cnpj || '').replace(/\D/g, '');
}

export function isValidCnpj(cnpj: string): boolean {
  const digits = cleanCnpj(cnpj);
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const calcDigit = (base: string, weights: number[]) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += Number(base[i]) * weights[i];
    }
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };

  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = calcDigit(digits.slice(0, 12), w1);
  const d2 = calcDigit(digits.slice(0, 13), w2);
  return Number(digits[12]) === d1 && Number(digits[13]) === d2;
}

function formatCep(cep: string | undefined): string {
  const d = (cep || '').replace(/\D/g, '').slice(0, 8);
  if (d.length !== 8) return cep || '';
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}

function formatPhone(phone: string | undefined): string {
  const d = (phone || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return phone || '';
}

function joinAddress(parts: (string | undefined)[]): string {
  return parts
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .join(', ');
}

export async function lookupCnpj(rawCnpj: string): Promise<CnpjLookupResult> {
  const digits = cleanCnpj(rawCnpj);
  if (digits.length !== 14) {
    throw new Error('O CNPJ deve conter exatamente 14 dígitos numéricos.');
  }
  if (!isValidCnpj(digits)) {
    throw new Error('CNPJ inválido segundo o algoritmo oficial dos dígitos verificadores.');
  }

  // 1) Tenta BrasilAPI
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'GovFlow-14133/1.0' },
      signal: AbortSignal.timeout(8000)
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const tipoLog = data.descricao_tipo_de_logradouro ? `${data.descricao_tipo_de_logradouro} ` : '';
      const logradouro = `${tipoLog}${data.logradouro || ''}`.trim();
      const numero = data.numero ? `nº ${data.numero}` : '';
      const endereco = joinAddress([logradouro, numero, data.complemento, data.bairro]);

      return {
        cnpj: formatCnpj(digits),
        razao_social: data.razao_social || '',
        nome_fantasia: data.nome_fantasia || data.razao_social || '',
        endereco_completo: endereco,
        cep: formatCep(data.cep),
        municipio: data.municipio || '',
        uf: data.uf || '',
        telefone: formatPhone(data.ddd_telefone_1 || data.ddd_telefone_2),
        email: data.email || '',
        situacao_cadastral: data.descricao_situacao_cadastral || 'ATIVA',
        fonte: 'BrasilAPI'
      };
    }
  } catch {
    // Fallback para ReceitaWS abaixo
  }

  // 2) Fallback: ReceitaWS
  const rwRes = await fetch(`https://receitaws.com.br/v1/cnpj/${digits}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'GovFlow-14133/1.0' },
    signal: AbortSignal.timeout(9000)
  });

  if (!rwRes.ok) {
    throw new Error(`Não foi possível consultar o CNPJ nas APIs públicas (HTTP ${rwRes.status}).`);
  }

  const rw = (await rwRes.json()) as any;
  if (rw.status === 'ERROR') {
    throw new Error(rw.message || 'CNPJ não encontrado na base da Receita Federal.');
  }

  const endereco = joinAddress([
    rw.logradouro,
    rw.numero ? `nº ${rw.numero}` : '',
    rw.complemento,
    rw.bairro
  ]);

  return {
    cnpj: formatCnpj(digits),
    razao_social: rw.nome || '',
    nome_fantasia: rw.fantasia || rw.nome || '',
    endereco_completo: endereco,
    cep: formatCep(rw.cep),
    municipio: rw.municipio || '',
    uf: rw.uf || '',
    telefone: formatPhone(rw.telefone),
    email: rw.email || '',
    situacao_cadastral: rw.situacao || 'ATIVA',
    fonte: 'ReceitaWS'
  };
}
