/**
 * Perkins Content Script for Google Docs
 * Monitors text changes and displays coaching suggestions
 */

(function() {
  'use strict';

  // State
  let isEnabled = false;
  let isInitialized = false;
  let lastAnalyzedText = '';
  let analyzeTimeout = null;
  let currentSuggestions = [];
  let panel = null;

  // Configuration
  const DEBOUNCE_MS = 3000; // Wait 3 seconds after typing stops
  const MIN_TEXT_LENGTH = 50; // Minimum text to analyze
  const ANALYZE_COOLDOWN_MS = 10000; // Minimum time between analyses

  let lastAnalyzeTime = 0;

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    if (isInitialized) return;
    isInitialized = true;

    console.log('Perkins: Initializing on Google Docs');

    // Get initial state from background
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, response => {
      if (response) {
        isEnabled = response.coachEnabled;
        if (isEnabled) {
          startMonitoring();
        }
      }
    });

    // Listen for messages from background/popup
    chrome.runtime.onMessage.addListener(handleMessage);

    // Create coaching panel
    createCoachingPanel();
  }

  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'COACH_STATUS':
        isEnabled = message.enabled;
        if (isEnabled) {
          startMonitoring();
          showPanel();
        } else {
          stopMonitoring();
          hidePanel();
        }
        break;

      case 'ANALYZE_RESULT':
        handleAnalysisResult(message.result);
        break;
    }
  }

  // Text extraction from Google Docs
  function extractDocumentText() {
    // Google Docs uses .kix-lineview for each line
    const lines = document.querySelectorAll('.kix-lineview');
    const textParts = [];

    lines.forEach(line => {
      // Get text content from each line
      const spans = line.querySelectorAll('.kix-wordhtmlgenerator-word-node');
      let lineText = '';

      spans.forEach(span => {
        lineText += span.textContent;
      });

      if (lineText.trim()) {
        textParts.push(lineText);
      }
    });

    return textParts.join('\n');
  }

  // Get the current paragraph (where cursor is)
  function getCurrentParagraph() {
    // Try to find the cursor position
    const cursor = document.querySelector('.kix-cursor');
    if (!cursor) {
      return extractDocumentText(); // Fallback to full document
    }

    // Find the line containing the cursor
    const cursorLine = cursor.closest('.kix-lineview');
    if (!cursorLine) {
      return extractDocumentText();
    }

    // Get surrounding lines (current paragraph context)
    const allLines = Array.from(document.querySelectorAll('.kix-lineview'));
    const cursorIndex = allLines.indexOf(cursorLine);

    if (cursorIndex === -1) {
      return extractDocumentText();
    }

    // Get ~5 lines around cursor for context
    const startIndex = Math.max(0, cursorIndex - 2);
    const endIndex = Math.min(allLines.length, cursorIndex + 3);

    const contextLines = allLines.slice(startIndex, endIndex);
    const textParts = [];

    contextLines.forEach(line => {
      const spans = line.querySelectorAll('.kix-wordhtmlgenerator-word-node');
      let lineText = '';
      spans.forEach(span => {
        lineText += span.textContent;
      });
      if (lineText.trim()) {
        textParts.push(lineText);
      }
    });

    return textParts.join(' ');
  }

  // Monitor for text changes
  let observer = null;

  function startMonitoring() {
    if (observer) return;

    console.log('Perkins: Starting text monitoring');

    // Find the editor container
    const editorContainer = document.querySelector('.kix-appview-editor');
    if (!editorContainer) {
      console.warn('Perkins: Could not find Google Docs editor');
      // Retry after a delay (docs might still be loading)
      setTimeout(startMonitoring, 2000);
      return;
    }

    // Watch for DOM changes in the editor
    observer = new MutationObserver(handleMutations);
    observer.observe(editorContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Also watch for keyboard input as a backup
    document.addEventListener('keyup', handleKeyup);

    showPanel();
  }

  function stopMonitoring() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    document.removeEventListener('keyup', handleKeyup);

    if (analyzeTimeout) {
      clearTimeout(analyzeTimeout);
      analyzeTimeout = null;
    }
  }

  function handleMutations(mutations) {
    // Debounce analysis
    scheduleAnalysis();
  }

  function handleKeyup(event) {
    // Only trigger on actual text input
    if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter') {
      scheduleAnalysis();
    }
  }

  function scheduleAnalysis() {
    if (!isEnabled) return;

    // Clear existing timeout
    if (analyzeTimeout) {
      clearTimeout(analyzeTimeout);
    }

    // Schedule new analysis
    analyzeTimeout = setTimeout(performAnalysis, DEBOUNCE_MS);
  }

  async function performAnalysis() {
    if (!isEnabled) return;

    // Check cooldown
    const now = Date.now();
    if (now - lastAnalyzeTime < ANALYZE_COOLDOWN_MS) {
      return;
    }

    // Get current text
    const text = getCurrentParagraph();

    // Skip if text is too short
    if (text.length < MIN_TEXT_LENGTH) {
      return;
    }

    // Skip if text hasn't changed
    if (text === lastAnalyzedText) {
      return;
    }

    lastAnalyzedText = text;
    lastAnalyzeTime = now;

    console.log('Perkins: Analyzing text...', text.substring(0, 50) + '...');

    // Show loading state
    showPanelLoading();

    try {
      // Send to background for analysis
      const response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_TEXT',
        text: text
      });

      handleAnalysisResult(response);
    } catch (err) {
      console.error('Perkins: Analysis failed', err);
      showPanelError('Analysis failed. Check your API key.');
    }
  }

  function handleAnalysisResult(result) {
    if (!result) return;

    if (result.error) {
      showPanelError(result.error);
      return;
    }

    currentSuggestions = result.suggestions || [];
    updatePanel();
  }

  // Coaching Panel UI
  function createCoachingPanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'perkins-panel';
    panel.innerHTML = `
      <div class="perkins-panel-header">
        <div class="perkins-logo">
          <span class="perkins-logo-icon">P</span>
          <span class="perkins-logo-text">Perkins</span>
        </div>
        <div class="perkins-panel-actions">
          <button class="perkins-btn-minimize" title="Minimize">−</button>
          <button class="perkins-btn-close" title="Disable coach">×</button>
        </div>
      </div>
      <div class="perkins-panel-content">
        <div class="perkins-panel-status">
          <span class="perkins-status-icon">👀</span>
          <span class="perkins-status-text">Watching your writing...</span>
        </div>
      </div>
      <div class="perkins-panel-footer">
        <button class="perkins-btn perkins-btn-learn" title="Add this document to your voice profile">
          <span class="perkins-learn-icon">📝</span>
          Learn from this doc
        </button>
      </div>
    `;

    document.body.appendChild(panel);

    // Event listeners
    panel.querySelector('.perkins-btn-minimize').addEventListener('click', toggleMinimize);
    panel.querySelector('.perkins-btn-close').addEventListener('click', disableCoach);
    panel.querySelector('.perkins-btn-learn').addEventListener('click', learnFromDocument);

    // Initially hidden
    panel.classList.add('perkins-hidden');
  }

  async function learnFromDocument() {
    const text = extractDocumentText();

    if (!text || text.length < 100) {
      showTemporaryMessage('Document is too short to learn from.');
      return;
    }

    // Show loading state on button
    const btn = panel.querySelector('.perkins-btn-learn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="perkins-learn-icon">⏳</span> Learning...';
    btn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'LEARN_FROM_DOCUMENT',
        text: text,
        source: 'google-docs',
        title: document.title || 'Google Doc'
      });

      if (response.error) {
        showTemporaryMessage(response.error);
      } else {
        showTemporaryMessage('Added to your voice profile!');
      }
    } catch (err) {
      console.error('Perkins: Failed to learn from document', err);
      showTemporaryMessage('Failed to learn. Try again.');
    }

    // Restore button
    btn.innerHTML = originalText;
    btn.disabled = false;
  }

  function showPanel() {
    if (panel) {
      panel.classList.remove('perkins-hidden');
    }
  }

  function hidePanel() {
    if (panel) {
      panel.classList.add('perkins-hidden');
    }
  }

  function toggleMinimize() {
    if (panel) {
      panel.classList.toggle('perkins-minimized');
    }
  }

  function disableCoach() {
    isEnabled = false;
    chrome.runtime.sendMessage({ type: 'COACH_TOGGLE', enabled: false });
    hidePanel();
  }

  function showPanelLoading() {
    const content = panel?.querySelector('.perkins-panel-content');
    if (content) {
      content.innerHTML = `
        <div class="perkins-panel-status perkins-loading">
          <span class="perkins-status-icon">🔍</span>
          <span class="perkins-status-text">Analyzing your writing...</span>
        </div>
      `;
    }
  }

  function showPanelError(message) {
    const content = panel?.querySelector('.perkins-panel-content');
    if (content) {
      content.innerHTML = `
        <div class="perkins-panel-status perkins-error">
          <span class="perkins-status-icon">⚠️</span>
          <span class="perkins-status-text">${escapeHtml(message)}</span>
        </div>
      `;
    }
  }

  function updatePanel() {
    const content = panel?.querySelector('.perkins-panel-content');
    if (!content) return;

    if (currentSuggestions.length === 0) {
      content.innerHTML = `
        <div class="perkins-panel-status perkins-success">
          <span class="perkins-status-icon">✨</span>
          <span class="perkins-status-text">Looking good! Your writing matches your voice.</span>
        </div>
      `;
      return;
    }

    const suggestionsHtml = currentSuggestions.map((s, i) => `
      <div class="perkins-suggestion" data-index="${i}">
        <div class="perkins-suggestion-original">${escapeHtml(s.original)}</div>
        <div class="perkins-suggestion-arrow">↓</div>
        <div class="perkins-suggestion-text">${escapeHtml(s.suggestion)}</div>
        <div class="perkins-suggestion-reason">${escapeHtml(s.reason)}</div>
        <div class="perkins-suggestion-actions">
          <button class="perkins-btn perkins-btn-accept" data-index="${i}">Accept</button>
          <button class="perkins-btn perkins-btn-reject" data-index="${i}">Not helpful</button>
        </div>
      </div>
    `).join('');

    content.innerHTML = `
      <div class="perkins-suggestions-header">
        <span>${currentSuggestions.length} suggestion${currentSuggestions.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="perkins-suggestions-list">
        ${suggestionsHtml}
      </div>
    `;

    // Bind action buttons
    content.querySelectorAll('.perkins-btn-accept').forEach(btn => {
      btn.addEventListener('click', () => handleAccept(parseInt(btn.dataset.index)));
    });

    content.querySelectorAll('.perkins-btn-reject').forEach(btn => {
      btn.addEventListener('click', () => handleReject(parseInt(btn.dataset.index)));
    });
  }

  function handleAccept(index) {
    const suggestion = currentSuggestions[index];
    if (!suggestion) return;

    // Send feedback to background
    chrome.runtime.sendMessage({
      type: 'SUGGESTION_FEEDBACK',
      suggestion,
      accepted: true
    });

    // Remove from list
    currentSuggestions.splice(index, 1);
    updatePanel();

    // Try to apply the suggestion (copy to clipboard as fallback)
    copyToClipboard(suggestion.suggestion);
    showTemporaryMessage('Copied suggestion to clipboard!');
  }

  function handleReject(index) {
    const suggestion = currentSuggestions[index];
    if (!suggestion) return;

    // Send feedback to background
    chrome.runtime.sendMessage({
      type: 'SUGGESTION_FEEDBACK',
      suggestion,
      accepted: false
    });

    // Remove from list
    currentSuggestions.splice(index, 1);
    updatePanel();
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).catch(err => {
      console.error('Perkins: Failed to copy to clipboard', err);
    });
  }

  function showTemporaryMessage(message) {
    const content = panel?.querySelector('.perkins-panel-content');
    if (!content) return;

    const toast = document.createElement('div');
    toast.className = 'perkins-toast';
    toast.textContent = message;
    content.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('perkins-toast-show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('perkins-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

})();
