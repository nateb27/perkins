/**
 * Perkins Background Service Worker
 * Handles AI API calls and message routing
 */

// State cache (loaded from storage)
let settings = null;
let voiceProfile = null;
let coachEnabled = false;

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
    const stored = await chrome.storage.local.get(['settings', 'voiceProfile', 'coachEnabled']);
    settings = stored.settings || { provider: 'anthropic', apiKey: '', intensity: 'balanced' };
    voiceProfile = stored.voiceProfile || { samples: [], summary: null };
    coachEnabled = stored.coachEnabled || false;
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
        coachEnabled
      };

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

  const intensityGuide = {
    gentle: 'Only flag major deviations that clearly don\'t match the voice. Be conservative.',
    balanced: 'Flag noticeable deviations while allowing for natural variation.',
    strict: 'Flag any text that doesn\'t strongly match the established voice patterns.'
  };

  const prompt = `You are a writing coach helping someone maintain their unique voice. Your job is to identify moments where the writing doesn't match their established style.

VOICE PROFILE:
${voiceProfile.summary}

SAMPLE WRITINGS (for reference):
${voiceProfile.samples.slice(0, 3).map(s => `"${s.text.substring(0, 200)}..."`).join('\n')}

COACHING INTENSITY: ${settings.intensity}
${intensityGuide[settings.intensity] || intensityGuide.balanced}

TEXT TO ANALYZE:
"""
${text}
"""

Analyze this text and identify any phrases or sentences that don't match the writer's voice profile. For each issue found, provide:
1. The exact problematic text
2. A suggested revision that matches their voice
3. A brief, personalized explanation (e.g., "You never write passively" or "This is more formal than your usual style")

Respond in this exact JSON format:
{
  "suggestions": [
    {
      "original": "exact text from the input",
      "suggestion": "revised version matching their voice",
      "reason": "brief personalized explanation"
    }
  ]
}

If the text matches their voice well, return: {"suggestions": []}

IMPORTANT:
- Only flag genuine voice mismatches, not grammar issues
- Keep suggestions true to THEIR voice, not generic "good writing"
- Be encouraging, not critical
- Maximum 3 suggestions per analysis`;

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

// Call Claude API
async function callClaude(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
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
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`
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
  }
}
