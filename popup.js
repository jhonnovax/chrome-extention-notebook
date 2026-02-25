/**
 * Notebook Chrome Extension — popup.js
 * Single IIFE with named module objects: STATE, STORAGE, TABS, EDITOR, TOOLBAR
 */
(function () {
  'use strict';

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
