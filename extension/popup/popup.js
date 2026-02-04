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

  // Badges & Flywheel
  badgesSection: document.getElementById('badges-section'),
  currentMilestone: document.getElementById('current-milestone'),
  milestoneProgress: document.getElementById('milestone-progress'),
  milestoneProgressFill: document.getElementById('milestone-progress-fill'),
  totalWordsCount: document.getElementById('total-words-count'),
  earnedBadges: document.getElementById('earned-badges'),
  flywheelStats: document.getElementById('flywheel-stats'),
  patternsLearnedCount: document.getElementById('patterns-learned-count'),
  documentsAnalyzedCount: document.getElementById('documents-analyzed-count'),
  improvementPercent: document.getElementById('improvement-percent'),

  // Voice tab
  voiceStatus: document.getElementById('voice-status'),
  writingSample: document.getElementById('writing-sample'),
  addSampleBtn: document.getElementById('add-sample'),
  sampleCount: document.getElementById('sample-count'),
  voicePatterns: document.getElementById('voice-patterns'),
  resetVoiceBtn: document.getElementById('reset-voice'),
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
  ambientLearningCheck: document.getElementById('ambient-learning'),
  styleGuideInput: document.getElementById('style-guide'),
  learnedExceptions: document.getElementById('learned-exceptions'),

  // Setup progress
  setupProgress: document.getElementById('setup-progress'),
  setupStepApi: document.getElementById('setup-step-api'),
  setupStepVoice: document.getElementById('setup-step-voice'),
  voiceSetupRequired: document.getElementById('voice-setup-required'),
  voiceSection: document.querySelector('.voice-section'),
  voiceTraining: document.getElementById('voice-training'),
  goToSettingsBtn: document.getElementById('go-to-settings')
};

// Writing milestones (word counts mapped to famous works)
const WRITING_MILESTONES = [
  { words: 272, name: 'Gettysburg Address', icon: '📜', description: 'Lincoln\'s famous speech' },
  { words: 1600, name: 'I Have a Dream', icon: '✊', description: 'MLK\'s iconic speech' },
  { words: 5000, name: 'Short Story', icon: '📖', description: 'A complete short story' },
  { words: 27000, name: 'The Old Man and the Sea', icon: '🎣', description: 'Hemingway\'s novella' },
  { words: 47000, name: 'The Great Gatsby', icon: '🥂', description: 'Fitzgerald\'s masterpiece' },
  { words: 77000, name: 'Harry Potter Book 1', icon: '⚡', description: 'The Sorcerer\'s Stone' },
  { words: 89000, name: '1984', icon: '👁️', description: 'Orwell\'s dystopia' },
  { words: 225000, name: 'East of Eden', icon: '🌾', description: 'Steinbeck\'s epic' },
  { words: 480000, name: 'Lord of the Rings', icon: '💍', description: 'Tolkien\'s trilogy' },
  { words: 580000, name: 'War and Peace', icon: '⚔️', description: 'Tolstoy\'s masterwork' },
  { words: 1084000, name: 'Harry Potter Series', icon: '🏰', description: 'All 7 books' }
];

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
    },
    ambientLearning: false // Opt-in ambient learning
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
  // Writing stats for badges and flywheel
  writingStats: {
    totalWords: 0,
    wordsThisWeek: 0,
    wordsThisMonth: 0,
    weekStartDate: null,
    monthStartDate: null,
    earnedBadges: [], // Array of milestone names earned
    patternsLearned: 0,
    suggestionsReducedPercent: 0,
    firstWeekSuggestions: null, // Track to calculate improvement
    documentsAnalyzed: 0
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
  initSetupFlow();
  updateUI();

  // Default to Settings tab if no API key
  if (!state.settings.apiKey) {
    switchToTab('settings');
  }

  // Check for first-run tutorial
  checkFirstRunTutorial();
});

// Load state from Chrome storage
async function loadState() {
  try {
    const stored = await chrome.storage.local.get([
      'settings',
      'voiceProfile',
      'learnedExceptions',
      'stats',
      'writingStats',
      'coachEnabled',
      'recentSuggestions'
    ]);

    if (stored.settings) {
      state.settings = {
        ...state.settings,
        ...stored.settings,
        // Deep merge checks object to preserve defaults
        checks: { ...state.settings.checks, ...(stored.settings.checks || {}) }
      };
    }
    if (stored.voiceProfile) state.voiceProfile = { ...state.voiceProfile, ...stored.voiceProfile };
    if (stored.learnedExceptions) state.learnedExceptions = stored.learnedExceptions;
    if (stored.stats) state.stats = { ...state.stats, ...stored.stats };
    if (stored.writingStats) state.writingStats = { ...state.writingStats, ...stored.writingStats };
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

    // Reset weekly stats if new week
    const weekStart = getWeekStart();
    if (state.writingStats.weekStartDate !== weekStart) {
      state.writingStats.wordsThisWeek = 0;
      state.writingStats.weekStartDate = weekStart;
      await saveState();
    }

    // Reset monthly stats if new month
    const monthStart = getMonthStart();
    if (state.writingStats.monthStartDate !== monthStart) {
      state.writingStats.wordsThisMonth = 0;
      state.writingStats.monthStartDate = monthStart;
      await saveState();
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

// Get start of current week (Sunday)
function getWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - dayOfWeek);
  return weekStart.toDateString();
}

// Get start of current month
function getMonthStart() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth()}`;
}

// Save state to Chrome storage
async function saveState() {
  try {
    await chrome.storage.local.set({
      settings: state.settings,
      voiceProfile: state.voiceProfile,
      learnedExceptions: state.learnedExceptions,
      stats: state.stats,
      writingStats: state.writingStats,
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
  elements.ambientLearningCheck.checked = state.settings.ambientLearning || false;
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
    state.settings.ambientLearning = elements.ambientLearningCheck.checked;

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

      if (response && response.error) {
        showToast('Error: ' + response.error, 'error');
        console.error('Voice profile error:', response.error);
      } else if (response && response.summary) {
        state.voiceProfile.summary = response.summary;
        state.voiceProfile.lastUpdated = new Date().toISOString();
        showToast('Voice profile updated!', 'success');
      }
    } catch (err) {
      console.error('Failed to update voice profile:', err);
      showToast('Failed to analyze voice. Check console for details.', 'error');
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

// Setup flow initialization
function initSetupFlow() {
  // "Go to Settings" button in Voice tab overlay
  if (elements.goToSettingsBtn) {
    elements.goToSettingsBtn.addEventListener('click', () => {
      switchToTab('settings');
    });
  }

  // Make setup steps clickable
  if (elements.setupStepApi) {
    elements.setupStepApi.addEventListener('click', () => {
      switchToTab('settings');
    });
  }

  if (elements.setupStepVoice) {
    elements.setupStepVoice.addEventListener('click', () => {
      // Only allow clicking if API key is set
      if (state.settings.apiKey) {
        switchToTab('voice');
      } else {
        switchToTab('settings');
        showToast('Add your API key first', 'info');
      }
    });
  }
}

// Switch to a specific tab
function switchToTab(tabName) {
  const targetTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (targetTab) {
    targetTab.click();
  }
}

// Update setup progress bar
function updateSetupProgress() {
  const hasApiKey = !!state.settings.apiKey;
  const hasVoice = state.voiceProfile.samples.length > 0;
  const isFullySetup = hasApiKey && hasVoice;

  // Show/hide progress bar
  if (elements.setupProgress) {
    elements.setupProgress.style.display = isFullySetup ? 'none' : 'flex';
  }

  // Update API step
  if (elements.setupStepApi) {
    elements.setupStepApi.classList.toggle('completed', hasApiKey);
    elements.setupStepApi.classList.toggle('active', !hasApiKey);
  }

  // Update Voice step
  if (elements.setupStepVoice) {
    elements.setupStepVoice.classList.toggle('completed', hasVoice);
    elements.setupStepVoice.classList.toggle('active', hasApiKey && !hasVoice);
    elements.setupStepVoice.classList.toggle('disabled', !hasApiKey);
  }

  // Show/hide setup required overlay in Voice tab
  if (elements.voiceSetupRequired) {
    elements.voiceSetupRequired.style.display = hasApiKey ? 'none' : 'flex';
  }

  // Add/remove needs-setup class on voice section
  if (elements.voiceSection) {
    elements.voiceSection.classList.toggle('needs-setup', !hasApiKey);
  }
}

// Get current milestone and progress
function getCurrentMilestoneInfo() {
  const totalWords = state.writingStats.totalWords;

  // Find current and next milestone
  let currentMilestone = null;
  let nextMilestone = WRITING_MILESTONES[0];

  for (let i = 0; i < WRITING_MILESTONES.length; i++) {
    if (totalWords >= WRITING_MILESTONES[i].words) {
      currentMilestone = WRITING_MILESTONES[i];
      nextMilestone = WRITING_MILESTONES[i + 1] || null;
    } else {
      break;
    }
  }

  // Calculate progress to next milestone
  let progress = 0;
  let wordsToNext = 0;

  if (nextMilestone) {
    const startWords = currentMilestone ? currentMilestone.words : 0;
    const range = nextMilestone.words - startWords;
    const wordsInRange = totalWords - startWords;
    progress = Math.min(100, Math.round((wordsInRange / range) * 100));
    wordsToNext = nextMilestone.words - totalWords;
  } else {
    progress = 100; // All milestones achieved
  }

  return { currentMilestone, nextMilestone, progress, wordsToNext };
}

// Check and award new badges
function checkForNewBadges() {
  const totalWords = state.writingStats.totalWords;
  const earned = state.writingStats.earnedBadges || [];
  let newBadge = null;

  for (const milestone of WRITING_MILESTONES) {
    if (totalWords >= milestone.words && !earned.includes(milestone.name)) {
      earned.push(milestone.name);
      newBadge = milestone;
    }
  }

  state.writingStats.earnedBadges = earned;
  return newBadge;
}

// Update badges and flywheel display
function updateBadgesDisplay() {
  const { currentMilestone, nextMilestone, progress, wordsToNext } = getCurrentMilestoneInfo();
  const totalWords = state.writingStats.totalWords;

  // Update total words count
  if (elements.totalWordsCount) {
    elements.totalWordsCount.textContent = formatNumber(totalWords);
  }

  // Update milestone progress
  if (elements.currentMilestone) {
    if (nextMilestone) {
      elements.currentMilestone.innerHTML = `
        <span class="milestone-icon">${nextMilestone.icon}</span>
        <span class="milestone-text">
          <strong>${formatNumber(wordsToNext)}</strong> words to
          <em>${nextMilestone.name}</em>
        </span>
      `;
    } else {
      elements.currentMilestone.innerHTML = `
        <span class="milestone-icon">🏆</span>
        <span class="milestone-text">
          <strong>All milestones achieved!</strong>
        </span>
      `;
    }
  }

  // Update progress bar
  if (elements.milestoneProgressFill) {
    elements.milestoneProgressFill.style.width = `${progress}%`;
  }

  // Update earned badges
  if (elements.earnedBadges) {
    const earnedMilestones = WRITING_MILESTONES.filter(m =>
      state.writingStats.earnedBadges?.includes(m.name)
    );

    if (earnedMilestones.length === 0) {
      elements.earnedBadges.innerHTML = `
        <div class="no-badges">Start writing to earn your first badge!</div>
      `;
    } else {
      elements.earnedBadges.innerHTML = earnedMilestones.map(m => `
        <div class="badge-item" title="${m.description}">
          <span class="badge-icon">${m.icon}</span>
          <span class="badge-name">${m.name}</span>
        </div>
      `).join('');
    }
  }

  // Update flywheel stats
  if (elements.patternsLearnedCount) {
    elements.patternsLearnedCount.textContent = state.writingStats.patternsLearned || 0;
  }

  if (elements.documentsAnalyzedCount) {
    elements.documentsAnalyzedCount.textContent = state.writingStats.documentsAnalyzed || 0;
  }

  if (elements.improvementPercent) {
    const improvement = state.writingStats.suggestionsReducedPercent || 0;
    elements.improvementPercent.textContent = improvement > 0 ? `-${improvement}%` : '--';
  }
}

// Format large numbers with commas
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Update UI based on state
function updateUI() {
  // Update setup progress
  updateSetupProgress();

  // Update badges display
  updateBadgesDisplay();

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

          // Increment patterns learned
          state.writingStats.patternsLearned++;
          saveState();
          updateBadgesDisplay();
        }
      }
      break;

    case 'STATS_UPDATE':
      if (message.stats) {
        state.stats = { ...state.stats, ...message.stats };
        updateUI();
      }
      break;

    case 'WORDS_ADDED':
      // Track words for badges/milestones
      if (message.wordCount && message.wordCount > 0) {
        state.writingStats.totalWords += message.wordCount;
        state.writingStats.wordsThisWeek += message.wordCount;
        state.writingStats.wordsThisMonth += message.wordCount;

        // Check for new badges
        const newBadge = checkForNewBadges();
        if (newBadge) {
          showToast(`🎖️ Badge earned: ${newBadge.name}!`, 'success');
        }

        saveState();
        updateBadgesDisplay();
      }
      break;

    case 'DOCUMENT_ANALYZED':
      // Track documents analyzed for flywheel
      state.writingStats.documentsAnalyzed++;
      saveState();
      updateBadgesDisplay();
      break;

    case 'PATTERN_LEARNED':
      // Increment patterns learned counter
      state.writingStats.patternsLearned++;
      saveState();
      updateBadgesDisplay();
      break;
  }
});

// ============================================
// Tutorial / Onboarding
// ============================================

async function checkFirstRunTutorial() {
  const { perkinsOnboardingComplete } = await chrome.storage.local.get(['perkinsOnboardingComplete']);

  if (!perkinsOnboardingComplete) {
    showTutorial();
  }
}

function showTutorial() {
  const tutorialSteps = [
    {
      title: 'Welcome to Perkins!',
      content: 'Your personal writing voice coach. Perkins learns how YOU write and helps you stay consistent.',
      icon: '👋',
      highlight: null
    },
    {
      title: 'Step 1: Add Your API Key',
      content: 'First, add your Anthropic or OpenAI API key. Your key is encrypted and stored locally - we never see it.',
      icon: '🔑',
      highlight: 'settings'
    },
    {
      title: 'Step 2: Train Your Voice',
      content: 'Add writing samples so Perkins can learn YOUR voice. Paste text, import from URLs, or let it learn as you write.',
      icon: '✍️',
      highlight: 'voice'
    },
    {
      title: 'Step 3: Start Coaching',
      content: 'Toggle on the coach and write in Google Docs or Gmail. Perkins will watch for moments that don\'t sound like you.',
      icon: '👀',
      highlight: 'coach'
    },
    {
      title: 'Pro Features',
      content: '<strong>Chat</strong> - Discuss your writing with Perkins<br><strong>Write Like Me</strong> - Generate content in your voice<br><strong>Review</strong> - Full document analysis',
      icon: '✨',
      highlight: null
    },
    {
      title: 'You\'re Ready!',
      content: 'Perkins gets smarter the more you use it. Your voice profile improves with every document you analyze.',
      icon: '🚀',
      highlight: null
    }
  ];

  let currentStep = 0;

  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';
  overlay.innerHTML = `
    <div class="tutorial-modal">
      <div class="tutorial-header">
        <div class="tutorial-progress">
          ${tutorialSteps.map((_, i) => `<div class="tutorial-dot ${i === 0 ? 'active' : ''}"></div>`).join('')}
        </div>
        <button class="tutorial-skip">Skip</button>
      </div>
      <div class="tutorial-content">
        <div class="tutorial-icon">${tutorialSteps[0].icon}</div>
        <h3 class="tutorial-title">${tutorialSteps[0].title}</h3>
        <p class="tutorial-text">${tutorialSteps[0].content}</p>
      </div>
      <div class="tutorial-footer">
        <button class="tutorial-prev" disabled>← Back</button>
        <button class="tutorial-next">Next →</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const modal = overlay.querySelector('.tutorial-modal');
  const icon = overlay.querySelector('.tutorial-icon');
  const title = overlay.querySelector('.tutorial-title');
  const text = overlay.querySelector('.tutorial-text');
  const dots = overlay.querySelectorAll('.tutorial-dot');
  const prevBtn = overlay.querySelector('.tutorial-prev');
  const nextBtn = overlay.querySelector('.tutorial-next');
  const skipBtn = overlay.querySelector('.tutorial-skip');

  function updateStep() {
    const step = tutorialSteps[currentStep];
    icon.textContent = step.icon;
    title.textContent = step.title;
    text.innerHTML = step.content;

    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === currentStep);
    });

    prevBtn.disabled = currentStep === 0;
    nextBtn.textContent = currentStep === tutorialSteps.length - 1 ? 'Get Started' : 'Next →';

    // Highlight relevant tab
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('tutorial-highlight'));
    if (step.highlight) {
      const tabToHighlight = document.querySelector(`.tab[data-tab="${step.highlight}"]`);
      if (tabToHighlight) {
        tabToHighlight.classList.add('tutorial-highlight');
      }
    }
  }

  function closeTutorial() {
    overlay.classList.add('tutorial-closing');
    setTimeout(() => overlay.remove(), 300);
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('tutorial-highlight'));
    chrome.storage.local.set({ perkinsOnboardingComplete: true });
  }

  prevBtn.addEventListener('click', () => {
    if (currentStep > 0) {
      currentStep--;
      updateStep();
    }
  });

  nextBtn.addEventListener('click', () => {
    if (currentStep < tutorialSteps.length - 1) {
      currentStep++;
      updateStep();
    } else {
      closeTutorial();
    }
  });

  skipBtn.addEventListener('click', closeTutorial);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeTutorial();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      closeTutorial();
      document.removeEventListener('keydown', escHandler);
    }
  });
}
