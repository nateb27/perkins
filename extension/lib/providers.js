/**
 * Perkins AI Provider Abstraction
 *
 * Defines a standard interface for AI providers and implements:
 * - Anthropic (Claude)
 * - OpenAI (GPT-4o)
 * - Custom endpoint (any OpenAI-compatible API)
 * - Ollama (local models)
 *
 * The contract: every provider exposes `call(prompt, options)` that
 * returns a plain text string. Everything above this layer
 * (prompt construction, JSON parsing, caching) stays in the service worker.
 */

import { decrypt, isEncrypted } from './crypto.js';

// ─── helpers ────────────────────────────────────────────────────────

async function decryptKey(storedKey) {
  if (!storedKey) return '';
  if (isEncrypted(storedKey)) return await decrypt(storedKey);
  return storedKey;
}

function truncateError(msg, max = 200) {
  if (!msg) return 'Unknown error';
  return msg.length > max ? msg.slice(0, max) + '…' : msg;
}

// ─── Anthropic ──────────────────────────────────────────────────────

async function callAnthropic(prompt, opts) {
  const apiKey = await decryptKey(opts.apiKey);
  if (!apiKey) throw new Error('No API key configured for Claude.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model || 'claude-sonnet-4-20250514',
      max_tokens: opts.maxTokens || 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `Claude API error: ${res.status}`;
    throw new Error(truncateError(msg));
  }

  const data = await res.json();
  if (!data.content?.[0]?.text) {
    throw new Error('Unexpected response format from Claude.');
  }
  return data.content[0].text;
}

// ─── OpenAI ─────────────────────────────────────────────────────────

async function callOpenAI(prompt, opts) {
  const apiKey = await decryptKey(opts.apiKey);
  if (!apiKey) throw new Error('No API key configured for OpenAI.');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model || 'gpt-4o',
      max_tokens: opts.maxTokens || 1024,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful writing coach that helps users maintain their unique voice.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `OpenAI API error: ${res.status}`;
    throw new Error(truncateError(msg));
  }

  const data = await res.json();
  if (!data.choices?.[0]?.message?.content) {
    throw new Error('Unexpected response format from OpenAI.');
  }
  return data.choices[0].message.content;
}

// ─── Custom endpoint (OpenAI-compatible) ────────────────────────────

async function callCustom(prompt, opts) {
  const url = opts.customEndpoint;
  if (!url) throw new Error('No custom endpoint URL configured.');

  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new Error('Invalid custom endpoint URL.');
  }

  const headers = { 'Content-Type': 'application/json' };

  // API key is optional for custom endpoints (e.g. local or auth-free)
  if (opts.apiKey) {
    const apiKey = await decryptKey(opts.apiKey);
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body = {
    model: opts.customModel || 'default',
    max_tokens: opts.maxTokens || 1024,
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful writing coach that helps users maintain their unique voice.',
      },
      { role: 'user', content: prompt },
    ],
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000), // 30 s timeout
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error('Custom endpoint timed out after 30 seconds.');
    }
    throw new Error(`Cannot reach custom endpoint: ${truncateError(err.message)}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg =
      err.error?.message || `Custom endpoint error: ${res.status}`;
    throw new Error(truncateError(msg));
  }

  const data = await res.json();

  // Support both OpenAI-style and raw { text: "..." } responses
  if (data.choices?.[0]?.message?.content) {
    return data.choices[0].message.content;
  }
  if (data.content?.[0]?.text) {
    return data.content[0].text;          // Anthropic-style
  }
  if (typeof data.text === 'string') {
    return data.text;                     // Simple { text } wrapper
  }
  if (typeof data.response === 'string') {
    return data.response;                 // Ollama /api/generate style
  }

  throw new Error('Unexpected response shape from custom endpoint.');
}

// ─── Ollama (local) ─────────────────────────────────────────────────

async function callOllama(prompt, opts) {
  const base = (opts.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const model = opts.ollamaModel || 'llama3';

  const url = `${base}/api/chat`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful writing coach that helps users maintain their unique voice.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(60000), // 60 s — local models can be slow
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Ollama timed out. Is "${model}" loaded?`);
    }
    throw new Error(
      'Cannot connect to Ollama. Is it running? (ollama serve)'
    );
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Ollama model "${model}" not found. Run: ollama pull ${model}`);
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(
      truncateError(err.error || `Ollama error: ${res.status}`)
    );
  }

  const data = await res.json();
  return data.message?.content || data.response || '';
}

// ─── Public API ─────────────────────────────────────────────────────

const PROVIDERS = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  custom: callCustom,
  ollama: callOllama,
};

/**
 * Call the currently configured AI provider.
 *
 * @param {string}  prompt   - The full prompt text
 * @param {object}  settings - The current extension settings object
 * @param {object=} extra    - Optional overrides (maxTokens, etc.)
 * @returns {Promise<string>} - The AI-generated text
 */
export async function callProvider(prompt, settings, extra = {}) {
  const provider = settings.provider || 'anthropic';
  const fn = PROVIDERS[provider];

  if (!fn) {
    throw new Error(`Unknown AI provider: "${provider}"`);
  }

  const opts = {
    apiKey: settings.apiKey,
    model: settings.model,                     // per-provider default override
    maxTokens: extra.maxTokens || 1024,
    // Custom endpoint fields
    customEndpoint: settings.customEndpoint,
    customModel: settings.customModel,
    // Ollama fields
    ollamaUrl: settings.ollamaUrl,
    ollamaModel: settings.ollamaModel,
  };

  return fn(prompt, opts);
}

/**
 * List of available providers for the Settings UI.
 */
export const PROVIDER_LIST = [
  { id: 'anthropic', name: 'Claude (Anthropic)', needsKey: true },
  { id: 'openai',    name: 'GPT-4o (OpenAI)',    needsKey: true },
  { id: 'custom',    name: 'Custom Endpoint',     needsKey: false },
  { id: 'ollama',    name: 'Ollama (Local)',       needsKey: false },
];
