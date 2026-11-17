import type { AiConnectivityTestResult, LegalAlert } from '../../shared/types.js';
import { getAiConfigRaw } from '../db/repository.js';
import {
  clearGeminiAuthCache,
  diagnoseGeminiApiHttpError,
  getGeminiAuthHeadersAndUrl,
  reloadGeminiDotEnv
} from './geminiAuth.js';

export interface LlmGenerationRequest {
  agentNumber: number;
  agentTitle: string;
  legalBasis: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface LlmGenerationResult {
  structured_json: Record<string, any>;
  html_content: string;
  legal_alerts: LegalAlert[];
  providerLabel: string;
}

export function parseJsonPayload(
  rawText: string,
  providerLabel: string
): LlmGenerationResult | null {
  if (!rawText || !rawText.trim()) return null;

  let cleaned = rawText.trim();
  let parsed: any = null;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    if (cleaned.startsWith('```')) {
      const outerFence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      if (outerFence?.[1]) {
        cleaned = outerFence[1].trim();
      }
    }
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const startIdx = cleaned.indexOf('{');
      const endIdx = cleaned.lastIndexOf('}');
      if (startIdx >= 0 && endIdx > startIdx) {
        try {
          parsed = JSON.parse(cleaned.slice(startIdx, endIdx + 1));
        } catch {
          return null;
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  let htmlContent =
    typeof parsed.html_content === 'string' && parsed.html_content.trim()
      ? parsed.html_content.trim()
      : '';

  // Remove eventuais cercas Markdown dentro de html_content
  const htmlFenced = htmlContent.match(/^```(?:html)?\s*([\s\S]*?)```$/i);
  if (htmlFenced?.[1]) {
    htmlContent = htmlFenced[1].trim();
  }
  if (!htmlContent) return null;
  if (!/class=["'][^"']*gov-doc/i.test(htmlContent)) {
    htmlContent = `<div class="gov-doc">${htmlContent}</div>`;
  }
  htmlContent = htmlContent.normalize('NFC');

  const structuredJson =
    parsed.structured_json && typeof parsed.structured_json === 'object' && !Array.isArray(parsed.structured_json)
      ? parsed.structured_json
      : {};

  const legalAlerts: LegalAlert[] = Array.isArray(parsed.legal_alerts)
    ? parsed.legal_alerts
        .filter((a: any) => a && typeof a === 'object' && typeof a.message === 'string' && a.message.trim().length > 0)
        .map((a: any, idx: number): LegalAlert => {
          const rawSeverity = typeof a.severity === 'string' ? a.severity : a.level;
          const severity: LegalAlert['severity'] =
            rawSeverity === 'critical' || rawSeverity === 'warning' ? rawSeverity : 'info';
          const article =
            typeof a.article === 'string' && a.article.trim() ? a.article.trim() : 'Lei nº 14.133/2021';
          const title =
            typeof a.title === 'string' && a.title.trim()
              ? a.title.trim()
              : `Ponto de Atenção — ${article}`;
          const recommendation =
            typeof a.recommendation === 'string' && a.recommendation.trim()
              ? a.recommendation.trim()
              : undefined;
          return {
            id: typeof a.id === 'string' && a.id.trim() ? a.id.trim() : `llm-alert-${idx + 1}`,
            severity,
            article: article.normalize('NFC'),
            title: title.normalize('NFC'),
            message: String(a.message).trim().normalize('NFC'),
            ...(recommendation ? { recommendation: recommendation.normalize('NFC') } : {})
          };
        })
    : [];

  return {
    structured_json: structuredJson,
    html_content: htmlContent,
    legal_alerts: legalAlerts,
    providerLabel
  };
}

export function buildGeminiGenerationConfig(model: string): Record<string, any> {
  const isGemini4 = model.toLowerCase().startsWith('gemini-4');
  if (isGemini4) {
    return {
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      thinkingConfig: {
        thinkingLevel: 'MEDIUM'
      }
    };
  }
  return {
    temperature: 0.2,
    maxOutputTokens: 16384,
    responseMimeType: 'application/json'
  };
}

export async function tryGenerateWithLlm(
  req: LlmGenerationRequest,
  fetchFn: typeof fetch = fetch
): Promise<LlmGenerationResult | null> {
  const cfg = getAiConfigRaw();

  if (cfg.effectiveProvider === 'local') {
    return null;
  }

  const fullUserPrompt = `${req.userPrompt}

RETORNE EXCLUSIVAMENTE UM JSON VÁLIDO NO SEGUINTE FORMATO (sem texto fora do JSON):
{
  "structured_json": { "...": "campos estruturados solicitados para este agente" },
  "html_content": "<div class=\\"gov-doc\\">...</div>",
  "legal_alerts": [
    {
      "severity": "info | warning | critical",
      "title": "Título curto e objetivo do ponto de conformidade ou risco",
      "article": "Art. ... da Lei nº 14.133/2021 (ou Súmula/Acórdão)",
      "message": "Análise objetiva do achado ou risco identificado nos dados reais do processo",
      "recommendation": "Providência saneadora concreta recomendada"
    }
  ]
}`;

  try {
    if (cfg.effectiveProvider === 'gemini' && cfg.geminiResolution.hasCredential) {
      const requestBody = JSON.stringify({
        systemInstruction: {
          parts: [{ text: req.systemPrompt }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: fullUserPrompt }]
          }
        ],
        generationConfig: buildGeminiGenerationConfig(cfg.geminiModel)
      });

      const sendGeminiRequest = async () => {
        const authReq = await getGeminiAuthHeadersAndUrl(
          cfg.geminiResolution,
          cfg.geminiModel,
          fetchFn
        );
        return fetchFn(authReq.generateUrl, {
          method: 'POST',
          headers: authReq.headers,
          signal: AbortSignal.timeout(120_000),
          body: requestBody
        });
      };

      let resp = await sendGeminiRequest();
      if (resp.status === 401 && cfg.geminiResolution.adcInfo) {
        clearGeminiAuthCache();
        resp = await sendGeminiRequest();
      }

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        const diag = diagnoseGeminiApiHttpError(
          resp.status,
          errBody,
          cfg.geminiResolution,
          cfg.geminiModel
        );
        console.warn(`[GOVFLOW AI] Gemini HTTP ${resp.status} (${diag.errorCode}): ${diag.message}`);
        return null;
      }

      const json = (await resp.json()) as any;
      const parts = Array.isArray(json?.candidates?.[0]?.content?.parts)
        ? json.candidates[0].content.parts
        : [];
      const answerParts = parts.filter((p: any) => !p?.thought && typeof p?.text === 'string');
      const fallbackParts = parts.filter((p: any) => typeof p?.text === 'string');
      const text = (answerParts.length > 0 ? answerParts : fallbackParts)
        .map((p: any) => p.text)
        .join('\n');

      return parseJsonPayload(text, `Gemini (${cfg.geminiModel}) [${cfg.authSource}]`);
    }

    if (cfg.effectiveProvider === 'openai' && cfg.openaiApiKey) {
      const endpoint = `${cfg.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.openaiApiKey}`
        },
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          model: cfg.openaiModel,
          temperature: 0.2,
          max_tokens: 16384,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: req.systemPrompt },
            { role: 'user', content: fullUserPrompt }
          ]
        })
      });

      if (!resp.ok) {
        return null;
      }

      const json = (await resp.json()) as any;
      const text = String(json?.choices?.[0]?.message?.content || '');
      return parseJsonPayload(text, `OpenAI/LLM (${cfg.openaiModel})`);
    }
  } catch {
    return null;
  }

  return null;
}

export async function testAiConnectivity(): Promise<AiConnectivityTestResult> {
  reloadGeminiDotEnv();
  clearGeminiAuthCache();
  const cfg = getAiConfigRaw();

  if (cfg.effectiveProvider === 'local') {
    if (cfg.provider === 'gemini') {
      return {
        ok: false,
        provider: cfg.provider,
        effectiveProvider: 'local',
        authSource: cfg.authSource,
        authSourceLabel: cfg.authSourceLabel,
        errorCode: cfg.geminiResolution.ignoredInvalidDbKey ? 'INVALID_SAVED_KEY' : 'NO_CREDENTIALS',
        message: cfg.geminiResolution.ignoredInvalidDbKey
          ? 'Política "Google Gemini API" ativa, mas a chave salva no banco possui formato inválido e foi ignorada. Fallback seguro Local 14.133 ativo.'
          : 'Política "Google Gemini API" selecionada, porém nenhuma credencial válida foi detectada no ambiente, .env, ADC ou banco local.',
        hint: cfg.geminiResolution.ignoredInvalidDbKey
          ? 'Clique em "Refazer Credenciais Gemini" para limpar o banco local e revalidar o ambiente/.env, ou informe uma chave API válida.'
          : 'Configure GEMINI_API_KEY no arquivo .env, autentique via "gcloud auth application-default login", informe uma chave manual válida ou altere para Automático.'
      };
    }

    const message =
      cfg.provider === 'auto'
        ? 'Modo Automático ativo sem credenciais externas nesta máquina — operando instantaneamente via Motor Local Especialista 14.133 (100% offline).'
        : cfg.provider === 'local'
          ? 'Motor Jurídico Especialista Local (100% offline/determinístico) ativo e operacional.'
          : `Modo "${cfg.provider}" selecionado, porém sem credencial detectada. Fallback automático seguro ativo no Motor Local 14.133.`;

    return {
      ok: true,
      provider: cfg.provider,
      effectiveProvider: 'local',
      authSource: cfg.authSource,
      authSourceLabel: cfg.authSourceLabel,
      message,
      hint: cfg.geminiResolution.ignoredInvalidDbKey
        ? 'Uma chave manual antiga com formato inválido no banco local foi ignorada automaticamente; clique em "Refazer Credenciais Gemini" para removê-la.'
        : undefined
    };
  }

  if (cfg.effectiveProvider === 'gemini') {
    try {
      const authReq = await getGeminiAuthHeadersAndUrl(cfg.geminiResolution, cfg.geminiModel);
      const headers = { ...authReq.headers };
      delete headers['Content-Type'];

      const resp = await fetch(authReq.metadataUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(12_000)
      });

      if (resp.ok) {
        return {
          ok: true,
          provider: cfg.provider,
          effectiveProvider: 'gemini',
          authSource: cfg.authSource,
          authSourceLabel: cfg.authSourceLabel,
          message: `Integração Gemini autenticada e verificada (${cfg.geminiModel}) via ${cfg.authSourceLabel}.`
        };
      }

      if (resp.status === 401) {
        clearGeminiAuthCache();
      }
      const errBody = await resp.text().catch(() => '');
      const diag = diagnoseGeminiApiHttpError(
        resp.status,
        errBody,
        cfg.geminiResolution,
        cfg.geminiModel
      );

      return {
        ok: false,
        provider: cfg.provider,
        effectiveProvider: 'gemini',
        authSource: cfg.authSource,
        authSourceLabel: cfg.authSourceLabel,
        errorCode: diag.errorCode,
        message: diag.message,
        hint: diag.hint
      };
    } catch (err: any) {
      clearGeminiAuthCache();
      const isOAuth = err?.code === 'OAUTH_EXCHANGE_FAILED';
      return {
        ok: false,
        provider: cfg.provider,
        effectiveProvider: 'gemini',
        authSource: cfg.authSource,
        authSourceLabel: cfg.authSourceLabel,
        errorCode: isOAuth ? 'OAUTH_EXCHANGE_FAILED' : 'NETWORK_ERROR',
        message: `Credencial detectada (${cfg.authSourceLabel}), porém falha ao contatar Gemini (${err?.message || 'erro de rede'}). Fallback Local 14.133 garantido.`,
        hint: isOAuth
          ? 'Renove seu login Google ADC com "gcloud auth application-default login" ou clique em "Refazer Credenciais Gemini".'
          : 'Verifique a conectividade HTTPS com generativelanguage.googleapis.com / oauth2.googleapis.com ou utilize o Motor Local 14.133.'
      };
    }
  }

  try {
    const endpoint = `${cfg.openaiBaseUrl.replace(/\/$/, '')}/models`;
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.openaiApiKey}` },
      signal: AbortSignal.timeout(12_000)
    });

    if (resp.ok) {
      return {
        ok: true,
        provider: cfg.provider,
        effectiveProvider: 'openai',
        authSource: cfg.authSource,
        authSourceLabel: cfg.authSourceLabel,
        message: `Conexão OpenAI / Compatível verificada com sucesso (${cfg.openaiModel}).`
      };
    }

    return {
      ok: false,
      provider: cfg.provider,
      effectiveProvider: 'openai',
      authSource: cfg.authSource,
      authSourceLabel: cfg.authSourceLabel,
      message: `Endpoint OpenAI respondeu HTTP ${resp.status}. Fallback para Motor Local 14.133 garantido.`
    };
  } catch (err: any) {
    return {
      ok: false,
      provider: cfg.provider,
      effectiveProvider: 'openai',
      authSource: cfg.authSource,
      authSourceLabel: cfg.authSourceLabel,
      message: `Erro ao testar endpoint OpenAI (${err?.message || 'erro de rede'}). Fallback Local 14.133 garantido.`
    };
  }
}
