/**
 * Perkins Popup Controller
 * Handles tab switching, settings management, and voice training
 */

import { encrypt, decrypt, isEncrypted } from '../lib/crypto.js';

// DOM Elements
const elements = {
  // Status
  status: document.getElementById('status'),
  statusText: document.querySelector('.status-text'),

  // Tabs
  tabs: document.querySelectorAll('.tab'),
  tabContents: document.querySelectorAll('.tab-content'),

  // Coach tab
  coachEnabled: document.getElementById('coach-enabled'),
  suggestionsCount: document.getElementById('suggestions-count'),
  acceptedCount: document.getElementById('accepted-count'),
  voiceScore: document.getElementById('voice-score'),
  recentSuggestions: document.getElementById('recent-suggestions'),

  // Voice tab
  voiceStatus: document.getElementById('voice-status'),
  writingSample: document.getElementById('writing-sample'),
  addSampleBtn: document.getElementById('add-sample'),
  sampleCount: document.getElementById('sample-count'),
  voicePatterns: document.getElementById('voice-patterns'),
  resetVoiceBtn: document.getElementById('reset-voice'),
  twitterHandleInput: document.getElementById('twitter-handle'),
  importTwitterBtn: document.getElementById('import-twitter'),
  importUrlInput: document.getElementById('import-url'),
  importUrlBtn: document.getElementById('import-url-btn'),

  // Settings tab
  providerRadios: document.querySelectorAll('input[name="provider"]'),
  apiKeyInput: document.getElementById('api-key'),
  toggleKeyBtn: document.getElementById('toggle-key'),
  saveSettingsBtn: document.getElementById('save-settings'),
  intensitySelect: document.getElementById('intensity'),
  passiveVoiceCheck: document.getElementById('passive-voice'),
  sentenceLengthCheck: document.getElementById('sentence-length'),
  wordChoiceCheck: document.getElementById('word-choice'),
  checkGrammarCheck: document.getElementById('check-grammar'),
  styleGuideInput: document.getElementById('style-guide'),
  learnedExceptions: document.getElementById('learned-exceptions')
};

// State
let state = {
  settings: {
    provider: 'anthropic',
    apiKey: '',
    intensity: 'balanced',
    styleGuide: '',
    checks: {
      passiveVoice: true,
      sentenceLength: true,
      wordChoice: true,
      grammar: true
    }
  },
  voiceProfile: {
    samples: [],
    summary: null,
    lastUpdated: null
  },
  learnedExceptions: [], // Patterns the user has marked as intentional
  stats: {
    suggestionsToday: 0,
    acceptedToday: 0,
    totalSuggestions: 0,
    totalAccepted: 0,
    lastResetDate: null
  },
  coachEnabled: false,
  recentSuggestions: []
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  initTabs();
  initSettings();
  initVoiceTraining();
  initCoach();
  updateUI();
});

// Load state from Chrome storage
async function loadState() {
  try {
    const stored = await chrome.storage.local.get([
      'settings',
      'voiceProfile',
      'learnedExceptions',
      'stats',
      'coachEnabled',
      'recentSuggestions'
    ]);

    if (stored.settings) state.settings = { ...state.settings, ...stored.settings };
    if (stored.voiceProfile) state.voiceProfile = { ...state.voiceProfile, ...stored.voiceProfile };
    if (stored.learnedExceptions) state.learnedExceptions = stored.learnedExceptions;
    if (stored.stats) state.stats = { ...state.stats, ...stored.stats };
    if (stored.coachEnabled !== undefined) state.coachEnabled = stored.coachEnabled;
    if (stored.recentSuggestions) state.recentSuggestions = stored.recentSuggestions;

    // Reset daily stats if new day
    const today = new Date().toDateString();
    if (state.stats.lastResetDate !== today) {
      state.stats.suggestionsToday = 0;
      state.stats.acceptedToday = 0;
      state.stats.lastResetDate = today;
      await saveState();
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

// Save state to Chrome storage
async function saveState() {
  try {
    await chrome.storage.local.set({
      settings: state.settings,
      voiceProfile: state.voiceProfile,
      learnedExceptions: state.learnedExceptions,
      stats: state.stats,
      coachEnabled: state.coachEnabled,
      recentSuggestions: state.recentSuggestions
    });
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

// Tab switching
function initTabs() {
  elements.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab + '-tab';

      // Update active tab
      elements.tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update active content
      elements.tabContents.forEach(content => {
        content.classList.toggle('active', content.id === targetId);
      });
    });
  });
}

// Settings initialization
function initSettings() {
  // Load current settings into UI
  elements.providerRadios.forEach(radio => {
    radio.checked = radio.value === state.settings.provider;
    radio.addEventListener('change', () => {
      state.settings.provider = radio.value;
    });
  });

  // Show masked placeholder if API key is encrypted
  if (state.settings.apiKey && isEncrypted(state.settings.apiKey)) {
    elements.apiKeyInput.value = '';
    elements.apiKeyInput.placeholder = 'API key saved (encrypted)';
  } else {
    elements.apiKeyInput.value = state.settings.apiKey;
  }
  elements.intensitySelect.value = state.settings.intensity;
  elements.passiveVoiceCheck.checked = state.settings.checks.passiveVoice;
  elements.sentenceLengthCheck.checked = state.settings.checks.sentenceLength;
  elements.wordChoiceCheck.checked = state.settings.checks.wordChoice;
  elements.checkGrammarCheck.checked = state.settings.checks.grammar;
  elements.styleGuideInput.value = state.settings.styleGuide || '';

  // Toggle API key visibility
  elements.toggleKeyBtn.addEventListener('click', () => {
    const isPassword = elements.apiKeyInput.type === 'password';
    elements.apiKeyInput.type = isPassword ? 'text' : 'password';
  });

  // Save settings
  elements.saveSettingsBtn.addEventListener('click', async () => {
    const rawApiKey = elements.apiKeyInput.value.trim();

    // Encrypt API key if it looks like a raw key (starts with sk-)
    if (rawApiKey && (rawApiKey.startsWith('sk-') || rawApiKey.startsWith('sk-ant-'))) {
      try {
        state.settings.apiKey = await encrypt(rawApiKey);
      } catch (err) {
        console.error('Failed to encrypt API key:', err);
        showToast('Failed to secure API key', 'error');
        return;
      }
    } else {
      // Keep as-is if already encrypted or empty
      state.settings.apiKey = rawApiKey;
    }

    state.settings.intensity = elements.intensitySelect.value;
    state.settings.styleGuide = elements.styleGuideInput.value.trim();
    state.settings.checks.passiveVoice = elements.passiveVoiceCheck.checked;
    state.settings.checks.sentenceLength = elements.sentenceLengthCheck.checked;
    state.settings.checks.wordChoice = elements.wordChoiceCheck.checked;
    state.settings.checks.grammar = elements.checkGrammarCheck.checked;

    await saveState();
    updateUI();
    showToast('Settings saved!', 'success');

    // Notify background worker of settings change
    chrome.runtime.sendMessage({
      type: 'SETTINGS_UPDATED',
      settings: state.settings,
      learnedExceptions: state.learnedExceptions
    });
  });
}

// Voice training initialization
function initVoiceTraining() {
  // Add writing sample
  elements.addSampleBtn.addEventListener('click', async () => {
    const sample = elements.writingSample.value.trim();

    if (!sample) {
      showToast('Please paste a writing sample first', 'error');
      return;
    }

    if (sample.length < 50) {
      showToast('Sample is too short. Add at least 50 characters.', 'error');
      return;
    }

    // Add sample
    state.voiceProfile.samples.push({
      text: sample,
      addedAt: new Date().toISOString()
    });

    // Clear input
    elements.writingSample.value = '';

    // Request voice summary update from background worker
    showToast('Sample added! Analyzing your voice...', 'success');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'UPDATE_VOICE_PROFILE',
        samples: state.voiceProfile.samples
      });

      if (response && response.summary) {
        state.voiceProfile.summary = response.summary;
        state.voiceProfile.lastUpdated = new Date().toISOString();
      }
    } catch (err) {
      console.error('Failed to update voice profile:', err);
    }

    await saveState();
    updateUI();
  });

  // Reset voice profile
  elements.resetVoiceBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure? This will delete all your writing samples and voice profile.')) {
      return;
    }

    state.voiceProfile = {
      samples: [],
      summary: null,
      lastUpdated: null
    };

    await saveState();
    updateUI();
    showToast('Voice profile reset', 'success');

    // Notify background worker
    chrome.runtime.sendMessage({ type: 'VOICE_PROFILE_RESET' });
  });

  // Import from Twitter
  elements.importTwitterBtn.addEventListener('click', async () => {
    let handle = elements.twitterHandleInput.value.trim();
    if (!handle) {
      showToast('Enter a Twitter handle', 'error');
      return;
    }

    // Clean up handle
    handle = handle.replace(/^@/, '').replace(/^https?:\/\/(twitter|x)\.com\//, '');

    elements.importTwitterBtn.disabled = true;
    elements.importTwitterBtn.textContent = 'Importing...';

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'IMPORT_TWITTER',
        handle: handle
      });

      if (response.error) {
        showToast(response.error, 'error');
      } else {
        state.voiceProfile = response.voiceProfile;
        await saveState();
        updateUI();
        showToast(`Imported ${response.count} tweets!`, 'success');
        elements.twitterHandleInput.value = '';
      }
    } catch (err) {
      showToast('Import failed. Try again.', 'error');
    }

    elements.importTwitterBtn.disabled = false;
    elements.importTwitterBtn.textContent = 'Import';
  });

  // Import from URL
  elements.importUrlBtn.addEventListener('click', async () => {
    const url = elements.importUrlInput.value.trim();
    if (!url) {
      showToast('Enter a URL', 'error');
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      showToast('Enter a valid URL starting with http:// or https://', 'error');
      return;
    }

    elements.importUrlBtn.disabled = true;
    elements.importUrlBtn.textContent = 'Importing...';

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'IMPORT_URL',
        url: url
      });

      if (response.error) {
        showToast(response.error, 'error');
      } else {
        state.voiceProfile = response.voiceProfile;
        await saveState();
        updateUI();
        showToast('Article imported!', 'success');
        elements.importUrlInput.value = '';
      }
    } catch (err) {
      showToast('Import failed. Try again.', 'error');
    }

    elements.importUrlBtn.disabled = false;
    elements.importUrlBtn.textContent = 'Import';
  });
}

// Coach initialization
function initCoach() {
  elements.coachEnabled.checked = state.coachEnabled;

  elements.coachEnabled.addEventListener('change', async () => {
    state.coachEnabled = elements.coachEnabled.checked;
    await saveState();
    updateUI();

    // Notify content scripts
    chrome.runtime.sendMessage({
      type: 'COACH_TOGGLE',
      enabled: state.coachEnabled
    });
  });
}

// Update UI based on state
function updateUI() {
  // Update status indicator
  const isConfigured = state.settings.apiKey && state.voiceProfile.samples.length > 0;
  const isActive = isConfigured && state.coachEnabled;

  elements.status.classList.toggle('active', isActive);

  if (!state.settings.apiKey) {
    elements.statusText.textContent = 'No API key';
  } else if (state.voiceProfile.samples.length === 0) {
    elements.statusText.textContent = 'No voice profile';
  } else if (!state.coachEnabled) {
    elements.statusText.textContent = 'Paused';
  } else {
    elements.statusText.textContent = 'Active';
  }

  // Update coach stats
  elements.suggestionsCount.textContent = state.stats.suggestionsToday;
  elements.acceptedCount.textContent = state.stats.acceptedToday;

  if (state.stats.suggestionsToday > 0) {
    const score = Math.round((1 - (state.stats.suggestionsToday / 100)) * 100);
    elements.voiceScore.textContent = Math.max(0, Math.min(100, score)) + '%';
  } else {
    elements.voiceScore.textContent = '--';
  }

  // Update recent suggestions
  updateRecentSuggestions();

  // Update voice profile UI
  const sampleCount = state.voiceProfile.samples.length;
  elements.sampleCount.textContent = `${sampleCount} sample${sampleCount !== 1 ? 's' : ''}`;

  if (sampleCount > 0) {
    elements.voiceStatus.textContent = 'Trained';
    elements.voiceStatus.classList.add('trained');
  } else {
    elements.voiceStatus.textContent = 'Not trained';
    elements.voiceStatus.classList.remove('trained');
  }

  // Update voice patterns display
  updateVoicePatterns();

  // Update learned exceptions display
  updateLearnedExceptions();
}

// Update recent suggestions display
function updateRecentSuggestions() {
  const container = elements.recentSuggestions;

  if (state.recentSuggestions.length === 0) {
    container.innerHTML = `
      <h3>Recent Suggestions</h3>
      <div class="empty-state">
        <p>No suggestions yet. Start writing in Google Docs and I'll help you stay on-voice.</p>
      </div>
    `;
    return;
  }

  const suggestionsHtml = state.recentSuggestions.slice(0, 3).map(s => `
    <div class="suggestion-card">
      <div class="suggestion-original">${escapeHtml(s.original)}</div>
      <div class="suggestion-text">${escapeHtml(s.suggestion)}</div>
      <div class="suggestion-reason">${escapeHtml(s.reason)}</div>
    </div>
  `).join('');

  container.innerHTML = `
    <h3>Recent Suggestions</h3>
    ${suggestionsHtml}
  `;
}

// Update voice patterns display
function updateVoicePatterns() {
  const container = elements.voicePatterns;

  if (!state.voiceProfile.summary) {
    container.innerHTML = `
      <h3>Detected Patterns</h3>
      <div class="empty-state">
        <p>Add writing samples to see your detected voice patterns.</p>
      </div>
    `;
    return;
  }

  // Parse summary into display items
  const patterns = state.voiceProfile.summary.split('.').filter(p => p.trim());

  const patternsHtml = patterns.slice(0, 5).map(pattern => `
    <div class="pattern-item">
      <span class="pattern-icon">✓</span>
      <span>${escapeHtml(pattern.trim())}</span>
    </div>
  `).join('');

  container.innerHTML = `
    <h3>Detected Patterns</h3>
    <div class="pattern-list">
      ${patternsHtml}
    </div>
  `;
}

// Update learned exceptions display
function updateLearnedExceptions() {
  const container = elements.learnedExceptions;
  if (!container) return;

  if (state.learnedExceptions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No exceptions yet. When you reject a suggestion, Perkins learns it's intentional.</p>
      </div>
    `;
    return;
  }

  const exceptionsHtml = state.learnedExceptions.slice(0, 10).map((exc, i) => `
    <div class="exception-item">
      <span class="exception-text">"${escapeHtml(exc.pattern)}"</span>
      <button class="exception-remove" data-index="${i}" title="Remove exception">&times;</button>
    </div>
  `).join('');

  container.innerHTML = exceptionsHtml;

  // Bind remove buttons
  container.querySelectorAll('.exception-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.dataset.index);
      state.learnedExceptions.splice(index, 1);
      await saveState();
      updateLearnedExceptions();
      showToast('Exception removed', 'success');

      // Notify background worker
      chrome.runtime.sendMessage({
        type: 'EXCEPTIONS_UPDATED',
        learnedExceptions: state.learnedExceptions
      });
    });
  });
}

// Toast notification
function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // Remove after delay
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Escape HTML for safe rendering
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Listen for messages from background/content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'NEW_SUGGESTION':
      state.recentSuggestions.unshift(message.suggestion);
      state.recentSuggestions = state.recentSuggestions.slice(0, 10);
      state.stats.suggestionsToday++;
      state.stats.totalSuggestions++;
      saveState();
      updateUI();
      break;

    case 'SUGGESTION_ACCEPTED':
      state.stats.acceptedToday++;
      state.stats.totalAccepted++;
      saveState();
      updateUI();
      break;

    case 'SUGGESTION_REJECTED':
      // Add to learned exceptions when user rejects a suggestion
      if (message.suggestion && message.suggestion.original) {
        const pattern = message.suggestion.original.trim();
        // Avoid duplicates
        if (!state.learnedExceptions.some(e => e.pattern === pattern)) {
          state.learnedExceptions.push({
            pattern: pattern,
            reason: message.suggestion.reason || 'User marked as intentional',
            addedAt: new Date().toISOString()
          });
          // Keep only last 50 exceptions
          state.learnedExceptions = state.learnedExceptions.slice(-50);
          saveState();
          updateLearnedExceptions();
        }
      }
      break;

    case 'STATS_UPDATE':
      if (message.stats) {
        state.stats = { ...state.stats, ...message.stats };
        updateUI();
      }
      break;
  }
});
