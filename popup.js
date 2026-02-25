/**
 * Notebook Chrome Extension — popup.js
 * Single IIFE with named module objects: STATE, STORAGE, TABS, EDITOR, TOOLBAR
 */
(function () {
  'use strict';

  function escapeHTML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ============================================================
     STATE — in-memory working copy
     ============================================================ */
  const STATE = {
    tabs: [],           // Array<{ id, name, content, createdAt, updatedAt }>
    activeTabId: null,  // string
    isDirty: false,
    saveTimer: null,
  };

  /* ============================================================
     STORAGE — chrome.storage.local wrappers
     ============================================================ */
  const STORAGE = {
    KEY: 'notebookData',

    async load() {
      return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE.KEY, (result) => {
          resolve(result[STORAGE.KEY] || null);
        });
      });
    },

    async save(data) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE.KEY]: data }, resolve);
      });
    },

    /** Flush current STATE to storage immediately. */
    async flush() {
      STATE.isDirty = false;
      if (STATE.saveTimer) {
        clearTimeout(STATE.saveTimer);
        STATE.saveTimer = null;
      }
      // Capture the active tab's latest editor content before saving
      const activeTab = STATE.tabs.find((t) => t.id === STATE.activeTabId);
      if (activeTab) {
        activeTab.content = EDITOR.getHTML();
        activeTab.updatedAt = Date.now();
      }
      await STORAGE.save({
        activeTabId: STATE.activeTabId,
        tabs: STATE.tabs,
      });
    },

    /** Debounced save — fires 600ms after last call. */
    scheduleSave() {
      STATE.isDirty = true;
      if (STATE.saveTimer) clearTimeout(STATE.saveTimer);
      STATE.saveTimer = setTimeout(() => {
        STORAGE.flush();
      }, 600);
    },
  };

  /* ============================================================
     LINKS — URL detection, auto-linkify, open-in-new-tab button
     ============================================================ */
  const LINKS = {
    floatBtn: null,
    activeLink: null,
    _hideTimer: null,

    init(editorEl, appEl) {
      const btn = document.createElement('button');
      btn.className = 'link-open-btn';
      btn.title = 'Open in new tab';
      btn.setAttribute('aria-label', 'Open link in new tab');
      btn.innerHTML =
        '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
        '<path d="M5 2H2a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
        '<path d="M8 1h3m0 0v3M11 1L5.5 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';
      appEl.appendChild(btn);
      LINKS.floatBtn = btn;

      // Don't steal focus from editor
      btn.addEventListener('mousedown', (e) => e.preventDefault());

      btn.addEventListener('click', () => {
        if (LINKS.activeLink) {
          const href = LINKS.activeLink.href;
          if (/^https?:\/\//i.test(href)) chrome.tabs.create({ url: href });
        }
      });

      // Keep button visible while hovering over it
      btn.addEventListener('mouseenter', () => clearTimeout(LINKS._hideTimer));
      btn.addEventListener('mouseleave', () => LINKS.hide());

      // Show button when hovering over a link in the editor
      editorEl.addEventListener('mouseover', (e) => {
        const link = e.target.closest('a[href]');
        if (link) {
          clearTimeout(LINKS._hideTimer);
          LINKS.show(link);
        }
      });

      // Start hide timer when leaving a link (gives time to reach the button)
      editorEl.addEventListener('mouseout', (e) => {
        if (e.target.closest('a[href]')) {
          LINKS._hideTimer = setTimeout(() => LINKS.hide(), 120);
        }
      });
    },

    show(linkEl) {
      LINKS.activeLink = linkEl;
      const rect = linkEl.getBoundingClientRect();
      const appRect = document.querySelector('.app').getBoundingClientRect();
      const btnWidth = 24;
      let left = rect.right + 3;
      if (left + btnWidth > appRect.right - 2) left = appRect.right - btnWidth - 2;
      const top = rect.top + Math.round((rect.height - 20) / 2);
      const btn = LINKS.floatBtn;
      btn.style.left = left + 'px';
      btn.style.top = top + 'px';
      btn.classList.add('is-visible');
    },

    hide() {
      LINKS.activeLink = null;
      if (LINKS.floatBtn) LINKS.floatBtn.classList.remove('is-visible');
    },

    /** Replace the URL immediately before the caret with an <a> tag. */
    tryAutoLinkBeforeCaret() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return false;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return false;
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return false;
      if (!EDITOR.el || !EDITOR.el.contains(node)) return false;
      // Don't nest links
      let p = node.parentElement;
      while (p && p !== EDITOR.el) {
        if (p.tagName === 'A') return false;
        p = p.parentElement;
      }
      const textBefore = node.textContent.slice(0, range.startOffset);
      const m = textBefore.match(/(https?:\/\/\S+)$/);
      if (!m) return false;
      const rawUrl = m[1];
      const url = rawUrl.replace(/[.,;:!?)\]'"]+$/, '');
      if (url.length < 8) return false; // sanity: at least "http://x"
      const urlOffset = range.startOffset - rawUrl.length;
      const before = node.textContent.slice(0, urlOffset);
      const after = node.textContent.slice(range.startOffset);
      const parent = node.parentNode;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.textContent = url;
      const afterNode = document.createTextNode(after);
      if (before) {
        node.textContent = before;
        parent.insertBefore(anchor, node.nextSibling);
      } else {
        parent.insertBefore(anchor, node);
        parent.removeChild(node);
      }
      parent.insertBefore(afterNode, anchor.nextSibling);
      // Reposition caret to start of afterNode
      const newRange = document.createRange();
      newRange.setStart(afterNode, 0);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      STORAGE.scheduleSave();
      return true;
    },

    /** Convert plain text (possibly multi-line) with URLs into linkified HTML. */
    linkifyPlainText(text) {
      const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      return lines.map((line) => {
        const re = /(https?:\/\/\S+)/g;
        let result = '';
        let last = 0;
        let match;
        while ((match = re.exec(line)) !== null) {
          const rawUrl = match[1];
          const url = rawUrl.replace(/[.,;:!?)\]'"]+$/, '');
          const trimmed = rawUrl.length - url.length;
          result += escapeHTML(line.slice(last, match.index));
          result += `<a href="${escapeHTML(url)}">${escapeHTML(url)}</a>`;
          if (trimmed > 0) result += escapeHTML(rawUrl.slice(-trimmed));
          last = match.index + rawUrl.length;
        }
        result += escapeHTML(line.slice(last));
        return result;
      }).join('<br>');
    },
  };

  /* ============================================================
     EDITOR — contenteditable wrapper
     ============================================================ */
  const EDITOR = {
    el: null,

    mount(el) {
      EDITOR.el = el;

      el.addEventListener('input', () => {
        // Normalize: if only a lone <br> remains, empty the editor so
        // the CSS :empty::before placeholder shows correctly.
        if (el.innerHTML === '<br>') {
          el.innerHTML = '';
        }
        STORAGE.scheduleSave();
      });

      el.addEventListener('keydown', (e) => {
        // Tab key → insert spaces instead of losing focus
        if (e.key === 'Tab') {
          e.preventDefault();
          document.execCommand('insertText', false, '    ');
        }
        // Ctrl/Cmd+B, I, U shortcuts for accessibility
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
          if (e.key === 'b') { e.preventDefault(); document.execCommand('bold'); }
          if (e.key === 'i') { e.preventDefault(); document.execCommand('italic'); }
          if (e.key === 'u') { e.preventDefault(); document.execCommand('underline'); }
        }
        // Auto-linkify the word before the caret when a word boundary is typed
        if (e.key === ' ' || e.key === 'Enter') {
          LINKS.tryAutoLinkBeforeCaret();
        }
      });

      // Linkify URLs in pasted plain text
      el.addEventListener('paste', (e) => {
        const htmlData = e.clipboardData.getData('text/html');
        const text = e.clipboardData.getData('text/plain');
        // If clipboard already carries linked HTML, let the browser handle it
        if (htmlData && /<a[\s>]/i.test(htmlData)) return;
        if (!text || !/https?:\/\//i.test(text)) return;
        e.preventDefault();
        const html = LINKS.linkifyPlainText(text);
        document.execCommand('insertHTML', false, html);
        STORAGE.scheduleSave();
      });
    },

    getHTML() {
      if (!EDITOR.el) return '';
      const html = EDITOR.el.innerHTML;
      return (html === '<br>') ? '' : html;
    },

    setHTML(html) {
      if (!EDITOR.el) return;
      EDITOR.el.innerHTML = html || '';
    },

    focus() {
      if (!EDITOR.el) return;
      EDITOR.el.focus();
      // Place caret at end
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(EDITOR.el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    },
  };

  /* ============================================================
     TOOLBAR — formatting commands
     ============================================================ */
  const TOOLBAR = {
    el: null,

    COMMANDS: [
      { id: 'bold',             label: 'B',  title: 'Bold (Ctrl+B)',    type: 'state' },
      { id: 'italic',           label: 'I',  title: 'Italic (Ctrl+I)',  type: 'state' },
      { id: 'underline',        label: 'U',  title: 'Underline (Ctrl+U)', type: 'state' },
      { id: 'strikeThrough',    label: 'S',  title: 'Strikethrough',    type: 'state' },
      { id: '__sep1__',         label: '',   title: '',                 type: 'sep'   },
      { id: 'h1',               label: 'H1', title: 'Heading 1',        type: 'block', block: 'h1' },
      { id: 'h2',               label: 'H2', title: 'Heading 2',        type: 'block', block: 'h2' },
      { id: '__sep2__',         label: '',   title: '',                 type: 'sep'   },
      { id: 'insertOrderedList',   label: '1.', title: 'Ordered list',  type: 'state' },
      { id: 'insertUnorderedList', label: '•',  title: 'Bullet list',   type: 'state' },
      { id: '__sep3__',         label: '',   title: '',                 type: 'sep'   },
      { id: 'createLink',       label: '🔗', title: 'Insert link',      type: 'link'  },
    ],

    render(el) {
      TOOLBAR.el = el;
      el.innerHTML = '';

      TOOLBAR.COMMANDS.forEach((cmd) => {
        if (cmd.type === 'sep') {
          const sep = document.createElement('div');
          sep.className = 'toolbar-sep';
          sep.setAttribute('role', 'separator');
          el.appendChild(sep);
          return;
        }

        const btn = document.createElement('button');
        btn.className = 'toolbar-btn';
        btn.textContent = cmd.label;
        btn.title = cmd.title;
        btn.setAttribute('aria-label', cmd.title);
        btn.setAttribute('aria-pressed', 'false');

        if (cmd.type === 'state' || cmd.type === 'block') {
          btn.dataset.command = cmd.id === 'h1' || cmd.id === 'h2' ? 'formatBlock' : cmd.id;
        } else {
          btn.dataset.command = cmd.id;
        }
        btn.dataset.cmdId = cmd.id;

        btn.addEventListener('mousedown', (e) => {
          // Prevent editor blur before execCommand
          e.preventDefault();
        });

        btn.addEventListener('click', () => {
          TOOLBAR.onButtonClick(cmd);
          TOOLBAR.updateActiveState();
        });

        el.appendChild(btn);
      });
    },

    onButtonClick(cmd) {
      if (!EDITOR.el) return;
      EDITOR.el.focus();

      if (cmd.type === 'state') {
        document.execCommand(cmd.id, false, null);
      } else if (cmd.type === 'block') {
        // Toggle: if already the requested block, revert to paragraph
        const current = document.queryCommandValue('formatBlock').toLowerCase();
        const target = cmd.block; // 'h1' or 'h2'
        if (current === target) {
          document.execCommand('formatBlock', false, 'p');
        } else {
          document.execCommand('formatBlock', false, target);
        }
      } else if (cmd.type === 'link') {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          // No selection — just focus editor
          return;
        }
        const url = prompt('Enter URL:', 'https://');
        if (url && url !== 'https://') {
          document.execCommand('createLink', false, url);
        }
      }

      STORAGE.scheduleSave();
    },

    updateActiveState() {
      if (!TOOLBAR.el) return;

      TOOLBAR.COMMANDS.forEach((cmd) => {
        if (cmd.type === 'sep') return;
        const btn = TOOLBAR.el.querySelector(`[data-cmd-id="${cmd.id}"]`);
        if (!btn) return;

        let isActive = false;

        try {
          if (cmd.type === 'state') {
            isActive = document.queryCommandState(cmd.id);
          } else if (cmd.type === 'block') {
            const current = document.queryCommandValue('formatBlock').toLowerCase();
            isActive = (current === cmd.block);
          }
        } catch (_) {
          isActive = false;
        }

        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    },
  };

  /* ============================================================
     TABS — render, create, delete, rename, switch
     ============================================================ */
  const TABS = {
    listEl: null,

    render(listEl) {
      TABS.listEl = listEl;
      TABS.redraw();
    },

    redraw() {
      const el = TABS.listEl;
      if (!el) return;

      el.innerHTML = '';

      STATE.tabs.forEach((tab) => {
        const item = document.createElement('div');
        item.className = 'tab-item' + (tab.id === STATE.activeTabId ? ' is-active' : '');
        item.setAttribute('role', 'tab');
        item.setAttribute('aria-selected', tab.id === STATE.activeTabId ? 'true' : 'false');
        item.dataset.tabId = tab.id;

        // Label
        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = tab.name;
        label.title = tab.name;

        // Delete button (hidden via CSS when only 1 tab)
        const delBtn = document.createElement('button');
        delBtn.className = 'tab-delete-btn';
        delBtn.title = 'Close tab';
        delBtn.setAttribute('aria-label', `Close tab ${tab.name}`);
        if (STATE.tabs.length <= 1) {
          delBtn.disabled = true;
        }
        delBtn.innerHTML =
          '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
          '<path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
          '</svg>';

        item.appendChild(label);
        item.appendChild(delBtn);
        el.appendChild(item);

        // Click on tab → switch
        item.addEventListener('click', (e) => {
          if (e.target === delBtn || delBtn.contains(e.target)) return;
          TABS.switchTo(tab.id);
        });

        // Double-click label → rename
        label.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          TABS.startRename(tab.id, item, label);
        });

        // Delete button click
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          TABS.deleteTab(tab.id);
        });
      });
    },

    startRename(tabId, itemEl, labelEl) {
      if (itemEl.classList.contains('tab-item--rename')) return; // already renaming

      itemEl.classList.add('tab-item--rename');

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tab-rename-input';

      const tab = STATE.tabs.find((t) => t.id === tabId);
      input.value = tab ? tab.name : '';

      itemEl.insertBefore(input, labelEl);
      input.select();

      let committed = false;

      const commit = () => {
        if (committed) return;
        committed = true;
        const newName = input.value.trim();
        if (newName && tab) {
          tab.name = newName;
          tab.updatedAt = Date.now();
          STORAGE.scheduleSave();
        }
        itemEl.classList.remove('tab-item--rename');
        if (input.parentNode) input.parentNode.removeChild(input);
        TABS.redraw();
      };

      const cancel = () => {
        if (committed) return;
        committed = true;
        itemEl.classList.remove('tab-item--rename');
        if (input.parentNode) input.parentNode.removeChild(input);
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', commit); cancel(); }
      });
    },

    switchTo(tabId, skipSave = false) {
      if (tabId === STATE.activeTabId) return;

      // Save current tab content
      if (!skipSave) {
        const currentTab = STATE.tabs.find((t) => t.id === STATE.activeTabId);
        if (currentTab) {
          currentTab.content = EDITOR.getHTML();
          currentTab.updatedAt = Date.now();
        }
      }

      STATE.activeTabId = tabId;

      // Fade transition
      EDITOR.el.classList.add('is-switching');
      requestAnimationFrame(() => {
        const newTab = STATE.tabs.find((t) => t.id === tabId);
        EDITOR.setHTML(newTab ? newTab.content : '');
        EDITOR.el.classList.remove('is-switching');
        TABS.redraw();
        STORAGE.scheduleSave();

        // Scroll active tab into view
        const activeEl = TABS.listEl && TABS.listEl.querySelector('.tab-item.is-active');
        if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    },

    createTab() {
      // Save current before creating
      const currentTab = STATE.tabs.find((t) => t.id === STATE.activeTabId);
      if (currentTab) {
        currentTab.content = EDITOR.getHTML();
        currentTab.updatedAt = Date.now();
      }

      const now = Date.now();
      const newTab = {
        id: 'tab-' + now,
        name: 'Note ' + (STATE.tabs.length + 1),
        content: '',
        createdAt: now,
        updatedAt: now,
      };

      STATE.tabs.push(newTab);
      TABS.switchTo(newTab.id, true);

      // Scroll to new tab
      requestAnimationFrame(() => {
        const activeEl = TABS.listEl && TABS.listEl.querySelector('.tab-item.is-active');
        if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'end' });
        EDITOR.focus();
      });
    },

    deleteTab(tabId) {
      if (STATE.tabs.length <= 1) return; // shouldn't happen (button disabled), guard anyway

      const idx = STATE.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;

      const tab = STATE.tabs[idx];
      if (!confirm(`Delete "${tab.name}"?`)) return;

      STATE.tabs.splice(idx, 1);

      // Switch to nearest neighbor
      if (STATE.activeTabId === tabId) {
        const neighborIdx = Math.min(idx, STATE.tabs.length - 1);
        STATE.activeTabId = STATE.tabs[neighborIdx].id;
        EDITOR.setHTML(STATE.tabs[neighborIdx].content);
      }

      TABS.redraw();
      STORAGE.scheduleSave();
    },
  };

  /* ============================================================
     init — bootstrap everything on DOMContentLoaded
     ============================================================ */
  async function init() {
    const tabListEl  = document.getElementById('tab-list');
    const tabAddBtn  = document.getElementById('tab-add-btn');
    const toolbarEl  = document.getElementById('toolbar');
    const editorEl   = document.getElementById('editor');

    // Mount editor
    EDITOR.mount(editorEl);

    // Mount toolbar
    TOOLBAR.render(toolbarEl);

    // Mount link button
    LINKS.init(editorEl, document.getElementById('app'));

    // Selection change → update toolbar active state
    document.addEventListener('selectionchange', () => {
      // Only update when editor has focus
      if (document.activeElement === editorEl) {
        TOOLBAR.updateActiveState();
      }
    });

    // Load persisted data
    let stored = await STORAGE.load();

    if (stored && stored.tabs && stored.tabs.length > 0) {
      STATE.tabs = stored.tabs;
      STATE.activeTabId = stored.activeTabId;

      // Validate activeTabId exists
      if (!STATE.tabs.find((t) => t.id === STATE.activeTabId)) {
        STATE.activeTabId = STATE.tabs[0].id;
      }
    } else {
      // First run — create default tab
      const now = Date.now();
      const defaultTab = {
        id: 'tab-' + now,
        name: 'Note 1',
        content: '',
        createdAt: now,
        updatedAt: now,
      };
      STATE.tabs = [defaultTab];
      STATE.activeTabId = defaultTab.id;
    }

    // Set editor content
    const activeTab = STATE.tabs.find((t) => t.id === STATE.activeTabId);
    EDITOR.setHTML(activeTab ? activeTab.content : '');

    // Render tabs
    TABS.render(tabListEl);

    // Add tab button
    tabAddBtn.addEventListener('click', () => {
      TABS.createTab();
    });

    // Flush immediately when popup is hidden (tab close / window switch)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        STORAGE.flush();
      }
    });

    // Focus editor on load
    requestAnimationFrame(() => EDITOR.focus());
  }

  document.addEventListener('DOMContentLoaded', init);
})();
