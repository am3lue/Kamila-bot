// Minimal Gemini (Google AI Studio) client over REST.
import axios from 'axios';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class AIError extends Error {
  constructor(message, { status = 502, code = 'ai_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createGemini({ apiKey, model, timeoutMs = 30000, logger, baseUrl = BASE }) {
  const http = axios.create({ baseURL: baseUrl, timeout: timeoutMs, validateStatus: () => true });

  /**
   * @param {object} p
   * @param {string} [p.system]        system instruction
   * @param {{role:'user'|'assistant'|'model', content:string}[]} p.messages
   * @param {string} [p.apiKey]        overrides the server key
   * @param {string} [p.model]         overrides the default model
   * @returns {Promise<string>} the reply text
   */
  async function generate({ system, messages, apiKey: key, model: m, temperature = 0.4, maxOutputTokens = 2048 }) {
    const useKey = key || apiKey;
    const useModel = m || model;
    if (!useKey) throw new AIError('No Gemini API key configured (set GEMINI_API_KEY or a project key)', { status: 503, code: 'ai_not_configured' });

    // Gemini wants user/model turns that start with the user; merge repeats.
    const contents = [];
    for (const msg of messages) {
      const role = msg.role === 'user' ? 'user' : 'model';
      const text = String(msg.content ?? '').trim();
      if (!text) continue;
      const last = contents[contents.length - 1];
      if (last?.role === role) last.parts[0].text += `\n${text}`;
      else contents.push({ role, parts: [{ text }] });
    }
    while (contents.length && contents[0].role !== 'user') contents.shift();
    if (!contents.length) throw new AIError('Nothing to answer', { status: 400, code: 'ai_empty' });

    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };
    let res;
    try {
      res = await http.post(`/models/${encodeURIComponent(useModel)}:generateContent`, body, {
        headers: { 'x-goog-api-key': useKey, 'content-type': 'application/json' },
      });
    } catch (err) {
      throw new AIError(`Gemini unreachable: ${err.code || err.message}`, { status: 503, code: 'ai_unreachable' });
    }
    if (res.status !== 200) {
      const msg = res.data?.error?.message || `HTTP ${res.status}`;
      const code = res.status === 400 && /api key/i.test(msg) ? 'ai_bad_key'
        : res.status === 404 ? 'ai_bad_model'
        : res.status === 429 ? 'ai_rate_limited'
        : 'ai_error';
      logger?.warn('Gemini', `${useModel}: ${msg}`);
      throw new AIError(`Gemini: ${msg}`, { status: res.status === 429 ? 429 : 502, code });
    }
    const cand = res.data?.candidates?.[0];
    const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
    if (!text) {
      const why = res.data?.promptFeedback?.blockReason || cand?.finishReason || 'empty response';
      throw new AIError(`Gemini returned no text (${why})`, { status: 502, code: 'ai_empty' });
    }
    return text;
  }

  // Models this key can use for text generation.
  async function listModels(key) {
    const useKey = key || apiKey;
    if (!useKey) throw new AIError('No Gemini API key configured', { status: 503, code: 'ai_not_configured' });
    const res = await http.get('/models', { headers: { 'x-goog-api-key': useKey }, params: { pageSize: 200 } });
    if (res.status !== 200) throw new AIError(`Gemini: ${res.data?.error?.message || `HTTP ${res.status}`}`, { status: 502 });
    return (res.data?.models || [])
      .filter((x) => (x.supportedGenerationMethods || []).includes('generateContent'))
      .map((x) => ({ id: x.name.replace(/^models\//, ''), name: x.displayName || x.name, inputTokenLimit: x.inputTokenLimit }));
  }

  return { generate, listModels, defaultModel: model, hasServerKey: !!apiKey };
}
