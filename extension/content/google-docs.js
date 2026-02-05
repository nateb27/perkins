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
  let currentDetections = null;
  let panel = null;

  // Ambient learning state
  let ambientLearningEnabled = false;
  let typedCharCount = 0;
  let lastAmbientLearnTime = 0;
  let isTyping = false;
  let lastKeyTime = 0;

  // Configuration
  const DEBOUNCE_MS = 1500; // Wait 1.5 seconds after typing stops
  const MIN_TEXT_LENGTH = 50; // Minimum text to analyze
  const ANALYZE_COOLDOWN_MS = 5000; // Minimum time between analyses
  const AMBIENT_LEARN_INTERVAL_MS = 300000; // Learn every 5 minutes of active typing
  const AMBIENT_MIN_CHARS = 500; // Minimum chars typed before learning
  const TYPING_TIMEOUT_MS = 2000; // Consider typing stopped after 2s

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
        ambientLearningEnabled = response.settings?.ambientLearning || false;
        if (isEnabled) {
          startMonitoring();
        }
      }
    });

    // Listen for messages from background/popup
    chrome.runtime.onMessage.addListener(handleMessage);

    // Keyboard shortcut: Cmd/Ctrl+Shift+P to toggle panel
    document.addEventListener('keydown', handleKeyboardShortcut);

    // Create coaching panel
    createCoachingPanel();
  }

  // Handle keyboard shortcuts
  function handleKeyboardShortcut(e) {
    // Cmd/Ctrl + Shift + P to toggle panel
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    }
  }

  // Toggle panel visibility
  function togglePanel() {
    if (!panel) return;

    if (panel.classList.contains('perkins-hidden')) {
      showPanel();
      if (!isEnabled) {
        // Enable coaching when opening panel
        isEnabled = true;
        startMonitoring();
        chrome.runtime.sendMessage({ type: 'COACH_TOGGLE', enabled: true });
      }
    } else {
      hidePanel();
    }
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

      case 'SETTINGS_UPDATED':
        // Update ambient learning setting
        if (message.settings) {
          ambientLearningEnabled = message.settings.ambientLearning || false;
        }
        break;
    }
  }

  // Text extraction from Google Docs
  function extractDocumentText() {
    // Target ONLY the document pages/canvas, not sidebars or UI elements
    // The actual document content is inside .kix-page elements

    // Method 1: Get text from document pages only (most reliable)
    const pages = document.querySelectorAll('.kix-page');
    if (pages.length > 0) {
      const textParts = [];
      pages.forEach(page => {
        const lines = page.querySelectorAll('.kix-lineview');
        lines.forEach(line => {
          const spans = line.querySelectorAll('.kix-wordhtmlgenerator-word-node');
          let lineText = '';
          spans.forEach(span => {
            lineText += span.textContent;
          });
          if (lineText.trim()) {
            textParts.push(lineText);
          }
        });
      });
      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }

    // Method 2: Try .kix-paragraphrenderer inside pages only
    const pageContainer = document.querySelector('.kix-paginateddocumentplugin');
    if (pageContainer) {
      const paragraphs = pageContainer.querySelectorAll('.kix-paragraphrenderer');
      if (paragraphs.length > 0) {
        const paragraphTexts = [];
        paragraphs.forEach(p => {
          // Skip if parent is a sidebar or panel
          if (p.closest('.docs-side-panel') || p.closest('.companion-panel')) return;
          const text = p.textContent?.trim();
          if (text) paragraphTexts.push(text);
        });
        if (paragraphTexts.length > 0) {
          return paragraphTexts.join('\n');
        }
      }
    }

    // Method 3: Fallback - try the canvas area only
    const canvas = document.querySelector('.kix-appview-editor .kix-rotatingtilemanager');
    if (canvas) {
      const text = canvas.textContent?.trim();
      if (text) return text;
    }

    console.log('Perkins: Could not extract document text');
    return '';
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

      // Track typing for ambient learning
      if (ambientLearningEnabled && event.key.length === 1) {
        trackTypingForAmbientLearning(event.key);
      }
    }
  }

  // Track typing for ambient learning
  function trackTypingForAmbientLearning(key) {
    const now = Date.now();

    // Reset if it's been too long since last keystroke (likely copy-paste in between)
    if (now - lastKeyTime > TYPING_TIMEOUT_MS && typedCharCount > 0) {
      // Check if we should learn before resetting
      maybePerformAmbientLearn();
    }

    lastKeyTime = now;
    typedCharCount++;
    isTyping = true;

    // Set a timeout to detect when typing stops
    setTimeout(() => {
      if (Date.now() - lastKeyTime >= TYPING_TIMEOUT_MS) {
        isTyping = false;
        maybePerformAmbientLearn();
      }
    }, TYPING_TIMEOUT_MS);
  }

  // Check if we should perform ambient learning
  function maybePerformAmbientLearn() {
    const now = Date.now();

    // Check conditions: enough chars typed, enough time passed
    if (typedCharCount < AMBIENT_MIN_CHARS) {
      return;
    }

    if (now - lastAmbientLearnTime < AMBIENT_LEARN_INTERVAL_MS) {
      return;
    }

    // Get current document text
    const text = extractDocumentText();
    if (!text || text.length < 200) {
      return;
    }

    console.log('Perkins: Performing ambient learning...', typedCharCount, 'chars typed');

    // Send for learning
    chrome.runtime.sendMessage({
      type: 'AMBIENT_LEARN',
      text: text,
      typedCharCount: typedCharCount
    }).then(response => {
      if (response && response.success) {
        showTemporaryMessage('Voice profile updated from your writing!');
      }
    }).catch(err => {
      console.error('Perkins: Ambient learning failed', err);
    });

    // Reset counters
    lastAmbientLearnTime = now;
    typedCharCount = 0;
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

    // SECURITY: Don't log document text to console
    console.log('Perkins: Analyzing text...');

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
    currentDetections = result.detections || null;
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
        <button class="perkins-btn perkins-btn-chat" title="Chat about your writing">
          <span class="perkins-chat-icon">💬</span>
          Chat
        </button>
        <button class="perkins-btn perkins-btn-write" title="Write in your voice">
          <span class="perkins-write-icon">✍️</span>
          Write for me
        </button>
        <button class="perkins-btn perkins-btn-learn" title="Add this document to your voice profile">
          <span class="perkins-learn-icon">📝</span>
          Learn
        </button>
      </div>
    `;

    document.body.appendChild(panel);

    // Create keyboard shortcut hint
    createShortcutHint();

    // Event listeners
    panel.querySelector('.perkins-btn-minimize').addEventListener('click', toggleMinimize);
    panel.querySelector('.perkins-btn-close').addEventListener('click', disableCoach);
    panel.querySelector('.perkins-btn-review').addEventListener('click', openReviewModal);
    panel.querySelector('.perkins-btn-chat').addEventListener('click', openChatModal);
    panel.querySelector('.perkins-btn-write').addEventListener('click', openWriteModal);
    panel.querySelector('.perkins-btn-learn').addEventListener('click', learnFromDocument);

    // Make panel draggable by header
    initDraggable(panel);

    // Initially hidden
    panel.classList.add('perkins-hidden');
  }

  // Make the panel draggable
  function initDraggable(panel) {
    const header = panel.querySelector('.perkins-panel-header');
    let isDragging = false;
    let startX, startY, startRight, startBottom;

    header.addEventListener('mousedown', (e) => {
      // Don't drag if clicking buttons
      if (e.target.closest('button')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      // Get current position (panel uses right/bottom positioning)
      const style = window.getComputedStyle(panel);
      startRight = parseInt(style.right) || 20;
      startBottom = parseInt(style.bottom) || 20;

      header.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = startX - e.clientX;
      const deltaY = startY - e.clientY;

      // Calculate new position
      let newRight = startRight + deltaX;
      let newBottom = startBottom + deltaY;

      // Keep panel on screen
      const panelRect = panel.getBoundingClientRect();
      const maxRight = window.innerWidth - panelRect.width - 10;
      const maxBottom = window.innerHeight - panelRect.height - 10;

      newRight = Math.max(10, Math.min(newRight, maxRight));
      newBottom = Math.max(10, Math.min(newBottom, maxBottom));

      panel.style.right = newRight + 'px';
      panel.style.bottom = newBottom + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        header.style.cursor = 'move';
      }
    });
  }

  // Create keyboard shortcut hint element
  function createShortcutHint() {
    const hint = document.createElement('div');
    hint.className = 'perkins-shortcut-hint';
    hint.innerHTML = `Press <kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> to toggle Perkins`;
    document.body.appendChild(hint);

    // Show hint briefly on first visit
    chrome.storage.local.get(['perkinsShortcutShown'], (result) => {
      if (!result.perkinsShortcutShown) {
        setTimeout(() => {
          hint.classList.add('perkins-visible');
          setTimeout(() => {
            hint.classList.remove('perkins-visible');
            chrome.storage.local.set({ perkinsShortcutShown: true });
          }, 4000);
        }, 2000);
      }
    });
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

      // Instant feedback: show local metrics immediately
      const text = extractDocumentText();
      if (text && text.length >= MIN_TEXT_LENGTH) {
        const metrics = calculateLocalMetrics(text);
        showLocalMetrics(metrics);

        // Trigger analysis immediately (bypass debounce for panel open)
        performAnalysis();
      }
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
        <div class="perkins-loading">
          <div class="perkins-spinner"></div>
          <div class="perkins-loading-text">Analyzing your writing...</div>
          <div class="perkins-loading-subtext">Looking for off-voice moments</div>
        </div>
      `;
    }
  }

  function showPanelError(message, retryable = true) {
    const content = panel?.querySelector('.perkins-panel-content');
    if (content) {
      const isRateLimit = message.toLowerCase().includes('rate limit') || message.toLowerCase().includes('wait');

      if (isRateLimit) {
        content.innerHTML = `
          <div class="perkins-rate-limit">
            <div class="perkins-rate-limit-icon">⏱️</div>
            <div class="perkins-rate-limit-text">${escapeHtml(message)}</div>
          </div>
        `;
      } else {
        content.innerHTML = `
          <div class="perkins-error">
            <div class="perkins-error-icon">⚠️</div>
            <div class="perkins-error-message">${escapeHtml(message)}</div>
            ${retryable ? '<button class="perkins-error-retry">Try Again</button>' : ''}
          </div>
        `;

        // Bind retry button
        const retryBtn = content.querySelector('.perkins-error-retry');
        if (retryBtn) {
          retryBtn.addEventListener('click', () => {
            lastAnalyzedText = ''; // Reset to force re-analysis
            scheduleAnalysis();
          });
        }
      }
    }
  }

  function updatePanel() {
    const content = panel?.querySelector('.perkins-panel-content');
    if (!content) return;

    // Build detection warnings HTML
    let detectionsHtml = '';
    if (currentDetections) {
      const aiScore = currentDetections.aiScore || 0;
      const genericScore = currentDetections.genericScore || 0;

      if (aiScore >= 40 || genericScore >= 40) {
        detectionsHtml = '<div class="perkins-detections">';

        if (aiScore >= 40) {
          const aiLevel = aiScore >= 70 ? 'high' : 'medium';
          const aiIndicators = currentDetections.aiIndicators || [];
          detectionsHtml += `
            <div class="perkins-detection perkins-detection-ai perkins-detection-${aiLevel}">
              <div class="perkins-detection-header">
                <span class="perkins-detection-icon">🤖</span>
                <span class="perkins-detection-title">AI Detected (${aiScore}%)</span>
              </div>
              <div class="perkins-detection-text">
                This text sounds AI-generated, not like you.
              </div>
              ${aiIndicators.length > 0 ? `
                <div class="perkins-detection-indicators">
                  ${aiIndicators.slice(0, 3).map(i => `<span class="perkins-indicator">"${escapeHtml(i)}"</span>`).join('')}
                </div>
              ` : ''}
            </div>
          `;
        }

        if (genericScore >= 40) {
          const genericLevel = genericScore >= 70 ? 'high' : 'medium';
          const genericIndicators = currentDetections.genericIndicators || [];
          detectionsHtml += `
            <div class="perkins-detection perkins-detection-generic perkins-detection-${genericLevel}">
              <div class="perkins-detection-header">
                <span class="perkins-detection-icon">📋</span>
                <span class="perkins-detection-title">Generic Writing (${genericScore}%)</span>
              </div>
              <div class="perkins-detection-text">
                This sounds Grammarly-fied. Where's your voice?
              </div>
              ${genericIndicators.length > 0 ? `
                <div class="perkins-detection-indicators">
                  ${genericIndicators.slice(0, 3).map(i => `<span class="perkins-indicator">"${escapeHtml(i)}"</span>`).join('')}
                </div>
              ` : ''}
            </div>
          `;
        }

        detectionsHtml += '</div>';
      }
    }

    if (currentSuggestions.length === 0 && !detectionsHtml) {
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
      ${detectionsHtml}
      ${currentSuggestions.length > 0 ? `
        <div class="perkins-suggestions-header">
          <span>${currentSuggestions.length} suggestion${currentSuggestions.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="perkins-suggestions-list">
          ${suggestionsHtml}
        </div>
      ` : ''}
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

  // Calculate local metrics (no API needed - instant feedback)
  function calculateLocalMetrics(text) {
    if (!text) return null;

    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const sentenceCount = sentences.length;
    const avgWordsPerSentence = sentenceCount > 0 ? Math.round(wordCount / sentenceCount) : 0;
    const readingTimeMin = Math.max(1, Math.round(wordCount / 200)); // ~200 wpm reading speed

    return {
      wordCount,
      sentenceCount,
      avgWordsPerSentence,
      readingTimeMin
    };
  }

  // Show instant local metrics in panel
  function showLocalMetrics(metrics) {
    const content = panel?.querySelector('.perkins-panel-content');
    if (!content || !metrics) return;

    content.innerHTML = `
      <div class="perkins-instant-metrics">
        <div class="perkins-metrics-row">
          <span class="perkins-metric">
            <span class="perkins-metric-value">${metrics.wordCount}</span>
            <span class="perkins-metric-label">words</span>
          </span>
          <span class="perkins-metric">
            <span class="perkins-metric-value">${metrics.sentenceCount}</span>
            <span class="perkins-metric-label">sentences</span>
          </span>
          <span class="perkins-metric">
            <span class="perkins-metric-value">${metrics.avgWordsPerSentence}</span>
            <span class="perkins-metric-label">words/sentence</span>
          </span>
          <span class="perkins-metric">
            <span class="perkins-metric-value">${metrics.readingTimeMin}</span>
            <span class="perkins-metric-label">min read</span>
          </span>
        </div>
        <div class="perkins-analyzing-hint">
          <span class="perkins-spinner-small"></span>
          Analyzing voice...
        </div>
      </div>
    `;
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
            <button class="perkins-btn perkins-btn-apply" title="Apply changes using Find & Replace">Apply to Document</button>
            <button class="perkins-btn perkins-btn-copy-final" title="Copy edited text to clipboard">Copy Text</button>
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
    reviewModal.querySelector('.perkins-btn-apply').addEventListener('click', applyToDocument);
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

  // Apply changes to document using Find & Replace
  async function applyToDocument() {
    const changes = reviewSuggestions
      .map((s, i) => ({ ...s, index: i }))
      .filter(s => acceptedSuggestions.has(s.index));

    if (changes.length === 0) {
      showTemporaryMessage('No changes to apply. Accept some suggestions first.');
      return;
    }

    // Close modal and show progress overlay
    closeReviewModal();
    showApplyProgress(changes);
  }

  let applyOverlay = null;

  function showApplyProgress(changes) {
    // Create overlay for applying changes
    if (!applyOverlay) {
      applyOverlay = document.createElement('div');
      applyOverlay.id = 'perkins-apply-overlay';
      document.body.appendChild(applyOverlay);
    }

    applyOverlay.innerHTML = `
      <div class="perkins-apply-container">
        <div class="perkins-apply-header">
          <span class="perkins-logo-icon">P</span>
          <span>Applying Changes</span>
        </div>
        <div class="perkins-apply-content">
          <p class="perkins-apply-instruction">
            Click each "Apply" button to make the change using Find & Replace.
            <br><small>This preserves your document's formatting.</small>
          </p>
          <div class="perkins-apply-list"></div>
          <div class="perkins-apply-actions">
            <button class="perkins-btn perkins-btn-done">Done</button>
          </div>
        </div>
      </div>
    `;

    const listContainer = applyOverlay.querySelector('.perkins-apply-list');

    // Render each change with an apply button
    changes.forEach((change, i) => {
      const item = document.createElement('div');
      item.className = 'perkins-apply-item';
      item.dataset.index = i;
      item.innerHTML = `
        <div class="perkins-apply-item-text">
          <span class="perkins-apply-find">"${escapeHtml(truncateText(change.original, 40))}"</span>
          <span class="perkins-apply-arrow">→</span>
          <span class="perkins-apply-replace">"${escapeHtml(truncateText(change.suggestion, 40))}"</span>
        </div>
        <div class="perkins-apply-item-actions">
          <button class="perkins-btn perkins-btn-apply-one" data-index="${i}">Apply</button>
          <span class="perkins-apply-status"></span>
        </div>
      `;
      listContainer.appendChild(item);
    });

    // Bind apply buttons
    listContainer.querySelectorAll('.perkins-btn-apply-one').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index);
        const change = changes[idx];
        const item = btn.closest('.perkins-apply-item');
        const status = item.querySelector('.perkins-apply-status');

        btn.disabled = true;
        btn.textContent = 'Applying...';

        const success = await applyChangeWithFindReplace(change.original, change.suggestion);

        if (success) {
          btn.textContent = 'Done';
          btn.classList.add('perkins-btn-success');
          status.textContent = '✓';
          status.classList.add('success');
          item.classList.add('applied');
        } else {
          btn.textContent = 'Manual';
          btn.classList.add('perkins-btn-manual');
          status.textContent = 'Use Ctrl+H';
          status.classList.add('manual');

          // Copy find text to clipboard for manual use
          await navigator.clipboard.writeText(change.original);
          showTemporaryMessage('Original text copied. Press Ctrl+H to Find & Replace.');
        }
      });
    });

    // Done button
    applyOverlay.querySelector('.perkins-btn-done').addEventListener('click', () => {
      hideApplyOverlay();
    });

    applyOverlay.classList.add('perkins-apply-visible');
  }

  function hideApplyOverlay() {
    if (applyOverlay) {
      applyOverlay.classList.remove('perkins-apply-visible');
    }
  }

  function truncateText(text, maxLen) {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
  }

  // Attempt to automate Find & Replace in Google Docs
  async function applyChangeWithFindReplace(findText, replaceText) {
    try {
      // Focus the editor first
      const editor = document.querySelector('.kix-appview-editor');
      if (editor) {
        editor.click();
      }

      await delay(100);

      // Try to open Find & Replace with Ctrl+H
      const keyEvent = new KeyboardEvent('keydown', {
        key: 'h',
        code: 'KeyH',
        keyCode: 72,
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      });
      document.dispatchEvent(keyEvent);

      // Wait for dialog to appear
      await delay(500);

      // Google Docs Find & Replace dialog
      const dialog = document.querySelector('.docs-findandreplacedialog');
      if (!dialog) {
        console.log('Perkins: Find & Replace dialog not found, trying menu');
        // Try via Edit menu as fallback
        return await tryMenuFindReplace(findText, replaceText);
      }

      // Find the input fields - Google Docs uses specific structure
      const inputs = dialog.querySelectorAll('input[type="text"]');
      if (inputs.length < 2) {
        console.log('Perkins: Could not find input fields');
        return false;
      }

      const findInput = inputs[0];
      const replaceInput = inputs[1];

      // Clear and set find text
      findInput.focus();
      findInput.value = findText;
      findInput.dispatchEvent(new Event('input', { bubbles: true }));
      findInput.dispatchEvent(new Event('change', { bubbles: true }));

      await delay(100);

      // Set replace text
      replaceInput.focus();
      replaceInput.value = replaceText;
      replaceInput.dispatchEvent(new Event('input', { bubbles: true }));
      replaceInput.dispatchEvent(new Event('change', { bubbles: true }));

      await delay(100);

      // Find and click the Replace All or Replace button
      const buttons = dialog.querySelectorAll('button');
      let replaceBtn = null;

      for (const btn of buttons) {
        const text = btn.textContent.toLowerCase();
        if (text.includes('replace all')) {
          replaceBtn = btn;
          break;
        } else if (text.includes('replace') && !text.includes('find')) {
          replaceBtn = btn;
        }
      }

      if (replaceBtn && !replaceBtn.disabled) {
        replaceBtn.click();
        await delay(300);

        // Close the dialog
        const closeBtn = dialog.querySelector('button[aria-label="Close"]') ||
                         dialog.querySelector('.docs-dialog-close');
        if (closeBtn) {
          closeBtn.click();
        } else {
          // Try Escape key
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            bubbles: true
          }));
        }

        return true;
      }

      return false;
    } catch (err) {
      console.error('Perkins: Find & Replace automation failed:', err);
      return false;
    }
  }

  // Fallback: try to access Find & Replace via menu
  async function tryMenuFindReplace(findText, replaceText) {
    // This is a fallback that's less reliable
    // For now, return false to trigger manual mode
    return false;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function closeReviewModal() {
    if (reviewModal) {
      reviewModal.classList.remove('perkins-review-visible');
    }
  }

  // ============================================
  // Chat Modal - Conversational editing
  // ============================================

  let chatModal = null;
  let chatHistory = [];

  function createChatModal() {
    if (chatModal) return;

    chatModal = document.createElement('div');
    chatModal.id = 'perkins-chat-modal';
    chatModal.innerHTML = `
      <div class="perkins-chat-overlay"></div>
      <div class="perkins-chat-container">
        <div class="perkins-chat-header">
          <div class="perkins-chat-title">
            <span class="perkins-logo-icon">P</span>
            <span>Chat with Perkins</span>
          </div>
          <button class="perkins-btn-close-chat" title="Close">×</button>
        </div>
        <div class="perkins-chat-context">
          <span class="perkins-context-label">Context:</span>
          <span class="perkins-context-text">Current document</span>
        </div>
        <div class="perkins-chat-messages" id="perkins-chat-messages">
          <div class="perkins-chat-welcome">
            <p>Ask me anything about your writing!</p>
            <div class="perkins-chat-suggestions">
              <button class="perkins-suggestion-chip">Why did you suggest that change?</button>
              <button class="perkins-suggestion-chip">What's my writing style?</button>
              <button class="perkins-suggestion-chip">Make this paragraph punchier</button>
              <button class="perkins-suggestion-chip">Help me with the opening</button>
            </div>
          </div>
        </div>
        <div class="perkins-chat-input-area">
          <textarea id="perkins-chat-input" placeholder="Type your message..." rows="2"></textarea>
          <button class="perkins-btn perkins-btn-send" id="perkins-chat-send">
            <span>Send</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(chatModal);

    // Event listeners
    chatModal.querySelector('.perkins-chat-overlay').addEventListener('click', closeChatModal);
    chatModal.querySelector('.perkins-btn-close-chat').addEventListener('click', closeChatModal);
    chatModal.querySelector('#perkins-chat-send').addEventListener('click', sendChatMessage);

    // Enter to send
    chatModal.querySelector('#perkins-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    // Suggestion chips
    chatModal.querySelectorAll('.perkins-suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chatModal.querySelector('#perkins-chat-input').value = chip.textContent;
        sendChatMessage();
      });
    });
  }

  function openChatModal() {
    createChatModal();
    chatModal.classList.add('perkins-chat-visible');

    // Update context with current selection or paragraph
    const selection = window.getSelection();
    let contextText = 'Current document';

    if (selection && selection.toString().trim().length > 0) {
      contextText = `Selected: "${truncateText(selection.toString(), 50)}"`;
    } else {
      const paragraph = getCurrentParagraph();
      if (paragraph && paragraph.length > 0) {
        contextText = `Current paragraph: "${truncateText(paragraph, 50)}"`;
      }
    }

    chatModal.querySelector('.perkins-context-text').textContent = contextText;

    // Focus input
    setTimeout(() => {
      chatModal.querySelector('#perkins-chat-input').focus();
    }, 100);
  }

  function closeChatModal() {
    if (chatModal) {
      chatModal.classList.remove('perkins-chat-visible');
    }
  }

  async function sendChatMessage() {
    const input = chatModal.querySelector('#perkins-chat-input');
    const message = input.value.trim();

    if (!message) return;

    // Clear input
    input.value = '';

    // Get context
    const selection = window.getSelection();
    let context = '';

    if (selection && selection.toString().trim().length > 0) {
      context = selection.toString();
    } else {
      context = getCurrentParagraph();
    }

    // Add user message to chat
    addChatMessage('user', message);

    // Show loading
    const loadingId = addChatMessage('assistant', '...', true);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHAT_MESSAGE',
        message: message,
        context: context,
        history: chatHistory.slice(-6) // Last 3 exchanges
      });

      // Remove loading
      removeChatMessage(loadingId);

      if (response.error) {
        addChatMessage('assistant', `Error: ${response.error}`);
      } else {
        addChatMessage('assistant', response.reply);

        // Store in history
        chatHistory.push({ role: 'user', content: message });
        chatHistory.push({ role: 'assistant', content: response.reply });

        // Keep history manageable
        if (chatHistory.length > 20) {
          chatHistory = chatHistory.slice(-20);
        }
      }
    } catch (err) {
      removeChatMessage(loadingId);
      addChatMessage('assistant', 'Failed to send message. Please try again.');
      console.error('Chat error:', err);
    }
  }

  function addChatMessage(role, content, isLoading = false) {
    const messagesContainer = chatModal.querySelector('#perkins-chat-messages');

    // Hide welcome message
    const welcome = messagesContainer.querySelector('.perkins-chat-welcome');
    if (welcome) {
      welcome.style.display = 'none';
    }

    const messageDiv = document.createElement('div');
    const id = 'msg-' + Date.now();
    messageDiv.id = id;
    messageDiv.className = `perkins-chat-message perkins-chat-${role}`;

    if (isLoading) {
      messageDiv.classList.add('perkins-chat-loading');
      messageDiv.innerHTML = '<span class="perkins-typing-indicator">●●●</span>';
    } else {
      messageDiv.textContent = content;
    }

    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    return id;
  }

  function removeChatMessage(id) {
    const msg = chatModal.querySelector(`#${id}`);
    if (msg) {
      msg.remove();
    }
  }

  // ============================================
  // Write For Me Modal - Generate in voice
  // ============================================

  let writeModal = null;

  function createWriteModal() {
    if (writeModal) return;

    writeModal = document.createElement('div');
    writeModal.id = 'perkins-write-modal';
    writeModal.innerHTML = `
      <div class="perkins-write-overlay"></div>
      <div class="perkins-write-container">
        <div class="perkins-write-header">
          <div class="perkins-write-title">
            <span class="perkins-logo-icon">P</span>
            <span>Write Like Me</span>
          </div>
          <button class="perkins-btn-close-write" title="Close">×</button>
        </div>
        <div class="perkins-write-body">
          <div class="perkins-write-input-section">
            <label>What do you want to write?</label>
            <textarea id="perkins-write-prompt" placeholder="e.g., An email declining a meeting politely, A tweet about launching our new feature, An intro paragraph for my blog post about AI..." rows="4"></textarea>
            <div class="perkins-write-options">
              <label class="perkins-write-option">
                <input type="radio" name="write-length" value="short" checked>
                <span>Short</span>
              </label>
              <label class="perkins-write-option">
                <input type="radio" name="write-length" value="medium">
                <span>Medium</span>
              </label>
              <label class="perkins-write-option">
                <input type="radio" name="write-length" value="long">
                <span>Long</span>
              </label>
            </div>
            <button class="perkins-btn perkins-btn-primary perkins-btn-generate" id="perkins-generate-btn">
              ✍️ Generate in My Voice
            </button>
          </div>
          <div class="perkins-write-output-section" style="display: none;">
            <label>Generated text:</label>
            <div class="perkins-write-output" id="perkins-write-output"></div>
            <div class="perkins-write-actions">
              <button class="perkins-btn perkins-btn-copy">Copy</button>
              <button class="perkins-btn perkins-btn-insert">Insert at Cursor</button>
              <button class="perkins-btn perkins-btn-regenerate">Regenerate</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(writeModal);

    // Event listeners
    writeModal.querySelector('.perkins-write-overlay').addEventListener('click', closeWriteModal);
    writeModal.querySelector('.perkins-btn-close-write').addEventListener('click', closeWriteModal);
    writeModal.querySelector('#perkins-generate-btn').addEventListener('click', generateInVoice);
    writeModal.querySelector('.perkins-btn-copy').addEventListener('click', copyGeneratedText);
    writeModal.querySelector('.perkins-btn-insert').addEventListener('click', insertGeneratedText);
    writeModal.querySelector('.perkins-btn-regenerate').addEventListener('click', generateInVoice);
  }

  function openWriteModal() {
    createWriteModal();
    writeModal.classList.add('perkins-write-visible');

    // Reset state
    writeModal.querySelector('#perkins-write-prompt').value = '';
    writeModal.querySelector('.perkins-write-output-section').style.display = 'none';
    writeModal.querySelector('.perkins-write-input-section').style.display = 'block';

    // Focus input
    setTimeout(() => {
      writeModal.querySelector('#perkins-write-prompt').focus();
    }, 100);
  }

  function closeWriteModal() {
    if (writeModal) {
      writeModal.classList.remove('perkins-write-visible');
    }
  }

  let lastGeneratedText = '';

  async function generateInVoice() {
    const prompt = writeModal.querySelector('#perkins-write-prompt').value.trim();
    if (!prompt) {
      showTemporaryMessage('Please describe what you want to write.');
      return;
    }

    const length = writeModal.querySelector('input[name="write-length"]:checked').value;

    const btn = writeModal.querySelector('#perkins-generate-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ Generating...';
    btn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_IN_VOICE',
        prompt: prompt,
        length: length
      });

      if (response.error) {
        showTemporaryMessage(response.error);
      } else {
        lastGeneratedText = response.text;
        writeModal.querySelector('#perkins-write-output').textContent = response.text;
        writeModal.querySelector('.perkins-write-output-section').style.display = 'block';
      }
    } catch (err) {
      console.error('Generate error:', err);
      showTemporaryMessage('Failed to generate. Please try again.');
    }

    btn.innerHTML = originalText;
    btn.disabled = false;
  }

  function copyGeneratedText() {
    if (lastGeneratedText) {
      navigator.clipboard.writeText(lastGeneratedText).then(() => {
        showTemporaryMessage('Copied to clipboard!');
      });
    }
  }

  function insertGeneratedText() {
    if (lastGeneratedText) {
      // Copy to clipboard and instruct user
      navigator.clipboard.writeText(lastGeneratedText).then(() => {
        closeWriteModal();
        showTemporaryMessage('Text copied! Press Ctrl+V to paste at cursor.');
      });
    }
  }

})();
