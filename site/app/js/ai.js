// AI providers, called straight from the browser with the visitor's own key.
// The key is sent only to the provider the visitor picked; the AIJobNinja
// server never sees it. Every provider here answers browser (CORS) requests.
//
// Prices are USD per 1M input / output tokens from each provider's official
// pricing page, checked 2026-10-24. Each list starts with the cheapest model.

import Anthropic from '../vendor/anthropic-sdk.mjs';

export const PROVIDERS = [
  {
    id: 'qwen', name: 'Qwen', vendor: 'Alibaba Cloud Model Studio (Singapore)',
    kind: 'openai', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', tokenParam: 'max_tokens',
    keyUrl: 'https://modelstudio.console.alibabacloud.com/', keyHint: 'sk-…',
    models: [
      { id: 'qwen3.7-flash', price: '$0.03 / $0.13', note: 'Cheapest. Prices rise above 32K input tokens.' },
      { id: 'qwen-flash', price: '$0.05 / $0.40' },
      { id: 'qwen3.5-flash', price: '$0.10 / $0.40' },
    ],
    privacy: 'Use a key from the Singapore (international) region; keys are region-specific.',
  },
  {
    id: 'openai', name: 'OpenAI', vendor: 'OpenAI',
    kind: 'openai', base: 'https://api.openai.com/v1', tokenParam: 'max_completion_tokens',
    keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…',
    models: [
      { id: 'gpt-5-nano', price: '$0.05 / $0.40', note: 'Cheapest.' },
      { id: 'gpt-4.1-nano', price: '$0.10 / $0.40' },
      { id: 'gpt-6-luna', price: '$0.10 / $0.50' },
    ],
  },
  {
    id: 'gemini', name: 'Google Gemini', vendor: 'Google AI Studio',
    kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', tokenParam: 'max_tokens',
    keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…',
    models: [
      { id: 'gemini-2.5-flash-lite', price: '$0.10 / $0.40', note: 'Cheapest. Falls back to 3.1 Flash-Lite if Google retires it.' },
      { id: 'gemini-3.1-flash-lite', price: '$0.25 / $1.50' },
    ],
    fallback: { 'gemini-2.5-flash-lite': 'gemini-3.1-flash-lite' },
    privacy: 'Google may use free-tier requests to improve its products; paid-tier requests are not used.',
  },
  {
    id: 'anthropic', name: 'Claude', vendor: 'Anthropic',
    kind: 'anthropic',
    keyUrl: 'https://platform.claude.com/settings/keys', keyHint: 'sk-ant-…',
    models: [
      { id: 'claude-haiku-5-5', price: '$0.10 / $0.50', note: 'Cheapest Claude model.' },
    ],
  },
  {
    id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek',
    kind: 'openai', base: 'https://api.deepseek.com', tokenParam: 'max_tokens',
    keyUrl: 'https://platform.deepseek.com/api_keys', keyHint: 'sk-…',
    models: [
      { id: 'deepseek-flash', price: '$0.15 / $0.60 off-peak', note: 'Cheapest. Double during peak hours (01–04 and 06–10 UTC on weekdays).' },
    ],
  },
  {
    id: 'meta', name: 'Meta Muse', vendor: 'Meta Model API',
    kind: 'openai', base: 'https://api.meta.ai/v1', tokenParam: 'max_tokens',
    keyUrl: 'https://dev.meta.ai/', keyHint: 'MODEL_API_KEY',
    models: [
      { id: 'muse-spark-1.3', price: '$1.25 / $4.25', note: 'Standard tier: Meta does not train on your requests.' },
      { id: 'muse-spark-1.3-contributor', price: '$0.10 / $0.20', note: 'Cheapest, but Meta may train its models on everything you send, including your CV.', contributor: true },
    ],
  },
];

export const provider = (id) => PROVIDERS.find((p) => p.id === id) || null;

export function activeModel(settings) {
  const p = provider(settings.provider);
  if (!p) return null;
  let model = settings.models?.[p.id] || p.models[0].id;
  const m = p.models.find((x) => x.id === model) || p.models[0];
  if (m.contributor && !settings.metaContributor) return p.models.find((x) => !x.contributor).id;
  return m.id;
}

export class AiError extends Error {
  constructor(message, { status, retryable } = {}) { super(message); this.status = status; this.retryable = retryable; }
}

function explain(status, raw, p) {
  // Gemini's OpenAI-compatible endpoint wraps its error object in an array.
  const body = Array.isArray(raw) ? raw[0] : raw;
  const msg = body?.error?.message || body?.error?.msg || body?.message || (typeof body?.error === 'string' ? body.error : '') || '';
  if (status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(msg))) return `${p.name} rejected the API key. Check it in AI settings.`;
  if (status === 402) return `${p.name} says the account has no credit left.`;
  if (status === 429) return `${p.name} rate limit or quota reached. Wait a moment and try again.`;
  if (status === 404) return `${p.name} could not find that model. Pick another in AI settings.`;
  return `${p.name} error ${status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`;
}

async function callOpenAiCompatible(p, key, model, system, user, maxTokens, signal) {
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      [p.tokenParam]: maxTokens,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new AiError(explain(res.status, body, p), { status: res.status, retryable: res.status === 429 || res.status >= 500 });
  const choice = body?.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new AiError(`${p.name} returned an empty answer${choice?.finish_reason ? ` (${choice.finish_reason})` : ''}.`);
  return { text, truncated: choice.finish_reason === 'length', usage: body.usage || null };
}

async function callAnthropic(p, key, model, system, user, maxTokens, signal) {
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1 });
  let response;
  try {
    response = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }, { signal });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new AiError(explain(e.status, { message: e.message }, p), { status: e.status, retryable: e.status === 429 || e.status >= 500 });
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new AiError('Claude declined this request.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) throw new AiError('Claude returned an empty answer.');
  return { text, truncated: response.stop_reason === 'max_tokens', usage: response.usage };
}

// One completion. Throws AiError with a message fit to show the visitor.
export async function complete(settings, { system, user, maxTokens = 8000, signal }) {
  const p = provider(settings.provider);
  if (!p) throw new AiError('Choose an AI provider in AI settings first.');
  const key = (settings.keys?.[p.id] || '').trim();
  if (!key) throw new AiError(`Add your ${p.name} API key in AI settings first.`);
  let model = activeModel(settings);
  const call = p.kind === 'anthropic' ? callAnthropic : callOpenAiCompatible;
  try {
    return { ...(await call(p, key, model, system, user, maxTokens, signal)), provider: p.id, model };
  } catch (e) {
    const next = p.fallback?.[model];
    if (e instanceof AiError && e.status === 404 && next) {
      model = next;
      return { ...(await call(p, key, model, system, user, maxTokens, signal)), provider: p.id, model };
    }
    if (e?.name === 'AbortError') throw new AiError('Stopped.');
    if (e instanceof TypeError) throw new AiError(`Could not reach ${p.name}. Check your connection.`);
    throw e;
  }
}

// Pulls the first JSON object out of a model answer (models sometimes wrap it
// in a code fence or add a sentence around it).
export function parseJsonObject(text) {
  const s = String(text);
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], s];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)); } catch {}
  }
  return null;
}
