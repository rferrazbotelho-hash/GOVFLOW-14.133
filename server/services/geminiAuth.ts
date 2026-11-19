import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

export type GeminiAuthSource =
  | 'none'
  | 'env_gemini_key'
  | 'env_google_key'
  | 'db_api_key'
  | 'adc_authorized_user'
  | 'adc_service_account';

export type AiAuthSource = GeminiAuthSource | 'openai_key';

export interface AdcAuthorizedUser {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

export interface AdcServiceAccount {
  type: 'service_account';
  client_email: string;
  private_key: string;
  token_uri?: string;
  quota_project_id?: string;
  project_id?: string;
}

export type AdcCredential = AdcAuthorizedUser | AdcServiceAccount;

export interface GeminiCredentialResolution {
  source: GeminiAuthSource;
  sourceLabel: string;
  hasCredential: boolean;
  apiKey?: string;
  quotaProjectId?: string;
  adcPath?: string;
  adcInfo?: AdcCredential;
  ignoredInvalidDbKey?: boolean;
  hasDotEnvFile?: boolean;
}

export interface GeminiAuthRequestConfig {
  generateUrl: string;
  metadataUrl: string;
  headers: Record<string, string>;
  modeDescription: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  '4 hydrogen': 'gemini-4-hydrogen',
  '4-hydrogen': 'gemini-4-hydrogen',
  'gemini 4 hydrogen': 'gemini-4-hydrogen',
  'gemini-4.0-hydrogen': 'gemini-4-hydrogen',
  '4 argon': 'gemini-4-argon',
  '4-argon': 'gemini-4-argon',
  'gemini 4 argon': 'gemini-4-argon',
  'gemini-4.0-argon': 'gemini-4-argon',
  '4 carbon': 'gemini-4-carbon',
  '4-carbon': 'gemini-4-carbon',
  'gemini 4 carbon': 'gemini-4-carbon',
  '2.5 pro': 'gemini-4-hydrogen',
  '2.5 flash': 'gemini-4-hydrogen'
};

export function normalizeGeminiModelName(raw?: string): string {
  const stripped = (raw || '').trim().replace(/^models\//i, '').trim();
  if (!stripped) return DEFAULT_GEMINI_MODEL;
  const key = stripped.toLowerCase().replace(/\s+/g, ' ');
  if (GEMINI_MODEL_ALIASES[key]) {
    return GEMINI_MODEL_ALIASES[key];
  }
  // Modelos legados (gemini-2.5-*, gemini-2.0-*, gemini-1.5-*) são automaticamente migrados para gemini-4-hydrogen
  if (/^gemini-(?:2\.5|2\.0|1\.5)(?:-|$)/i.test(key)) {
    return DEFAULT_GEMINI_MODEL;
  }
  return stripped;
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const GENERATIVE_SCOPE =
  'https://www.googleapis.com/auth/generative-language https://www.googleapis.com/auth/cloud-platform';

const DOTENV_GEMINI_KEYS = [
  'AI_PROVIDER',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'GEMINI_MODEL',
  'GOVFLOW_GEM_INSTRUCTIONS',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL'
] as const;

// Tracks env keys populated from .env/.env.local so explicit test/shell overrides are preserved.
const loadedDotEnvKeys = new Set<string>();

// Cache OAuth2 access tokens per credential fingerprint to avoid redundant token exchanges.
const oauthTokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();

export function clearGeminiAuthCache(): void {
  oauthTokenCache.clear();
}

function stripOuterQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function sanitizeGeminiApiKey(raw?: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = stripOuterQuotes(raw);
  if (!cleaned || cleaned === '***') return '';
  if (cleaned.includes('•') || /^\*+$/.test(cleaned)) return '';
  if (!/^[\x21-\x7E]+$/.test(cleaned)) return '';
  return cleaned;
}

function validateManualApiKey(
  raw: string,
  providerLabel: string,
  fallbackHint: string
): { ok: true; key: string } | { ok: false; error: string } {
  const cleaned = stripOuterQuotes(raw);
  if (!cleaned) {
    return { ok: true, key: '' };
  }
  if (cleaned === '***') {
    return { ok: true, key: '***' };
  }
  if (cleaned.includes('•') || /^\*+$/.test(cleaned) || !/^[\x21-\x7E]{10,}$/.test(cleaned)) {
    return {
      ok: false,
      error: `Chave ${providerLabel} inválida: remova caracteres mascarados (•), espaços ou trechos truncados, ou deixe em branco para usar detecção automática (${fallbackHint}).`
    };
  }
  return { ok: true, key: cleaned };
}

export function validateManualGeminiApiKey(raw: string) {
  return validateManualApiKey(raw, 'Gemini', '.env / ADC');
}

export function validateManualOpenAiApiKey(raw: string) {
  return validateManualApiKey(raw, 'OpenAI', '.env / ambiente');
}

export function resolveOpenAiApiKey(dbOpenAiKey?: string): {
  apiKey: string;
  fromDb: boolean;
  hasDotEnvFile: boolean;
} {
  const dotEnv = readRuntimeDotEnv();
  const hasDotEnvFile = hasAnyDotEnvFile();
  const cleanDb = sanitizeGeminiApiKey(dbOpenAiKey);
  if (cleanDb) {
    return { apiKey: cleanDb, fromDb: true, hasDotEnvFile };
  }
  const envVal = sanitizeGeminiApiKey(getEffectiveEnvValue('OPENAI_API_KEY', dotEnv));
  return { apiKey: envVal, fromDb: false, hasDotEnvFile };
}

export function getEffectiveAiEnvSetting(name: string): string {
  return getEffectiveEnvValue(name, readRuntimeDotEnv());
}

function hasAnyDotEnvFile(cwd = process.cwd()): boolean {
  if (process.env.GOVFLOW_IGNORE_DOTENV === '1') return false;
  return (
    fs.existsSync(path.resolve(cwd, '.env')) ||
    fs.existsSync(path.resolve(cwd, '.env.local'))
  );
}

function readRuntimeDotEnv(): Record<string, string> {
  if (process.env.GOVFLOW_IGNORE_DOTENV === '1') return {};
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local')
  ];
  const merged: Record<string, string> = {};

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = dotenv.parse(raw);
        Object.assign(merged, parsed);
      }
    } catch {
      // Ignore unreadable optional .env files
    }
  }
  return merged;
}

// Seed tracking if dotenv/config loaded values at startup
{
  const initialDotEnv = readRuntimeDotEnv();
  for (const key of DOTENV_GEMINI_KEYS) {
    if (initialDotEnv[key] && process.env[key] === initialDotEnv[key]) {
      loadedDotEnvKeys.add(key);
    }
  }
}

export function reloadGeminiDotEnv(): boolean {
  const dotEnv = readRuntimeDotEnv();
  for (const key of DOTENV_GEMINI_KEYS) {
    const fileVal = typeof dotEnv[key] === 'string' ? dotEnv[key].trim() : '';
    if (fileVal) {
      if (!process.env[key] || loadedDotEnvKeys.has(key)) {
        process.env[key] = fileVal;
        loadedDotEnvKeys.add(key);
      }
    } else if (loadedDotEnvKeys.has(key)) {
      delete process.env[key];
      loadedDotEnvKeys.delete(key);
    }
  }
  return hasAnyDotEnvFile();
}

function getEffectiveEnvValue(name: string, dotEnv: Record<string, string>): string {
  const procVal = process.env[name];
  if (typeof procVal === 'string' && procVal.trim()) {
    return procVal.trim();
  }
  const fileVal = dotEnv[name];
  if (typeof fileVal === 'string' && fileVal.trim()) {
    return fileVal.trim();
  }
  return '';
}

export function getDefaultAdcPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'gcloud', 'application_default_credentials.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'gcloud', 'application_default_credentials.json');
}

function parseAdcFile(filePath: string): AdcCredential | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    if (
      parsed.type === 'authorized_user' &&
      typeof parsed.client_id === 'string' &&
      parsed.client_id.trim() &&
      typeof parsed.client_secret === 'string' &&
      parsed.client_secret.trim() &&
      typeof parsed.refresh_token === 'string' &&
      parsed.refresh_token.trim()
    ) {
      return {
        type: 'authorized_user',
        client_id: parsed.client_id.trim(),
        client_secret: parsed.client_secret.trim(),
        refresh_token: parsed.refresh_token.trim(),
        quota_project_id:
          typeof parsed.quota_project_id === 'string' ? parsed.quota_project_id.trim() : undefined
      };
    }

    if (
      parsed.type === 'service_account' &&
      typeof parsed.client_email === 'string' &&
      parsed.client_email.trim() &&
      typeof parsed.private_key === 'string' &&
      parsed.private_key.trim()
    ) {
      return {
        type: 'service_account',
        client_email: parsed.client_email.trim(),
        private_key: parsed.private_key,
        token_uri:
          typeof parsed.token_uri === 'string' && parsed.token_uri.trim()
            ? parsed.token_uri.trim()
            : DEFAULT_TOKEN_URI,
        quota_project_id:
          typeof parsed.quota_project_id === 'string' ? parsed.quota_project_id.trim() : undefined,
        project_id: typeof parsed.project_id === 'string' ? parsed.project_id.trim() : undefined
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveGeminiCredential(dbGeminiApiKey?: string): GeminiCredentialResolution {
  const dotEnv = readRuntimeDotEnv();
  const hasDotEnvFile = hasAnyDotEnvFile();
  const rawDbProvided =
    typeof dbGeminiApiKey === 'string' && dbGeminiApiKey.trim().length > 0 && dbGeminiApiKey !== '***';
  const cleanDbKey = sanitizeGeminiApiKey(dbGeminiApiKey);
  const ignoredInvalidDbKey = rawDbProvided && !cleanDbKey;

  if (cleanDbKey) {
    return {
      source: 'db_api_key',
      sourceLabel: 'Chave Gemini salva nas configurações locais',
      hasCredential: true,
      apiKey: cleanDbKey,
      ignoredInvalidDbKey,
      hasDotEnvFile
    };
  }

  const envGeminiKey = sanitizeGeminiApiKey(getEffectiveEnvValue('GEMINI_API_KEY', dotEnv));
  if (envGeminiKey) {
    return {
      source: 'env_gemini_key',
      sourceLabel: 'Detecção automática via GEMINI_API_KEY (ambiente / .env)',
      hasCredential: true,
      apiKey: envGeminiKey,
      ignoredInvalidDbKey,
      hasDotEnvFile
    };
  }

  const envGoogleKey = sanitizeGeminiApiKey(getEffectiveEnvValue('GOOGLE_API_KEY', dotEnv));
  if (envGoogleKey) {
    return {
      source: 'env_google_key',
      sourceLabel: 'Detecção automática via GOOGLE_API_KEY (ambiente / .env)',
      hasCredential: true,
      apiKey: envGoogleKey,
      ignoredInvalidDbKey,
      hasDotEnvFile
    };
  }

  const quotaProjectOverride =
    getEffectiveEnvValue('GOOGLE_CLOUD_QUOTA_PROJECT', dotEnv) ||
    getEffectiveEnvValue('GOOGLE_CLOUD_PROJECT', dotEnv) ||
    undefined;

  const explicitAdcPath = getEffectiveEnvValue('GOOGLE_APPLICATION_CREDENTIALS', dotEnv);
  const adcCandidates = explicitAdcPath ? [explicitAdcPath] : [getDefaultAdcPath()];

  for (const candidate of adcCandidates) {
    const adc = parseAdcFile(candidate);
    if (!adc) continue;

    if (adc.type === 'authorized_user') {
      return {
        source: 'adc_authorized_user',
        sourceLabel: 'Google ADC OAuth2 automático (gcloud application-default)',
        hasCredential: true,
        adcPath: candidate,
        adcInfo: adc,
        quotaProjectId: adc.quota_project_id || quotaProjectOverride,
        ignoredInvalidDbKey,
        hasDotEnvFile
      };
    }

    return {
      source: 'adc_service_account',
      sourceLabel: 'Google ADC Service Account automático (JSON / JWT)',
      hasCredential: true,
      adcPath: candidate,
      adcInfo: adc,
      quotaProjectId: adc.quota_project_id || quotaProjectOverride || adc.project_id,
      ignoredInvalidDbKey,
      hasDotEnvFile
    };
  }

  return {
    source: 'none',
    sourceLabel: 'Nenhuma credencial externa detectada (Motor Local Especialista 14.133 ativo)',
    hasCredential: false,
    ignoredInvalidDbKey,
    hasDotEnvFile
  };
}

function toBase64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createServiceAccountJwtAssertion(
  sa: AdcServiceAccount,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      scope: GENERATIVE_SCOPE,
      aud: tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600
    })
  );
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key);
  return `${signingInput}.${toBase64Url(signature)}`;
}

function getAdcFingerprint(adc: AdcCredential): string {
  const hash = crypto.createHash('sha256');
  if (adc.type === 'authorized_user') {
    hash.update(`authorized_user:${adc.client_id}:${adc.refresh_token}`);
  } else {
    hash.update(`service_account:${adc.client_email}:${adc.private_key.slice(0, 64)}`);
  }
  return hash.digest('hex');
}

function extractOAuthErrorDetail(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as {
      error?: string | { message?: string };
      error_description?: string;
    };
    const code = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || '';
    const desc = typeof parsed.error_description === 'string' ? parsed.error_description : '';
    const combined = [code, desc].filter(Boolean).join(': ').trim();
    return combined ? combined.slice(0, 220) : '';
  } catch {
    return '';
  }
}

async function exchangeAdcAccessToken(
  adc: AdcCredential,
  fetchFn: typeof fetch
): Promise<string> {
  const cacheKey = getAdcFingerprint(adc);
  const now = Date.now();
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now + 60_000) {
    return cached.accessToken;
  }

  const tokenUri =
    adc.type === 'service_account' && adc.token_uri ? adc.token_uri : DEFAULT_TOKEN_URI;

  const body = new URLSearchParams();
  if (adc.type === 'authorized_user') {
    body.set('client_id', adc.client_id);
    body.set('client_secret', adc.client_secret);
    body.set('refresh_token', adc.refresh_token);
    body.set('grant_type', 'refresh_token');
  } else {
    const assertion = createServiceAccountJwtAssertion(adc);
    body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    body.set('assertion', assertion);
  }

  const resp = await fetchFn(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000)
  });

  if (!resp.ok) {
    oauthTokenCache.delete(cacheKey);
    const errText = await resp.text().catch(() => '');
    const detail = extractOAuthErrorDetail(errText);
    const err = new Error(
      detail ? `OAuth2 token exchange HTTP ${resp.status} (${detail})` : `OAuth2 token exchange HTTP ${resp.status}`
    );
    (err as any).code = 'OAUTH_EXCHANGE_FAILED';
    throw err;
  }

  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('OAuth2 token response without access_token');
  }

  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  oauthTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAtMs: now + expiresInSec * 1000
  });

  return data.access_token;
}

export function diagnoseGeminiApiHttpError(
  status: number,
  bodyText: string,
  resolution: GeminiCredentialResolution,
  model: string
): { errorCode: string; message: string; hint: string } {
  let reason = '';
  let apiMessage = '';

  try {
    const parsed = JSON.parse(bodyText) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{ reason?: string }>;
      };
    };
    apiMessage = parsed?.error?.message?.trim() || '';
    const detailReason = parsed?.error?.details?.find((d) => typeof d?.reason === 'string')?.reason;
    reason = detailReason || parsed?.error?.status || '';
  } catch {
    // Non-JSON upstream error body
  }

  if (reason === 'API_KEY_INVALID' || /api key not valid/i.test(apiMessage)) {
    return {
      errorCode: 'API_KEY_INVALID',
      message: `Chave Gemini recusada pelo Google (${resolution.sourceLabel} — API_KEY_INVALID). O fallback Local 14.133 mantém o fluxo operacional.`,
      hint:
        resolution.source === 'db_api_key'
          ? 'Clique em "Refazer Credenciais Gemini" para remover a chave inválida salva no banco e revalidar o ambiente, ou informe uma chave válida do Google AI Studio.'
          : 'Verifique GEMINI_API_KEY / GOOGLE_API_KEY no arquivo .env ou variáveis do sistema e clique em "Refazer Credenciais Gemini".'
    };
  }

  if (status === 401 || reason === 'UNAUTHENTICATED') {
    return {
      errorCode: 'OAUTH_UNAUTHENTICATED',
      message: `Credencial Gemini expirada ou não autenticada (HTTP ${status}). Cache OAuth2 limpo automaticamente.`,
      hint:
        resolution.source.startsWith('adc')
          ? 'Renove as credenciais ADC com "gcloud auth application-default login" ou clique em "Refazer Credenciais Gemini".'
          : 'Revise a chave Gemini configurada no .env ou banco local.'
    };
  }

  if (status === 403 || reason === 'PERMISSION_DENIED' || reason === 'SERVICE_DISABLED') {
    const isAdc = resolution.source.startsWith('adc');
    return {
      errorCode: reason === 'SERVICE_DISABLED' ? 'SERVICE_DISABLED' : 'PERMISSION_DENIED',
      message: `Acesso negado pelo endpoint Gemini (HTTP 403${reason ? ` · ${reason}` : ''}).${apiMessage ? ` Detalhe: ${apiMessage.slice(0, 140)}` : ''}`,
      hint: isAdc
        ? 'Para Google ADC, confirme se a API Generative Language (generativelanguage.googleapis.com) está ativa e se GOOGLE_CLOUD_QUOTA_PROJECT está configurado.'
        : 'Confirme as permissões e restrições de API da chave Gemini no Google AI Studio / Google Cloud Console.'
    };
  }

  if (status === 404 || reason === 'NOT_FOUND') {
    return {
      errorCode: 'MODEL_NOT_FOUND',
      message: `Modelo Gemini "${model}" não encontrado ou indisponível (HTTP 404).`,
      hint: 'Ajuste o modelo preferencial para "gemini-4-hydrogen" ou "gemini-4-argon" e salve novamente.'
    };
  }

  if (status === 429 || reason === 'RESOURCE_EXHAUSTED') {
    return {
      errorCode: 'RATE_LIMIT',
      message: 'Cota ou limite de requisições da API Gemini atingido (HTTP 429). Fallback Local 14.133 ativo.',
      hint: 'Aguarde alguns instantes ou verifique os limites de cota da sua chave/projeto no Google AI Studio.'
    };
  }

  return {
    errorCode: reason || `HTTP_${status}`,
    message: `Credencial detectada (${resolution.sourceLabel}), mas o endpoint Gemini respondeu HTTP ${status}${reason ? ` (${reason})` : ''}. Em execução, o fallback para Motor Local 14.133 protege o processo.`,
    hint: 'Clique em "Refazer Credenciais Gemini" para revalidar as origens de autenticação ou confira o acesso de rede ao endpoint generativelanguage.googleapis.com.'
  };
}

export async function getGeminiAuthHeadersAndUrl(
  resolution: GeminiCredentialResolution,
  model: string,
  fetchFn: typeof fetch = fetch
): Promise<GeminiAuthRequestConfig> {
  if (!resolution.hasCredential) {
    throw new Error('Nenhuma credencial Gemini disponível para autenticar a chamada.');
  }

  const normalizedModel = normalizeGeminiModelName(model);
  const encodedModel = encodeURIComponent(normalizedModel);
  const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent`;
  const metadataUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}`;

  if (resolution.apiKey) {
    return {
      generateUrl,
      metadataUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': resolution.apiKey
      },
      modeDescription: resolution.sourceLabel
    };
  }

  if (!resolution.adcInfo) {
    throw new Error('Credencial ADC inválida ou ausente.');
  }

  const accessToken = await exchangeAdcAccessToken(resolution.adcInfo, fetchFn);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`
  };
  if (resolution.quotaProjectId) {
    headers['x-goog-user-project'] = resolution.quotaProjectId;
  }

  return {
    generateUrl,
    metadataUrl,
    headers,
    modeDescription: resolution.sourceLabel
  };
}
