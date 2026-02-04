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
        <button class="perkins-btn perkins-btn-review" title="Open side-by-side document review">
          <span class="perkins-review-icon">📖</span>
          Review Document
        </button>
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
    panel.querySelector('.perkins-btn-review').addEventListener('click', openReviewModal);
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

  // Side-by-side review modal
  let reviewModal = null;
  let reviewSuggestions = [];
  let acceptedSuggestions = new Set();
  let rejectedSuggestions = new Set();

  function createReviewModal() {
    if (reviewModal) return;

    reviewModal = document.createElement('div');
    reviewModal.id = 'perkins-review-modal';
    reviewModal.innerHTML = `
      <div class="perkins-review-overlay"></div>
      <div class="perkins-review-container">
        <div class="perkins-review-header">
          <div class="perkins-review-title">
            <span class="perkins-logo-icon">P</span>
            <span>Document Review</span>
          </div>
          <div class="perkins-review-actions">
            <button class="perkins-btn perkins-btn-copy-final">Copy Final Version</button>
            <button class="perkins-btn-close-review" title="Close">×</button>
          </div>
        </div>
        <div class="perkins-review-summary"></div>
        <div class="perkins-review-body">
          <div class="perkins-review-panel perkins-review-original">
            <div class="perkins-review-panel-header">Original</div>
            <div class="perkins-review-panel-content"></div>
          </div>
          <div class="perkins-review-panel perkins-review-modified">
            <div class="perkins-review-panel-header">Modified</div>
            <div class="perkins-review-panel-content"></div>
          </div>
        </div>
        <div class="perkins-review-footer">
          <div class="perkins-review-stats">
            <span class="perkins-stat-accepted">0 accepted</span>
            <span class="perkins-stat-rejected">0 rejected</span>
            <span class="perkins-stat-pending">0 pending</span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(reviewModal);

    // Event listeners
    reviewModal.querySelector('.perkins-review-overlay').addEventListener('click', closeReviewModal);
    reviewModal.querySelector('.perkins-btn-close-review').addEventListener('click', closeReviewModal);
    reviewModal.querySelector('.perkins-btn-copy-final').addEventListener('click', copyFinalVersion);
  }

  async function openReviewModal() {
    createReviewModal();

    const text = extractDocumentText();
    if (!text || text.length < 50) {
      showTemporaryMessage('Document is too short to review.');
      return;
    }

    // Show modal with loading state
    reviewModal.classList.add('perkins-review-visible');
    reviewModal.querySelector('.perkins-review-summary').innerHTML = `
      <div class="perkins-review-loading">
        <span class="perkins-loading-icon">🔍</span>
        Analyzing your document...
      </div>
    `;
    reviewModal.querySelector('.perkins-review-original .perkins-review-panel-content').textContent = text;
    reviewModal.querySelector('.perkins-review-modified .perkins-review-panel-content').textContent = text;

    // Reset state
    reviewSuggestions = [];
    acceptedSuggestions.clear();
    rejectedSuggestions.clear();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REVIEW_DOCUMENT',
        text: text
      });

      if (response.error) {
        reviewModal.querySelector('.perkins-review-summary').innerHTML = `
          <div class="perkins-review-error">${escapeHtml(response.error)}</div>
        `;
        return;
      }

      reviewSuggestions = response.suggestions || [];
      const summary = response.summary || '';

      if (reviewSuggestions.length === 0) {
        reviewModal.querySelector('.perkins-review-summary').innerHTML = `
          <div class="perkins-review-success">
            <span>✨</span> ${escapeHtml(summary || 'Your document looks great! It matches your voice well.')}
          </div>
        `;
      } else {
        reviewModal.querySelector('.perkins-review-summary').innerHTML = `
          <div class="perkins-review-info">
            <span>📝</span> ${reviewSuggestions.length} suggestion${reviewSuggestions.length !== 1 ? 's' : ''} found.
            ${escapeHtml(summary)}
          </div>
        `;
      }

      renderReviewPanels(text);
      updateReviewStats();

    } catch (err) {
      console.error('Review failed:', err);
      reviewModal.querySelector('.perkins-review-summary').innerHTML = `
        <div class="perkins-review-error">Review failed. Please try again.</div>
      `;
    }
  }

  function renderReviewPanels(originalText) {
    const originalPanel = reviewModal.querySelector('.perkins-review-original .perkins-review-panel-content');
    const modifiedPanel = reviewModal.querySelector('.perkins-review-modified .perkins-review-panel-content');

    // Build original panel with strikethrough highlights
    let originalHtml = escapeHtml(originalText);
    let modifiedText = originalText;

    // Sort suggestions by position (reverse order to preserve indices)
    const sortedSuggestions = reviewSuggestions
      .map((s, i) => ({ ...s, index: i }))
      .sort((a, b) => {
        const posA = originalText.indexOf(a.original);
        const posB = originalText.indexOf(b.original);
        return posB - posA; // Reverse order
      });

    // Apply changes to modified text (from end to start to preserve positions)
    for (const s of sortedSuggestions) {
      if (acceptedSuggestions.has(s.index)) {
        modifiedText = modifiedText.replace(s.original, s.suggestion);
      }
    }

    // Build HTML for original panel
    originalHtml = escapeHtml(originalText);
    for (const s of reviewSuggestions) {
      const isAccepted = acceptedSuggestions.has(s.index);
      const isRejected = rejectedSuggestions.has(s.index);
      const escapedOriginal = escapeHtml(s.original);
      const statusClass = isAccepted ? 'accepted' : isRejected ? 'rejected' : 'pending';

      // Replace in original with strikethrough marker
      const marker = `<span class="perkins-diff-delete perkins-diff-${statusClass}" data-index="${s.index}" title="${escapeHtml(s.reason)}">${escapedOriginal}</span>`;
      originalHtml = originalHtml.replace(escapedOriginal, marker);
    }

    // Build HTML for modified panel
    let modifiedHtml = escapeHtml(originalText);
    for (const s of reviewSuggestions) {
      const isAccepted = acceptedSuggestions.has(s.index);
      const isRejected = rejectedSuggestions.has(s.index);
      const isPending = !isAccepted && !isRejected;
      const escapedOriginal = escapeHtml(s.original);
      const escapedSuggestion = escapeHtml(s.suggestion);

      let replacement;
      if (isAccepted) {
        replacement = `<span class="perkins-diff-add perkins-diff-accepted" data-index="${s.index}">${escapedSuggestion}</span>`;
      } else if (isRejected) {
        replacement = `<span class="perkins-diff-unchanged" data-index="${s.index}">${escapedOriginal}</span>`;
      } else {
        // Pending: show suggestion with accept/reject buttons
        replacement = `<span class="perkins-diff-suggestion" data-index="${s.index}">
          <span class="perkins-diff-text">${escapedSuggestion}</span>
          <span class="perkins-diff-actions">
            <button class="perkins-diff-accept" data-index="${s.index}" title="Accept">✓</button>
            <button class="perkins-diff-reject" data-index="${s.index}" title="Reject">✗</button>
          </span>
          <span class="perkins-diff-reason">${escapeHtml(s.reason)}</span>
        </span>`;
      }

      modifiedHtml = modifiedHtml.replace(escapedOriginal, replacement);
    }

    originalPanel.innerHTML = originalHtml;
    modifiedPanel.innerHTML = modifiedHtml;

    // Bind accept/reject buttons
    modifiedPanel.querySelectorAll('.perkins-diff-accept').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        acceptSuggestion(idx);
      });
    });

    modifiedPanel.querySelectorAll('.perkins-diff-reject').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        rejectSuggestion(idx);
      });
    });

    // Sync scroll between panels
    originalPanel.addEventListener('scroll', () => {
      modifiedPanel.scrollTop = originalPanel.scrollTop;
    });
    modifiedPanel.addEventListener('scroll', () => {
      originalPanel.scrollTop = modifiedPanel.scrollTop;
    });
  }

  function acceptSuggestion(index) {
    acceptedSuggestions.add(index);
    rejectedSuggestions.delete(index);

    // Send feedback
    const suggestion = reviewSuggestions[index];
    if (suggestion) {
      chrome.runtime.sendMessage({
        type: 'SUGGESTION_FEEDBACK',
        suggestion,
        accepted: true
      });
    }

    renderReviewPanels(extractDocumentText());
    updateReviewStats();
  }

  function rejectSuggestion(index) {
    rejectedSuggestions.add(index);
    acceptedSuggestions.delete(index);

    // Send feedback
    const suggestion = reviewSuggestions[index];
    if (suggestion) {
      chrome.runtime.sendMessage({
        type: 'SUGGESTION_FEEDBACK',
        suggestion,
        accepted: false
      });
    }

    renderReviewPanels(extractDocumentText());
    updateReviewStats();
  }

  function updateReviewStats() {
    const accepted = acceptedSuggestions.size;
    const rejected = rejectedSuggestions.size;
    const pending = reviewSuggestions.length - accepted - rejected;

    reviewModal.querySelector('.perkins-stat-accepted').textContent = `${accepted} accepted`;
    reviewModal.querySelector('.perkins-stat-rejected').textContent = `${rejected} rejected`;
    reviewModal.querySelector('.perkins-stat-pending').textContent = `${pending} pending`;
  }

  function copyFinalVersion() {
    let finalText = extractDocumentText();

    // Apply accepted changes (sort by position, reverse order)
    const sortedAccepted = reviewSuggestions
      .filter((s, i) => acceptedSuggestions.has(i))
      .sort((a, b) => {
        const posA = finalText.indexOf(a.original);
        const posB = finalText.indexOf(b.original);
        return posB - posA;
      });

    for (const s of sortedAccepted) {
      finalText = finalText.replace(s.original, s.suggestion);
    }

    navigator.clipboard.writeText(finalText).then(() => {
      showTemporaryMessage('Final version copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy:', err);
      showTemporaryMessage('Failed to copy. Try again.');
    });
  }

  function closeReviewModal() {
    if (reviewModal) {
      reviewModal.classList.remove('perkins-review-visible');
    }
  }

})();
