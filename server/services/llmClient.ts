import type { AiConnectivityTestResult, LegalAlert } from '../../shared/types.js';
import { getAiConfigRaw } from '../db/repository.js';
import {
  clearGeminiAuthCache,
  diagnoseGeminiApiHttpError,
  getGeminiAuthHeadersAndUrl,
  reloadGeminiDotEnv
} from './geminiAuth.js';

export interface LlmGenerationRequest {
  userId?: string;
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

export function buildOpenAiChatBody(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  includeResponseFormat = true
): Record<string, any> {
  const isReasoningOrGpt5 = /^(o[134]|gpt-5)/i.test((model || '').trim());
  const body: Record<string, any> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
  if (isReasoningOrGpt5) {
    body.max_completion_tokens = 16384;
  } else {
    body.temperature = 0.2;
    body.max_tokens = 16384;
  }
  if (includeResponseFormat) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

export function buildEffectiveSystemInstruction(
  baseSystemPrompt: string,
  gemInstructions?: string
): string {
  const custom = (gemInstructions || '').trim();
  if (!custom) return baseSystemPrompt;
  return `[INSTRUÇÕES PERSONALIZADAS DO GEM / PADRÃO DOCUMENTAL]\n${custom}\n\n${baseSystemPrompt}`;
}

export async function tryGenerateWithLlm(
  req: LlmGenerationRequest,
  fetchFn: typeof fetch = fetch
): Promise<LlmGenerationResult | null> {
  const cfg = getAiConfigRaw(req.userId);

  if (cfg.effectiveProvider === 'local') {
    return null;
  }

  const effectiveSystemInstruction = buildEffectiveSystemInstruction(
    req.systemPrompt,
    cfg.gemInstructions
  );

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
          parts: [{ text: effectiveSystemInstruction }]
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
      const callOpenAi = (includeResponseFormat: boolean) =>
        fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.openaiApiKey}`
          },
          signal: AbortSignal.timeout(120_000),
          body: JSON.stringify(
            buildOpenAiChatBody(
              cfg.openaiModel,
              effectiveSystemInstruction,
              fullUserPrompt,
              includeResponseFormat
            )
          )
        });

      let resp = await callOpenAi(true);
      if (resp.status === 400) {
        const err400 = await resp.text().catch(() => '');
        if (/response_format/i.test(err400)) {
          resp = await callOpenAi(false);
        } else {
          console.warn(`[GOVFLOW AI] OpenAI HTTP 400 (${cfg.openaiModel}): ${err400.slice(0, 180)}`);
          return null;
        }
      }

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.warn(`[GOVFLOW AI] OpenAI HTTP ${resp.status} (${cfg.openaiModel}): ${errBody.slice(0, 180)}`);
        return null;
      }

      const json = (await resp.json()) as any;
      const text = String(json?.choices?.[0]?.message?.content || '');
      return parseJsonPayload(text, `OpenAI (${cfg.openaiModel})`);
    }
  } catch (err: any) {
    console.warn(`[GOVFLOW AI] Falha na chamada LLM (${cfg.effectiveProvider}): ${err?.message || 'erro'}`);
    return null;
  }

  return null;
}

export async function testAiConnectivity(
  userId?: string,
  fetchFn: typeof fetch = fetch
): Promise<AiConnectivityTestResult> {
  reloadGeminiDotEnv();
  clearGeminiAuthCache();
  const cfg = getAiConfigRaw(userId);

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
    const baseUrl = cfg.openaiBaseUrl.replace(/\/$/, '');
    const modelsEndpoint = `${baseUrl}/models`;
    const resp = await fetchFn(modelsEndpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.openaiApiKey}` },
      signal: AbortSignal.timeout(12_000)
    });

    const diagnoseOpenAiHttp = (
      status: number,
      errJson: { error?: { message?: string; code?: string; type?: string } } | null
    ): AiConnectivityTestResult => {
      const errMsg = errJson?.error?.message || '';
      const rawCode = errJson?.error?.code || errJson?.error?.type || `HTTP_${status}`;
      const isNoCredits =
        status === 429 &&
        (/no credits remaining|insufficient_quota|exceeded your current quota|billing/i.test(errMsg) ||
          /insufficient_quota/i.test(rawCode));

      const ptDetail =
        status === 401
          ? 'Chave API OpenAI inválida, expirada ou revogada (HTTP 401).'
          : isNoCredits
            ? 'Chave OpenAI autenticada, porém a conta está sem créditos de API/faturamento disponíveis (HTTP 429: sem saldo na organização).'
            : status === 429
              ? 'Limite de requisições da API OpenAI atingido (HTTP 429).'
              : status === 404
                ? `Modelo "${cfg.openaiModel}" ou endpoint não encontrado na OpenAI (HTTP 404).`
                : `Endpoint OpenAI respondeu HTTP ${status}${errMsg ? `: ${errMsg.slice(0, 120)}` : ''}.`;

      return {
        ok: false,
        provider: cfg.provider,
        effectiveProvider: 'openai',
        authSource: cfg.authSource,
        authSourceLabel: cfg.authSourceLabel,
        errorCode: isNoCredits ? 'INSUFFICIENT_QUOTA' : rawCode,
        message: `${ptDetail} Fallback para Motor Local 14.133 garantido.`,
        hint:
          status === 401
            ? 'Confira sua OPENAI_API_KEY nas configurações ou no arquivo .env.'
            : isNoCredits
              ? 'Adicione créditos em https://platform.openai.com/settings/organization/billing/ para habilitar a geração real via OpenAI.'
              : 'Verifique seu saldo/limites e o modelo selecionado na OpenAI, ou opere normalmente com o Motor Local 14.133.'
      };
    };

    if (!resp.ok) {
      const errJson = (await resp.json().catch(() => null)) as any;
      return diagnoseOpenAiHttp(resp.status, errJson);
    }

    const body = (await resp.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
    const availableIds = Array.isArray(body?.data) ? body!.data.map((m) => String(m?.id || '')) : [];
    const modelFound =
      availableIds.length === 0 ||
      availableIds.some((id) => id.toLowerCase() === cfg.openaiModel.toLowerCase());

    if (!modelFound) {
      return {
        ok: false,
        provider: cfg.provider,
        effectiveProvider: 'openai',
        authSource: cfg.authSource,
        authSourceLabel: cfg.authSourceLabel,
        errorCode: 'MODEL_NOT_FOUND',
        message: `Chave OpenAI autenticada, porém o modelo "${cfg.openaiModel}" não apareceu na lista retornada por ${modelsEndpoint}.`,
        hint: 'Selecione um modelo disponível como gpt-4o-mini, gpt-4o, gpt-4.1 ou gpt-5-mini.'
      };
    }

    // Sonda 1-token em /chat/completions para confirmar cota/faturamento ativos além da autenticação
    const isReasoning = /^(o[134]|gpt-5)/i.test(cfg.openaiModel);
    const probeResp = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.openaiApiKey}`
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: cfg.openaiModel,
        ...(isReasoning ? { max_completion_tokens: 1 } : { max_tokens: 1 }),
        messages: [{ role: 'user', content: 'OK' }]
      })
    });

    if (!probeResp.ok) {
      const probeErr = (await probeResp.json().catch(() => null)) as any;
      return diagnoseOpenAiHttp(probeResp.status, probeErr);
    }

    return {
      ok: true,
      provider: cfg.provider,
      effectiveProvider: 'openai',
      authSource: cfg.authSource,
      authSourceLabel: cfg.authSourceLabel,
      message: `Conexão e faturamento OpenAI verificados com sucesso (${cfg.openaiModel}).`
    };
  } catch (err: any) {
    return {
      ok: false,
      provider: cfg.provider,
      effectiveProvider: 'openai',
      authSource: cfg.authSource,
      authSourceLabel: cfg.authSourceLabel,
      errorCode: 'NETWORK_ERROR',
      message: `Erro ao testar endpoint OpenAI (${err?.message || 'erro de rede'}). Fallback Local 14.133 garantido.`,
      hint: 'Verifique acesso HTTPS ao endpoint api.openai.com e a URL configurada.'
    };
  }
}
