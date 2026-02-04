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
      checks: { grammar: true }
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

    case 'IMPORT_TWITTER':
      return await importFromTwitter(message.handle);

    case 'IMPORT_URL':
      return await importFromUrl(message.url);

    case 'REVIEW_DOCUMENT':
      return await reviewDocument(message.text);

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
  if (!settings?.apiKey) {
    return { error: 'No API key configured' };
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

    return { summary };
  } catch (err) {
    console.error('Failed to generate voice summary:', err);
    return { error: err.message };
  }
}

// Learn from a document (passive learning)
async function learnFromDocument(text, source, title) {
  if (!text || text.length < 100) {
    return { error: 'Document is too short to learn from' };
  }

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

  // Re-generate voice summary if we have an API key
  if (settings?.apiKey) {
    try {
      const result = await updateVoiceProfile(voiceProfile.samples);
      return { success: true, voiceProfile, summary: result.summary };
    } catch (err) {
      // Still save the sample even if summary generation fails
      await chrome.storage.local.set({ voiceProfile });
      return { success: true, voiceProfile, warning: 'Sample added but summary update failed' };
    }
  }

  await chrome.storage.local.set({ voiceProfile });
  return { success: true, voiceProfile };
}

// Import from Twitter (using Nitter as a proxy for public tweets)
async function importFromTwitter(handle) {
  if (!handle) {
    return { error: 'No Twitter handle provided' };
  }

  // Clean handle
  handle = handle.replace(/^@/, '');

  try {
    // Try multiple Nitter instances (they can be unreliable)
    const nitterInstances = [
      'nitter.net',
      'nitter.privacydev.net',
      'nitter.poast.org'
    ];

    let tweets = [];
    let lastError = null;

    for (const instance of nitterInstances) {
      try {
        const response = await fetch(`https://${instance}/${handle}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (!response.ok) continue;

        const html = await response.text();

        // Extract tweets from HTML (Nitter uses .tweet-content class)
        const tweetMatches = html.match(/<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) || [];

        tweets = tweetMatches
          .map(match => {
            // Strip HTML tags
            return match.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          })
          .filter(t => t.length > 30 && t.length < 1000) // Filter reasonable length tweets
          .slice(0, 20); // Take up to 20 tweets

        if (tweets.length > 0) break;
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    if (tweets.length === 0) {
      return { error: 'Could not fetch tweets. The account may be private or Twitter/Nitter may be unavailable.' };
    }

    // Add tweets as samples
    for (const tweet of tweets) {
      voiceProfile.samples.push({
        text: tweet,
        source: 'twitter',
        title: `@${handle}`,
        addedAt: new Date().toISOString()
      });
    }

    // Keep only last 20 samples
    voiceProfile.samples = voiceProfile.samples.slice(-20);

    // Update voice summary
    if (settings?.apiKey) {
      await updateVoiceProfile(voiceProfile.samples);
    }

    await chrome.storage.local.set({ voiceProfile });

    return { success: true, voiceProfile, count: tweets.length };
  } catch (err) {
    console.error('Twitter import failed:', err);
    return { error: 'Failed to import tweets. Try again later.' };
  }
}

// Import from URL (fetch and extract article text)
async function importFromUrl(url) {
  if (!url) {
    return { error: 'No URL provided' };
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return { error: `Failed to fetch URL: ${response.status}` };
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

    // Update voice summary
    if (settings?.apiKey) {
      await updateVoiceProfile(voiceProfile.samples);
    }

    await chrome.storage.local.set({ voiceProfile });

    return { success: true, voiceProfile };
  } catch (err) {
    console.error('URL import failed:', err);
    return { error: 'Failed to import from URL. Check the URL and try again.' };
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
  ]
}

If the text matches their voice well, return: {"suggestions": []}

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

// Handle feedback (accept/reject suggestions)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SUGGESTION_FEEDBACK') {
    handleFeedback(message.suggestion, message.accepted);
  }
});

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
