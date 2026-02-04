/**
 * Perkins Background Service Worker
 * Handles AI API calls and message routing
 */

import { decrypt, isEncrypted } from '../lib/crypto.js';

// State cache (loaded from storage)
let settings = null;
let voiceProfile = null;
let learnedExceptions = [];
let coachEnabled = false;

// Rate limiting
const rateLimiter = {
  calls: [],
  maxCallsPerMinute: 10,
  cooldownMs: 60000,

  canMakeCall() {
    const now = Date.now();
    // Remove calls older than 1 minute
    this.calls = this.calls.filter(t => now - t < this.cooldownMs);
    return this.calls.length < this.maxCallsPerMinute;
  },

  recordCall() {
    this.calls.push(Date.now());
  },

  getTimeUntilNextCall() {
    if (this.canMakeCall()) return 0;
    const oldest = Math.min(...this.calls);
    return Math.max(0, this.cooldownMs - (Date.now() - oldest));
  }
};

// Analysis cache - avoid re-analyzing identical text
const analysisCache = {
  entries: new Map(),
  maxSize: 20,
  ttlMs: 300000, // 5 minutes

  // Simple hash function for cache key
  hash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  },

  get(text) {
    const key = this.hash(text);
    const entry = this.entries.get(key);

    if (entry && Date.now() - entry.timestamp < this.ttlMs) {
      console.log('Perkins: Cache hit for analysis');
      return entry.result;
    }

    // Clean up expired entry
    if (entry) {
      this.entries.delete(key);
    }

    return null;
  },

  set(text, result) {
    const key = this.hash(text);

    // Evict oldest entries if at max size
    if (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }

    this.entries.set(key, {
      result,
      timestamp: Date.now()
    });
  },

  clear() {
    this.entries.clear();
  }
};

// Initialize on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Perkins installed');
  await loadState();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
});

// Load state from storage
async function loadState() {
  try {
    const stored = await chrome.storage.local.get(['settings', 'voiceProfile', 'learnedExceptions', 'coachEnabled']);
    settings = stored.settings || {
      provider: 'anthropic',
      apiKey: '',
      intensity: 'balanced',
      styleGuide: '',
      checks: { grammar: true },
      ambientLearning: false
    };
    voiceProfile = stored.voiceProfile || { samples: [], summary: null };
    learnedExceptions = stored.learnedExceptions || [];
    coachEnabled = stored.coachEnabled || false;
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

// Message handler with sender validation
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate sender - only accept messages from our extension
  const isFromExtension = sender.id === chrome.runtime.id;
  const isFromPopup = !sender.tab; // Popup has no tab
  const isFromContentScript = sender.tab &&
    (sender.url?.startsWith('https://docs.google.com') ||
     sender.url?.startsWith('https://mail.google.com'));

  if (!isFromExtension || (!isFromPopup && !isFromContentScript)) {
    console.warn('Rejected message from unauthorized sender:', sender);
    sendResponse({ error: 'Unauthorized' });
    return;
  }

  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('Message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'SETTINGS_UPDATED':
      settings = message.settings;
      if (message.learnedExceptions) {
        learnedExceptions = message.learnedExceptions;
      }
      // Broadcast settings to content scripts
      broadcastToContentScripts({
        type: 'SETTINGS_UPDATED',
        settings: settings
      });
      return { success: true };

    case 'EXCEPTIONS_UPDATED':
      learnedExceptions = message.learnedExceptions || [];
      return { success: true };

    case 'VOICE_PROFILE_RESET':
      voiceProfile = { samples: [], summary: null };
      return { success: true };

    case 'UPDATE_VOICE_PROFILE':
      return await updateVoiceProfile(message.samples);

    case 'ANALYZE_TEXT':
      return await analyzeText(message.text, message.context);

    case 'COACH_TOGGLE':
      coachEnabled = message.enabled;
      // Notify all content scripts
      broadcastToContentScripts({ type: 'COACH_STATUS', enabled: coachEnabled });
      return { success: true };

    case 'GET_STATE':
      return {
        settings,
        voiceProfile,
        learnedExceptions,
        coachEnabled
      };

    case 'LEARN_FROM_DOCUMENT':
      return await learnFromDocument(message.text, message.source, message.title);

    case 'IMPORT_URL':
      return await importFromUrl(message.url);

    case 'REVIEW_DOCUMENT':
      return await reviewDocument(message.text);

    case 'AMBIENT_LEARN':
      return await ambientLearn(message.text, message.typedCharCount);

    case 'CHAT_MESSAGE':
      return await handleChatMessage(message.message, message.context, message.history);

    case 'GENERATE_IN_VOICE':
      return await generateInVoice(message.prompt, message.length);

    case 'SUGGESTION_FEEDBACK':
      handleFeedback(message.suggestion, message.accepted);
      return { success: true };

    default:
      return { error: 'Unknown message type' };
  }
}

// Broadcast message to all content scripts
async function broadcastToContentScripts(message) {
  const tabs = await chrome.tabs.query({
    url: ['https://docs.google.com/*', 'https://mail.google.com/*']
  });

  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      // Tab might not have content script loaded yet
    }
  }
}

// Update voice profile with new samples
async function updateVoiceProfile(samples) {
  // Ensure we have latest settings (worker may have been idle)
  await loadState();

  // Initialize voiceProfile if null
  if (!voiceProfile) {
    voiceProfile = { samples: [], summary: null };
  }

  if (!settings?.apiKey) {
    return { error: 'No API key configured. Go to Settings tab and add your API key.' };
  }

  voiceProfile.samples = samples;

  // Generate voice summary from samples
  const sampleTexts = samples.map(s => s.text).join('\n\n---\n\n');

  const prompt = `You are analyzing writing samples to create a voice profile. Study these writing samples carefully and describe the writer's unique voice in 4-6 short, specific observations.

Focus on:
- Sentence structure and length patterns
- Word choice and vocabulary level
- Tone (formal/casual, direct/indirect)
- Punctuation habits
- Common phrases or expressions
- Writing rhythm and flow

Writing samples:
"""
${sampleTexts}
"""

Respond with ONLY the voice profile as a series of short observations separated by periods. Be specific and actionable. Example format:
"Short, punchy sentences averaging 8-12 words. Avoids passive voice entirely. Uses 'actually' and 'honestly' frequently. Conversational tone with direct reader address. Minimal semicolons and em-dashes. Starts sentences with 'And' or 'But' for emphasis."`;

  try {
    const summary = await callAI(prompt);
    voiceProfile.summary = summary;
    voiceProfile.lastUpdated = new Date().toISOString();

    // Save to storage
    await chrome.storage.local.set({ voiceProfile });

    // Invalidate analysis cache since voice profile changed
    analysisCache.clear();

    return { summary };
  } catch (err) {
    console.error('Failed to generate voice summary:', err);
    return { error: err.message };
  }
}

// Count words in text
function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

// Learn from a document (passive learning)
async function learnFromDocument(text, source, title) {
  // Ensure we have latest state
  await loadState();

  // Initialize voiceProfile if null
  if (!voiceProfile) {
    voiceProfile = { samples: [], summary: null };
  }

  if (!text || text.length < 100) {
    return { error: 'Document is too short to learn from' };
  }

  // Count words for badges
  const wordCount = countWords(text);

  // Truncate if too long (keep first 5000 chars)
  const truncatedText = text.length > 5000 ? text.substring(0, 5000) + '...' : text;

  // Add as a sample
  voiceProfile.samples.push({
    text: truncatedText,
    source: source || 'document',
    title: title || 'Untitled',
    addedAt: new Date().toISOString()
  });

  // Keep only last 20 samples
  voiceProfile.samples = voiceProfile.samples.slice(-20);

  // Notify popup of words added (for badges)
  chrome.runtime.sendMessage({
    type: 'WORDS_ADDED',
    wordCount: wordCount
  }).catch(() => {});

  // Notify popup of document analyzed
  chrome.runtime.sendMessage({
    type: 'DOCUMENT_ANALYZED'
  }).catch(() => {});

  // Re-generate voice summary if we have an API key
  if (settings?.apiKey) {
    try {
      const result = await updateVoiceProfile(voiceProfile.samples);

      // Notify popup that a pattern was learned (voice profile updated)
      chrome.runtime.sendMessage({
        type: 'PATTERN_LEARNED'
      }).catch(() => {});

      return { success: true, voiceProfile, summary: result.summary, wordCount };
    } catch (err) {
      // Still save the sample even if summary generation fails
      await chrome.storage.local.set({ voiceProfile });
      return { success: true, voiceProfile, warning: 'Sample added but summary update failed', wordCount };
    }
  }

  await chrome.storage.local.set({ voiceProfile });
  return { success: true, voiceProfile, wordCount };
}

// Import from URL (fetch and extract article text)
async function importFromUrl(url) {
  // Ensure we have latest state (worker may have been idle)
  await loadState();

  // Initialize voiceProfile if null
  if (!voiceProfile) {
    voiceProfile = { samples: [], summary: null };
  }

  if (!url) {
    return { error: 'No URL provided' };
  }

  try {
    // Validate URL format
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { error: 'Invalid URL format' };
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      mode: 'cors',
      credentials: 'omit'
    });

    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        return { error: 'This site blocks automated access. Copy the text and paste it above.' };
      }
      return { error: `Failed to fetch URL (${response.status}). Try copying the text instead.` };
    }

    const html = await response.text();

    // Extract article content using common patterns
    let articleText = '';

    // Try to find article content
    const articlePatterns = [
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*post-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<main[^>]*>([\s\S]*?)<\/main>/i
    ];

    for (const pattern of articlePatterns) {
      const match = html.match(pattern);
      if (match) {
        articleText = match[1];
        break;
      }
    }

    // Fallback: get body content
    if (!articleText) {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) {
        articleText = bodyMatch[1];
      }
    }

    if (!articleText) {
      return { error: 'Could not extract content from this page' };
    }

    // Strip HTML tags and clean up
    articleText = articleText
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (articleText.length < 200) {
      return { error: 'Article content is too short' };
    }

    // Truncate if too long
    if (articleText.length > 5000) {
      articleText = articleText.substring(0, 5000) + '...';
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;

    // Count words for badges
    const wordCount = countWords(articleText);

    // Add as sample
    voiceProfile.samples.push({
      text: articleText,
      source: 'url',
      title: title,
      url: url,
      addedAt: new Date().toISOString()
    });

    // Keep only last 20 samples
    voiceProfile.samples = voiceProfile.samples.slice(-20);

    // Notify popup of words added (for badges)
    chrome.runtime.sendMessage({
      type: 'WORDS_ADDED',
      wordCount: wordCount
    }).catch(() => {});

    // Notify popup of document analyzed
    chrome.runtime.sendMessage({
      type: 'DOCUMENT_ANALYZED'
    }).catch(() => {});

    // Update voice summary
    if (settings?.apiKey) {
      await updateVoiceProfile(voiceProfile.samples);

      // Notify popup that a pattern was learned
      chrome.runtime.sendMessage({
        type: 'PATTERN_LEARNED'
      }).catch(() => {});
    }

    await chrome.storage.local.set({ voiceProfile });

    return { success: true, voiceProfile, wordCount };
  } catch (err) {
    console.error('URL import failed:', err);
    // CORS errors and network failures typically throw here
    if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) {
      return { error: 'This site blocks cross-origin requests. Copy the text and paste it above.' };
    }
    return { error: 'Import failed. Try copying the text and pasting it above.' };
  }
}

// Analyze text for off-voice moments
async function analyzeText(text, context = {}) {
  if (!settings?.apiKey) {
    return { error: 'No API key configured' };
  }

  if (!voiceProfile?.summary) {
    return { error: 'No voice profile configured' };
  }

  if (!text || text.trim().length < 20) {
    return { suggestions: [] };
  }

  // Check cache first (before rate limiting)
  const normalizedText = text.trim();
  const cachedResult = analysisCache.get(normalizedText);
  if (cachedResult) {
    return cachedResult;
  }

  // Rate limiting check
  if (!rateLimiter.canMakeCall()) {
    const waitTime = Math.ceil(rateLimiter.getTimeUntilNextCall() / 1000);
    return { error: `Rate limited. Please wait ${waitTime} seconds.`, rateLimited: true };
  }
  rateLimiter.recordCall();

  const intensityGuide = {
    gentle: 'Only flag major deviations that clearly don\'t match the voice. Be conservative.',
    balanced: 'Flag noticeable deviations while allowing for natural variation.',
    strict: 'Flag any text that doesn\'t strongly match the established voice patterns.'
  };

  // Build style guide section
  const styleGuideSection = settings.styleGuide
    ? `\nCOMPANY STYLE GUIDE:\n${settings.styleGuide}\n`
    : '';

  // Build learned exceptions section
  const exceptionsSection = learnedExceptions.length > 0
    ? `\nLEARNED EXCEPTIONS (patterns the user has confirmed are intentional - DO NOT flag these):\n${learnedExceptions.map(e => `- "${e.pattern}"`).join('\n')}\n`
    : '';

  // Build grammar instruction
  const grammarInstruction = settings.checks?.grammar
    ? `
GRAMMAR & TYPOS:
Also check for likely typos and grammar mistakes (their/they're, its/it's, etc.). BUT only flag these if they appear to be genuine mistakes, not intentional style choices. If the user consistently uses informal grammar in their samples, respect that. Frame grammar suggestions helpfully: "Did you mean 'their' here?" not "Grammar error."`
    : '\nDo NOT flag grammar or spelling issues - focus only on voice.';

  const prompt = `You are a personalized writing coach. You understand this specific writer's voice deeply and help them stay true to it. You're not enforcing generic "good writing" rules - you're helping them sound like THEMSELVES.

VOICE PROFILE:
${voiceProfile.summary}

SAMPLE WRITINGS (this is how they naturally write):
${voiceProfile.samples.slice(0, 3).map(s => `"${s.text.substring(0, 200)}..."`).join('\n')}
${styleGuideSection}${exceptionsSection}
COACHING INTENSITY: ${settings.intensity}
${intensityGuide[settings.intensity] || intensityGuide.balanced}
${grammarInstruction}

TEXT TO ANALYZE:
"""
${text}
"""

Analyze this text and identify:
1. Moments that don't match the writer's established voice/style
2. Deviations from the company style guide (if provided)
3. Likely typos or grammar mistakes (if grammar checking is enabled)

For each issue, provide:
- The exact problematic text
- A suggested revision that matches THEIR voice (not generic "better writing")
- A brief, personalized explanation that references their specific patterns

Respond in this exact JSON format:
{
  "suggestions": [
    {
      "original": "exact text from the input",
      "suggestion": "revised version matching their voice",
      "reason": "brief personalized explanation",
      "type": "voice|style_guide|grammar"
    }
  ],
  "detections": {
    "aiScore": 0-100,
    "genericScore": 0-100,
    "aiIndicators": ["list of specific phrases that sound AI-generated"],
    "genericIndicators": ["list of specific phrases that sound generic/Grammarly-fied"]
  }
}

AI-GENERATED DETECTION (aiScore):
Look for signs the text was written by AI:
- Overly formal or stilted phrasing
- Perfect parallel structure that feels mechanical
- Phrases like "It's important to note", "In conclusion", "Furthermore"
- Excessive hedging ("It's worth mentioning", "One might argue")
- Unnatural transitions between ideas
- Lack of personality, opinion, or authentic voice
- Generic analogies and examples

GENERIC/GRAMMARLY DETECTION (genericScore):
Look for signs the text has been over-polished into blandness:
- Corporate buzzwords ("leverage", "synergy", "streamline")
- Passive voice overuse where active voice is more natural
- Overly cautious language that removes personality
- Perfect grammar that feels sterile
- Formal constructions where casual would be better ("utilize" vs "use")

If the text matches their voice well, return: {"suggestions": [], "detections": {"aiScore": 0, "genericScore": 0, "aiIndicators": [], "genericIndicators": []}}

CRITICAL RULES:
- This is about THEIR voice, not "correct" writing
- If they use sentence fragments for punch, that's their style - don't flag it
- If they start sentences with "And" or "But", that's intentional - don't flag it
- Reference their specific patterns in explanations (e.g., "You usually write shorter sentences")
- Be encouraging and helpful, like a trusted editor who knows them
- Maximum 3 suggestions per analysis
- Never flag anything in the LEARNED EXCEPTIONS list`;

  try {
    const response = await callAI(prompt);

    // Parse JSON response
    let result;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        result = { suggestions: [] };
      }
    } catch (parseErr) {
      console.error('Failed to parse AI response:', parseErr);
      result = { suggestions: [] };
    }

    // Filter out any suggestions that match learned exceptions
    if (result.suggestions && learnedExceptions.length > 0) {
      result.suggestions = result.suggestions.filter(s => {
        const original = s.original.toLowerCase().trim();
        return !learnedExceptions.some(e =>
          original.includes(e.pattern.toLowerCase()) ||
          e.pattern.toLowerCase().includes(original)
        );
      });
    }

    // Notify popup of new suggestions
    if (result.suggestions && result.suggestions.length > 0) {
      for (const suggestion of result.suggestions) {
        chrome.runtime.sendMessage({
          type: 'NEW_SUGGESTION',
          suggestion
        }).catch(() => {
          // Popup might be closed
        });
      }
    }

    // Ensure detections object exists with defaults
    if (!result.detections) {
      result.detections = {
        aiScore: 0,
        genericScore: 0,
        aiIndicators: [],
        genericIndicators: []
      };
    }

    // Cache successful result
    analysisCache.set(normalizedText, result);

    return result;
  } catch (err) {
    console.error('Failed to analyze text:', err);
    return { error: err.message };
  }
}

// Call AI API (Claude or OpenAI)
async function callAI(prompt) {
  if (settings.provider === 'anthropic') {
    return await callClaude(prompt);
  } else {
    return await callOpenAI(prompt);
  }
}

/**
 * Get decrypted API key
 */
async function getApiKey() {
  const storedKey = settings.apiKey;
  if (!storedKey) return '';

  // Check if key is encrypted (doesn't start with sk-)
  if (isEncrypted(storedKey)) {
    return await decrypt(storedKey);
  }

  // Return as-is if not encrypted (legacy or just set)
  return storedKey;
}

// Call Claude API
async function callClaude(prompt) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('No API key configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// Call OpenAI API
async function callOpenAI(prompt) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('No API key configured');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful writing coach that helps users maintain their unique voice.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// Ambient learning - learn from user's active typing
async function ambientLearn(text, typedCharCount) {
  // Ensure we have latest state
  await loadState();

  // Initialize voiceProfile if null
  if (!voiceProfile) {
    voiceProfile = { samples: [], summary: null };
  }

  if (!text || text.length < 200) {
    return { error: 'Not enough text to learn from' };
  }

  if (!settings?.ambientLearning) {
    return { error: 'Ambient learning is disabled' };
  }

  // Use the typed char count to estimate what portion of text was typed
  // This is a heuristic - we can't perfectly distinguish typed vs pasted
  const wordCount = countWords(text);

  // Truncate to a reasonable sample size
  const sampleText = text.length > 3000 ? text.substring(0, 3000) + '...' : text;

  // Check if we already have similar content
  const existingSamples = voiceProfile.samples || [];
  const isDuplicate = existingSamples.some(sample => {
    const similarity = calculateTextSimilarity(sample.text, sampleText);
    return similarity > 0.7; // 70% similar = duplicate
  });

  if (isDuplicate) {
    return { error: 'Similar content already in voice profile', duplicate: true };
  }

  // Add as ambient sample with lower weight indicator
  voiceProfile.samples.push({
    text: sampleText,
    source: 'ambient',
    title: 'Writing session ' + new Date().toLocaleDateString(),
    addedAt: new Date().toISOString(),
    typedChars: typedCharCount
  });

  // Keep only last 20 samples
  voiceProfile.samples = voiceProfile.samples.slice(-20);

  // Notify popup of words added
  chrome.runtime.sendMessage({
    type: 'WORDS_ADDED',
    wordCount: Math.round(typedCharCount / 5) // Estimate words from chars
  }).catch(() => {});

  // Update voice profile if we have API key
  if (settings?.apiKey) {
    try {
      const result = await updateVoiceProfile(voiceProfile.samples);

      chrome.runtime.sendMessage({
        type: 'PATTERN_LEARNED'
      }).catch(() => {});

      return { success: true, summary: result.summary };
    } catch (err) {
      await chrome.storage.local.set({ voiceProfile });
      return { success: true, warning: 'Sample saved but analysis pending' };
    }
  }

  await chrome.storage.local.set({ voiceProfile });
  return { success: true };
}

// Simple text similarity check (Jaccard similarity on words)
function calculateTextSimilarity(text1, text2) {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

// Full document review for side-by-side view
async function reviewDocument(text) {
  if (!settings?.apiKey) {
    return { error: 'No API key configured' };
  }

  if (!voiceProfile?.summary) {
    return { error: 'No voice profile configured. Add writing samples first.' };
  }

  if (!text || text.trim().length < 50) {
    return { error: 'Document is too short to review' };
  }

  // Rate limiting check
  if (!rateLimiter.canMakeCall()) {
    const waitTime = Math.ceil(rateLimiter.getTimeUntilNextCall() / 1000);
    return { error: `Rate limited. Please wait ${waitTime} seconds.`, rateLimited: true };
  }
  rateLimiter.recordCall();

  // Build style guide section
  const styleGuideSection = settings.styleGuide
    ? `\nCOMPANY STYLE GUIDE:\n${settings.styleGuide}\n`
    : '';

  // Build learned exceptions section
  const exceptionsSection = learnedExceptions.length > 0
    ? `\nLEARNED EXCEPTIONS (patterns the user has confirmed are intentional - DO NOT flag these):\n${learnedExceptions.map(e => `- "${e.pattern}"`).join('\n')}\n`
    : '';

  const grammarInstruction = settings.checks?.grammar
    ? `Also check for likely typos and grammar mistakes. Only flag genuine mistakes, not intentional style choices.`
    : 'Do NOT flag grammar or spelling - focus only on voice.';

  const prompt = `You are a personalized writing coach doing a full document review. Analyze this text and suggest edits to match the writer's voice.

VOICE PROFILE:
${voiceProfile.summary}

SAMPLE WRITINGS (this is how they naturally write):
${voiceProfile.samples.slice(0, 3).map(s => `"${s.text.substring(0, 200)}..."`).join('\n')}
${styleGuideSection}${exceptionsSection}
${grammarInstruction}

DOCUMENT TO REVIEW:
"""
${text}
"""

Analyze this document and provide suggestions for each phrase or sentence that doesn't match the writer's voice. For each issue:
1. Include the EXACT original text (verbatim, character-for-character match)
2. Provide a revised version that matches their voice
3. Brief reason

Respond in this exact JSON format:
{
  "suggestions": [
    {
      "original": "exact text from document",
      "suggestion": "revised version",
      "reason": "brief explanation"
    }
  ],
  "summary": "one sentence overall assessment"
}

RULES:
- Maximum 10 suggestions
- Original text MUST be an exact substring from the document
- Focus on the most impactful changes
- If document already matches their voice well, return fewer suggestions
- Return {"suggestions": [], "summary": "..."} if no changes needed`;

  try {
    const response = await callAI(prompt);

    let result;
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        result = { suggestions: [], summary: 'Could not parse response' };
      }
    } catch (parseErr) {
      console.error('Failed to parse review response:', parseErr);
      result = { suggestions: [], summary: 'Could not parse response' };
    }

    // Filter out learned exceptions
    if (result.suggestions && learnedExceptions.length > 0) {
      result.suggestions = result.suggestions.filter(s => {
        const original = s.original.toLowerCase().trim();
        return !learnedExceptions.some(e =>
          original.includes(e.pattern.toLowerCase()) ||
          e.pattern.toLowerCase().includes(original)
        );
      });
    }

    return result;
  } catch (err) {
    console.error('Document review failed:', err);
    return { error: err.message };
  }
}

// ============================================
// Chat functionality
// ============================================

async function handleChatMessage(userMessage, context, history) {
  if (!settings?.apiKey) {
    return { error: 'No API key configured' };
  }

  // Rate limiting
  if (!rateLimiter.canMakeCall()) {
    const waitTime = Math.ceil(rateLimiter.getTimeUntilNextCall() / 1000);
    return { error: `Please wait ${waitTime} seconds.`, rateLimited: true };
  }
  rateLimiter.recordCall();

  // Build conversation with voice context
  const voiceContext = voiceProfile?.summary
    ? `You understand this writer's voice deeply:\n${voiceProfile.summary}\n\n`
    : '';

  const documentContext = context
    ? `Current text they're working on:\n"""${context.substring(0, 2000)}"""\n\n`
    : '';

  const historyText = history && history.length > 0
    ? history.map(h => `${h.role === 'user' ? 'User' : 'Perkins'}: ${h.content}`).join('\n') + '\n\n'
    : '';

  const prompt = `You are Perkins, a friendly writing coach who deeply understands this specific writer's voice and style. You're having a conversation about their writing.

${voiceContext}${documentContext}Previous conversation:
${historyText}User: ${userMessage}

Respond helpfully and conversationally. Keep responses concise (2-3 paragraphs max). If they ask about their writing style, reference specific patterns you've observed. If they ask for help, provide suggestions that match their voice.`;

  try {
    const reply = await callAI(prompt);
    return { reply };
  } catch (err) {
    console.error('Chat failed:', err);
    return { error: err.message };
  }
}

// ============================================
// Generate in voice functionality
// ============================================

async function generateInVoice(prompt, length = 'medium') {
  if (!settings?.apiKey) {
    return { error: 'No API key configured' };
  }

  if (!voiceProfile?.summary) {
    return { error: 'Train your voice profile first' };
  }

  // Rate limiting
  if (!rateLimiter.canMakeCall()) {
    const waitTime = Math.ceil(rateLimiter.getTimeUntilNextCall() / 1000);
    return { error: `Please wait ${waitTime} seconds.`, rateLimited: true };
  }
  rateLimiter.recordCall();

  const lengthGuide = {
    short: '1-2 sentences, punchy and brief',
    medium: '1-2 paragraphs',
    long: '3-4 paragraphs, comprehensive'
  };

  const sampleTexts = voiceProfile.samples.slice(0, 3)
    .map(s => `"${s.text.substring(0, 300)}..."`)
    .join('\n\n');

  const aiPrompt = `You are a ghostwriter who has mastered this specific person's voice. Write exactly as they would write.

VOICE PROFILE:
${voiceProfile.summary}

SAMPLE WRITINGS (mimic this style exactly):
${sampleTexts}

TASK:
Write the following in their voice: ${prompt}

LENGTH: ${lengthGuide[length] || lengthGuide.medium}

CRITICAL RULES:
- Match their sentence length patterns exactly
- Use their vocabulary and phrases
- Maintain their tone (formal/casual, direct/indirect)
- Mirror their punctuation habits
- This should be indistinguishable from their own writing
- Do NOT add any meta-commentary, just write the content`;

  try {
    const text = await callAI(aiPrompt);
    return { text };
  } catch (err) {
    console.error('Generate failed:', err);
    return { error: err.message };
  }
}

async function handleFeedback(suggestion, accepted) {
  // Store feedback for future learning
  const stored = await chrome.storage.local.get(['feedback']);
  const feedback = stored.feedback || [];

  feedback.push({
    ...suggestion,
    accepted,
    timestamp: new Date().toISOString()
  });

  // Keep last 100 feedback items
  const trimmedFeedback = feedback.slice(-100);
  await chrome.storage.local.set({ feedback: trimmedFeedback });

  // Update stats in popup
  if (accepted) {
    chrome.runtime.sendMessage({ type: 'SUGGESTION_ACCEPTED' }).catch(() => {});
  } else {
    // Notify popup that suggestion was rejected (to add to learned exceptions)
    chrome.runtime.sendMessage({
      type: 'SUGGESTION_REJECTED',
      suggestion
    }).catch(() => {});
  }
}
