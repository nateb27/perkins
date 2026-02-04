/**
 * Perkins Content Script for Gmail
 * Monitors compose windows and provides coaching suggestions
 */

(function() {
  'use strict';

  // State
  let isEnabled = false;
  let isInitialized = false;
  let observedComposeWindows = new WeakSet();
  let activeComposeId = null;
  let currentSuggestions = [];
  let ambientLearningEnabled = false;

  // Configuration
  const DEBOUNCE_MS = 2000;
  const MIN_TEXT_LENGTH = 30;

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    if (isInitialized) return;
    isInitialized = true;

    console.log('Perkins: Initializing on Gmail');

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

    // Start observing for compose windows
    observeComposeWindows();
  }

  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'COACH_STATUS':
        isEnabled = message.enabled;
        if (isEnabled) {
          startMonitoring();
        } else {
          stopMonitoring();
        }
        break;

      case 'SETTINGS_UPDATED':
        if (message.settings) {
          ambientLearningEnabled = message.settings.ambientLearning || false;
        }
        break;
    }
  }

  // Watch for compose windows appearing
  function observeComposeWindows() {
    const observer = new MutationObserver((mutations) => {
      // Look for compose windows
      const composeWindows = document.querySelectorAll('div[role="dialog"], div.nH.Hd');

      composeWindows.forEach(window => {
        const messageBody = window.querySelector('div[role="textbox"][aria-label*="Message Body"], div[role="textbox"][g_editable="true"]');

        if (messageBody && !observedComposeWindows.has(messageBody)) {
          observedComposeWindows.add(messageBody);
          attachToComposeWindow(window, messageBody);
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Also check for existing compose windows
    setTimeout(() => {
      const composeWindows = document.querySelectorAll('div[role="dialog"], div.nH.Hd');
      composeWindows.forEach(window => {
        const messageBody = window.querySelector('div[role="textbox"][aria-label*="Message Body"], div[role="textbox"][g_editable="true"]');
        if (messageBody && !observedComposeWindows.has(messageBody)) {
          observedComposeWindows.add(messageBody);
          attachToComposeWindow(window, messageBody);
        }
      });
    }, 1000);
  }

  // Attach Perkins to a compose window
  function attachToComposeWindow(composeWindow, messageBody) {
    console.log('Perkins: Attaching to Gmail compose window');

    // Create Perkins button
    const perkinsBtn = document.createElement('div');
    perkinsBtn.className = 'perkins-gmail-btn';
    perkinsBtn.innerHTML = `
      <div class="perkins-gmail-icon">P</div>
      <div class="perkins-gmail-tooltip">Perkins Writing Coach</div>
    `;
    perkinsBtn.style.cssText = `
      position: absolute;
      right: 80px;
      bottom: 10px;
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 1000;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4);
    `;

    const icon = perkinsBtn.querySelector('.perkins-gmail-icon');
    icon.style.cssText = `
      color: white;
      font-weight: bold;
      font-size: 14px;
      font-family: system-ui, sans-serif;
    `;

    const tooltip = perkinsBtn.querySelector('.perkins-gmail-tooltip');
    tooltip.style.cssText = `
      position: absolute;
      bottom: 40px;
      right: 0;
      background: #333;
      color: white;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
    `;

    perkinsBtn.addEventListener('mouseenter', () => {
      perkinsBtn.style.transform = 'scale(1.1)';
      tooltip.style.opacity = '1';
    });

    perkinsBtn.addEventListener('mouseleave', () => {
      perkinsBtn.style.transform = 'scale(1)';
      tooltip.style.opacity = '0';
    });

    // Find the compose footer to position button
    const composeFooter = composeWindow.querySelector('div.btC') || composeWindow.querySelector('td.Ap');
    if (composeFooter) {
      composeFooter.style.position = 'relative';
      composeFooter.appendChild(perkinsBtn);
    } else {
      // Fallback: attach to compose window itself
      composeWindow.style.position = 'relative';
      composeWindow.appendChild(perkinsBtn);
    }

    // Create mini panel
    const miniPanel = createMiniPanel(composeWindow, messageBody);

    // Toggle panel on click
    perkinsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      miniPanel.style.display = miniPanel.style.display === 'none' ? 'block' : 'none';

      if (miniPanel.style.display === 'block') {
        analyzeCompose(messageBody, miniPanel);
      }
    });

    // Set up text monitoring with debounce
    let debounceTimer = null;
    messageBody.addEventListener('input', () => {
      if (!isEnabled) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (miniPanel.style.display === 'block') {
          analyzeCompose(messageBody, miniPanel);
        }
      }, DEBOUNCE_MS);
    });
  }

  // Create mini coaching panel for Gmail
  function createMiniPanel(composeWindow, messageBody) {
    const panel = document.createElement('div');
    panel.className = 'perkins-gmail-panel';
    panel.style.cssText = `
      position: absolute;
      right: 10px;
      bottom: 60px;
      width: 320px;
      max-height: 400px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      z-index: 1001;
      display: none;
      overflow: hidden;
      font-family: system-ui, -apple-system, sans-serif;
    `;

    panel.innerHTML = `
      <div class="perkins-gmail-header" style="
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 12px 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      ">
        <span style="font-weight: 600; font-size: 14px;">Perkins</span>
        <div style="display: flex; gap: 8px;">
          <button class="perkins-gmail-chat-btn" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          ">Chat</button>
          <button class="perkins-gmail-write-btn" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          ">Write</button>
          <button class="perkins-gmail-close" style="
            background: none;
            border: none;
            color: white;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
          ">&times;</button>
        </div>
      </div>
      <div class="perkins-gmail-content" style="
        padding: 12px 16px;
        max-height: 320px;
        overflow-y: auto;
      ">
        <div class="perkins-gmail-loading" style="
          text-align: center;
          padding: 20px;
          color: #666;
        ">
          <div class="perkins-spinner" style="
            width: 24px;
            height: 24px;
            border: 2px solid #eee;
            border-top-color: #667eea;
            border-radius: 50%;
            margin: 0 auto 10px;
            animation: perkins-spin 1s linear infinite;
          "></div>
          Analyzing...
        </div>
        <div class="perkins-gmail-suggestions" style="display: none;"></div>
        <div class="perkins-gmail-empty" style="
          display: none;
          text-align: center;
          padding: 20px;
          color: #666;
        ">
          <div style="font-size: 24px; margin-bottom: 8px;">✓</div>
          Looking good! Your email sounds like you.
        </div>
      </div>
    `;

    // Add spinner animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes perkins-spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);

    // Close button
    panel.querySelector('.perkins-gmail-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });

    // Chat button
    panel.querySelector('.perkins-gmail-chat-btn').addEventListener('click', () => {
      openChatModal(messageBody);
    });

    // Write button
    panel.querySelector('.perkins-gmail-write-btn').addEventListener('click', () => {
      openWriteModal(messageBody);
    });

    // Position panel
    const composeFooter = composeWindow.querySelector('div.btC') || composeWindow.querySelector('td.Ap');
    if (composeFooter) {
      composeFooter.appendChild(panel);
    } else {
      composeWindow.appendChild(panel);
    }

    return panel;
  }

  // Analyze compose text
  async function analyzeCompose(messageBody, panel) {
    const text = messageBody.innerText || messageBody.textContent;

    if (!text || text.trim().length < MIN_TEXT_LENGTH) {
      showEmptyState(panel, 'Write a bit more and I\'ll help you sound like yourself.');
      return;
    }

    showLoading(panel);

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ANALYZE_TEXT',
        text: text.trim(),
        context: { source: 'gmail' }
      });

      if (result.error) {
        showError(panel, result.error);
        return;
      }

      if (result.suggestions && result.suggestions.length > 0) {
        showSuggestions(panel, result.suggestions, messageBody);
      } else {
        showEmptyState(panel, 'Looking good! Your email sounds like you.');
      }
    } catch (err) {
      console.error('Perkins: Analysis failed', err);
      showError(panel, 'Analysis failed. Please try again.');
    }
  }

  function showLoading(panel) {
    panel.querySelector('.perkins-gmail-loading').style.display = 'block';
    panel.querySelector('.perkins-gmail-suggestions').style.display = 'none';
    panel.querySelector('.perkins-gmail-empty').style.display = 'none';
  }

  function showEmptyState(panel, message) {
    panel.querySelector('.perkins-gmail-loading').style.display = 'none';
    panel.querySelector('.perkins-gmail-suggestions').style.display = 'none';
    const empty = panel.querySelector('.perkins-gmail-empty');
    empty.innerHTML = `<div style="font-size: 24px; margin-bottom: 8px;">✓</div>${message}`;
    empty.style.display = 'block';
  }

  function showError(panel, message) {
    panel.querySelector('.perkins-gmail-loading').style.display = 'none';
    panel.querySelector('.perkins-gmail-suggestions').style.display = 'none';
    const empty = panel.querySelector('.perkins-gmail-empty');
    empty.innerHTML = `<div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>${escapeHtml(message)}`;
    empty.style.display = 'block';
  }

  function showSuggestions(panel, suggestions, messageBody) {
    panel.querySelector('.perkins-gmail-loading').style.display = 'none';
    panel.querySelector('.perkins-gmail-empty').style.display = 'none';

    const container = panel.querySelector('.perkins-gmail-suggestions');
    container.style.display = 'block';
    container.innerHTML = '';

    suggestions.forEach((suggestion, index) => {
      const card = document.createElement('div');
      card.style.cssText = `
        background: #f8f9fa;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 10px;
        border-left: 3px solid #667eea;
      `;

      card.innerHTML = `
        <div style="font-size: 12px; color: #666; margin-bottom: 6px;">
          ${escapeHtml(suggestion.reason)}
        </div>
        <div style="margin-bottom: 8px;">
          <span style="background: #fee; padding: 2px 4px; border-radius: 3px; text-decoration: line-through; color: #c00;">
            ${escapeHtml(suggestion.original)}
          </span>
        </div>
        <div style="margin-bottom: 10px;">
          <span style="background: #efe; padding: 2px 4px; border-radius: 3px; color: #060;">
            ${escapeHtml(suggestion.suggestion)}
          </span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="perkins-apply-btn" style="
            background: #667eea;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          ">Apply</button>
          <button class="perkins-dismiss-btn" style="
            background: #eee;
            color: #666;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          ">Dismiss</button>
        </div>
      `;

      // Apply button
      card.querySelector('.perkins-apply-btn').addEventListener('click', () => {
        applySuggestion(messageBody, suggestion);
        card.remove();

        if (container.children.length === 0) {
          showEmptyState(panel, 'All suggestions applied!');
        }
      });

      // Dismiss button
      card.querySelector('.perkins-dismiss-btn').addEventListener('click', () => {
        card.remove();

        // Record as rejected
        chrome.runtime.sendMessage({
          type: 'SUGGESTION_FEEDBACK',
          suggestion,
          accepted: false
        }).catch(() => {});

        if (container.children.length === 0) {
          showEmptyState(panel, 'Looking good! Your email sounds like you.');
        }
      });

      container.appendChild(card);
    });
  }

  // Apply a suggestion to the compose body
  function applySuggestion(messageBody, suggestion) {
    const html = messageBody.innerHTML;
    const text = messageBody.innerText;

    // Try to find and replace in HTML
    if (html.includes(suggestion.original)) {
      messageBody.innerHTML = html.replace(suggestion.original, suggestion.suggestion);
    } else if (text.includes(suggestion.original)) {
      // Fallback to text replacement
      messageBody.innerText = text.replace(suggestion.original, suggestion.suggestion);
    }

    // Record as accepted
    chrome.runtime.sendMessage({
      type: 'SUGGESTION_FEEDBACK',
      suggestion,
      accepted: true
    }).catch(() => {});

    // Trigger input event to update Gmail's state
    messageBody.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Open chat modal
  function openChatModal(messageBody) {
    // Remove existing modal
    const existing = document.getElementById('perkins-gmail-chat-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'perkins-gmail-chat-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    modal.innerHTML = `
      <div style="
        background: white;
        border-radius: 12px;
        width: 500px;
        max-height: 600px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      ">
        <div style="
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 16px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        ">
          <span style="font-weight: 600;">Chat with Perkins</span>
          <button class="close-modal" style="
            background: none;
            border: none;
            color: white;
            font-size: 24px;
            cursor: pointer;
          ">&times;</button>
        </div>
        <div class="chat-messages" style="
          flex: 1;
          padding: 16px;
          overflow-y: auto;
          max-height: 400px;
          min-height: 200px;
        ">
          <div style="
            background: #f0f0f0;
            padding: 10px 14px;
            border-radius: 12px;
            margin-bottom: 10px;
            max-width: 80%;
          ">
            Hi! I'm Perkins. Ask me anything about your email - how to make it clearer, more persuasive, or more you.
          </div>
        </div>
        <div style="
          padding: 16px;
          border-top: 1px solid #eee;
          display: flex;
          gap: 10px;
        ">
          <input type="text" class="chat-input" placeholder="Ask about your email..." style="
            flex: 1;
            padding: 10px 14px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-size: 14px;
          ">
          <button class="chat-send" style="
            background: #667eea;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 500;
          ">Send</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const chatMessages = modal.querySelector('.chat-messages');
    const chatInput = modal.querySelector('.chat-input');
    const chatSend = modal.querySelector('.chat-send');
    const chatHistory = [];

    // Close modal
    modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Send message
    const sendMessage = async () => {
      const message = chatInput.value.trim();
      if (!message) return;

      // Add user message
      chatMessages.innerHTML += `
        <div style="
          background: #667eea;
          color: white;
          padding: 10px 14px;
          border-radius: 12px;
          margin-bottom: 10px;
          max-width: 80%;
          margin-left: auto;
        ">${escapeHtml(message)}</div>
      `;

      chatInput.value = '';
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // Show typing indicator
      const typingId = 'typing-' + Date.now();
      chatMessages.innerHTML += `
        <div id="${typingId}" style="
          background: #f0f0f0;
          padding: 10px 14px;
          border-radius: 12px;
          margin-bottom: 10px;
          max-width: 80%;
        ">Thinking...</div>
      `;
      chatMessages.scrollTop = chatMessages.scrollHeight;

      try {
        const context = messageBody.innerText || messageBody.textContent;
        chatHistory.push({ role: 'user', content: message });

        const result = await chrome.runtime.sendMessage({
          type: 'CHAT_MESSAGE',
          message,
          context,
          history: chatHistory
        });

        // Remove typing indicator
        document.getElementById(typingId)?.remove();

        if (result.error) {
          chatMessages.innerHTML += `
            <div style="
              background: #fee;
              color: #c00;
              padding: 10px 14px;
              border-radius: 12px;
              margin-bottom: 10px;
              max-width: 80%;
            ">${escapeHtml(result.error)}</div>
          `;
        } else {
          chatHistory.push({ role: 'assistant', content: result.reply });
          chatMessages.innerHTML += `
            <div style="
              background: #f0f0f0;
              padding: 10px 14px;
              border-radius: 12px;
              margin-bottom: 10px;
              max-width: 80%;
            ">${escapeHtml(result.reply)}</div>
          `;
        }
      } catch (err) {
        document.getElementById(typingId)?.remove();
        chatMessages.innerHTML += `
          <div style="
            background: #fee;
            color: #c00;
            padding: 10px 14px;
            border-radius: 12px;
            margin-bottom: 10px;
            max-width: 80%;
          ">Something went wrong. Please try again.</div>
        `;
      }

      chatMessages.scrollTop = chatMessages.scrollHeight;
    };

    chatSend.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    chatInput.focus();
  }

  // Open write modal
  function openWriteModal(messageBody) {
    const existing = document.getElementById('perkins-gmail-write-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'perkins-gmail-write-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    modal.innerHTML = `
      <div style="
        background: white;
        border-radius: 12px;
        width: 500px;
        overflow: hidden;
      ">
        <div style="
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 16px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        ">
          <span style="font-weight: 600;">Write Like Me</span>
          <button class="close-modal" style="
            background: none;
            border: none;
            color: white;
            font-size: 24px;
            cursor: pointer;
          ">&times;</button>
        </div>
        <div style="padding: 20px;">
          <textarea class="write-prompt" placeholder="Describe what you want to write... e.g., 'a follow-up email asking about the project status'" style="
            width: 100%;
            height: 100px;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-size: 14px;
            resize: none;
            box-sizing: border-box;
          "></textarea>
          <div style="margin: 12px 0; display: flex; gap: 10px;">
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
              <input type="radio" name="write-length" value="short" checked>
              <span style="font-size: 13px;">Short</span>
            </label>
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
              <input type="radio" name="write-length" value="medium">
              <span style="font-size: 13px;">Medium</span>
            </label>
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
              <input type="radio" name="write-length" value="long">
              <span style="font-size: 13px;">Long</span>
            </label>
          </div>
          <button class="generate-btn" style="
            width: 100%;
            background: #667eea;
            color: white;
            border: none;
            padding: 12px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 500;
            font-size: 14px;
          ">Generate in My Voice</button>
          <div class="write-result" style="
            display: none;
            margin-top: 16px;
            padding: 12px;
            background: #f8f9fa;
            border-radius: 8px;
            font-size: 14px;
            line-height: 1.5;
          "></div>
          <button class="insert-btn" style="
            display: none;
            width: 100%;
            margin-top: 10px;
            background: #28a745;
            color: white;
            border: none;
            padding: 12px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 500;
            font-size: 14px;
          ">Insert into Email</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const promptInput = modal.querySelector('.write-prompt');
    const generateBtn = modal.querySelector('.generate-btn');
    const resultDiv = modal.querySelector('.write-result');
    const insertBtn = modal.querySelector('.insert-btn');
    let generatedText = '';

    // Close modal
    modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Generate
    generateBtn.addEventListener('click', async () => {
      const prompt = promptInput.value.trim();
      if (!prompt) return;

      const length = modal.querySelector('input[name="write-length"]:checked').value;

      generateBtn.disabled = true;
      generateBtn.textContent = 'Generating...';

      try {
        const result = await chrome.runtime.sendMessage({
          type: 'GENERATE_IN_VOICE',
          prompt,
          length
        });

        if (result.error) {
          resultDiv.style.display = 'block';
          resultDiv.style.background = '#fee';
          resultDiv.style.color = '#c00';
          resultDiv.textContent = result.error;
          insertBtn.style.display = 'none';
        } else {
          generatedText = result.text;
          resultDiv.style.display = 'block';
          resultDiv.style.background = '#f8f9fa';
          resultDiv.style.color = '#333';
          resultDiv.textContent = result.text;
          insertBtn.style.display = 'block';
        }
      } catch (err) {
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#fee';
        resultDiv.style.color = '#c00';
        resultDiv.textContent = 'Generation failed. Please try again.';
      }

      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate in My Voice';
    });

    // Insert into email
    insertBtn.addEventListener('click', () => {
      if (generatedText) {
        // Insert at cursor or append
        const currentText = messageBody.innerText || '';
        if (currentText.trim()) {
          messageBody.innerText = currentText + '\n\n' + generatedText;
        } else {
          messageBody.innerText = generatedText;
        }
        messageBody.dispatchEvent(new Event('input', { bubbles: true }));
        modal.remove();
      }
    });

    promptInput.focus();
  }

  function startMonitoring() {
    console.log('Perkins: Gmail monitoring started');
  }

  function stopMonitoring() {
    console.log('Perkins: Gmail monitoring stopped');
  }

  // Utility
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

})();
