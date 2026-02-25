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
     LINKS — URL detection, auto-linkify, click-to-open
     ============================================================ */
  const LINKS = {
    init(editorEl) {
      // Open links in a new tab on click
      editorEl.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        if (link) {
          e.preventDefault();
          const href = link.href;
          if (/^https?:\/\//i.test(href)) chrome.tabs.create({ url: href });
        }
      });
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
     IMAGES — clipboard image paste + hover-to-resize overlay
     ============================================================ */
  const IMAGES = {
    overlay:    null,
    badge:      null,
    handle:     null,
    currentImg: null,
    isDragging: false,
    _drag:      null,  // { startX, startY, startW, startH, ratio }
    _editorEl:  null,

    init(editorEl) {
      IMAGES._editorEl = editorEl;

      // Capture-phase paste: handle images before EDITOR's bubble-phase handler
      editorEl.addEventListener('paste', (e) => {
        const items = e.clipboardData && Array.from(e.clipboardData.items);
        if (!items) return;
        const imageItem = items.find((i) => i.type.startsWith('image/'));
        if (!imageItem) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const blob = imageItem.getAsFile();
        if (!blob) return;

        // Capture caret position before async FileReader
        let savedRange = null;
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0);
          if (editorEl.contains(r.commonAncestorContainer)) {
            savedRange = r.cloneRange();
          }
        }

        const reader = new FileReader();
        reader.onload = (evt) => {
          const img = document.createElement('img');
          img.src = evt.target.result;
          img.onload = () => {
            // Fit within editor content width (padding: 18px × 2 = 36px)
            const maxW = editorEl.clientWidth - 36;
            if (img.naturalWidth > maxW) {
              img.style.width = maxW + 'px';
            }

            if (savedRange && editorEl.contains(savedRange.commonAncestorContainer)) {
              savedRange.deleteContents();
              savedRange.insertNode(img);
              savedRange.setStartAfter(img);
              savedRange.collapse(true);
              const s = window.getSelection();
              s.removeAllRanges();
              s.addRange(savedRange);
            } else {
              editorEl.appendChild(img);
            }
            STORAGE.scheduleSave();
          };
        };
        reader.readAsDataURL(blob);
      }, true /* capture phase */);

      // Build overlay DOM (once)
      IMAGES._buildOverlay(editorEl);

      // Show overlay on image click; hide when clicking non-image content
      editorEl.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG' && editorEl.contains(e.target)) {
          IMAGES.showOverlay(e.target);
        } else if (!IMAGES.isDragging) {
          IMAGES.hideOverlay();
        }
      });

      // Hide when clicking anywhere outside the editor (handle stops propagation itself)
      document.addEventListener('mousedown', (e) => {
        if (!IMAGES.isDragging && !editorEl.contains(e.target) && e.target !== IMAGES.handle) {
          IMAGES.hideOverlay();
        }
      });

      // Reposition overlay on editor scroll
      editorEl.addEventListener('scroll', () => {
        if (IMAGES.currentImg) IMAGES._reposition();
      });
    },

    _buildOverlay(editorEl) {
      const ov = document.createElement('div');
      ov.className = 'img-resize-overlay';
      ov.innerHTML =
        '<div class="img-resize-badge"></div>' +
        '<div class="img-resize-handle"></div>';
      document.body.appendChild(ov);

      IMAGES.overlay = ov;
      IMAGES.badge   = ov.querySelector('.img-resize-badge');
      IMAGES.handle  = ov.querySelector('.img-resize-handle');

      // Drag-to-resize from SE corner handle
      IMAGES.handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const img = IMAGES.currentImg;
        if (!img) return;

        IMAGES.isDragging = true;
        const rect = img.getBoundingClientRect();
        IMAGES._drag = {
          startX: e.clientX,
          startY: e.clientY,
          startW: rect.width,
          startH: rect.height,
          ratio:  rect.height / rect.width,
        };

        const onMove = (ev) => {
          const d = IMAGES._drag;
          const newW = Math.max(20, Math.round(d.startW + (ev.clientX - d.startX)));
          const newH = Math.round(newW * d.ratio);
          img.style.width  = newW + 'px';
          img.style.height = newH + 'px';
          IMAGES._reposition();
          STORAGE.scheduleSave();
        };

        const onUp = () => {
          IMAGES.isDragging = false;
          IMAGES._drag = null;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup',   onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
      });
    },

    _reposition() {
      const img = IMAGES.currentImg;
      if (!img || !IMAGES.overlay) return;
      const r = img.getBoundingClientRect();
      const ov = IMAGES.overlay;
      ov.style.left   = r.left   + 'px';
      ov.style.top    = r.top    + 'px';
      ov.style.width  = r.width  + 'px';
      ov.style.height = r.height + 'px';
      IMAGES.badge.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
    },

    showOverlay(img) {
      IMAGES.currentImg = img;
      IMAGES.overlay.style.display = 'block';
      IMAGES._reposition();
    },

    hideOverlay() {
      if (IMAGES.overlay) IMAGES.overlay.style.display = 'none';
      IMAGES.currentImg = null;
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
        TOOLBAR.updateClearState();
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
      TOOLBAR.updateClearState();
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
    _highlightMenuEl: null,
    _highlightTriggerEl: null,
    _highlightMenuOpen: false,
    _didBindGlobalClose: false,

    COMMANDS: [
      { id: 'bold',             label: 'B',  title: 'Bold (Ctrl+B)',    type: 'state' },
      { id: 'italic',           label: 'I',  title: 'Italic (Ctrl+I)',  type: 'state' },
      { id: 'underline',        label: 'U',  title: 'Underline (Ctrl+U)', type: 'state' },
      { id: 'strikeThrough',    label: 'S',  title: 'Strikethrough',    type: 'state' },
      { id: 'h1',               label: 'H1', title: 'Heading 1',        type: 'block', block: 'h1' },
      { id: 'h2',               label: 'H2', title: 'Heading 2',        type: 'block', block: 'h2' },
      { id: '__sep1__',         label: '',   title: '',                 type: 'sep'   },
      { id: 'insertOrderedList',   label: '', title: 'Ordered list',    type: 'state',
        icon:
          '<svg width="15" height="13" viewBox="0 0 15 13" fill="none" aria-hidden="true">' +
          '<text x="0.5" y="4.5" fill="currentColor" font-size="4.5" font-family="sans-serif" font-weight="700">1</text>' +
          '<text x="0.5" y="8.5" fill="currentColor" font-size="4.5" font-family="sans-serif" font-weight="700">2</text>' +
          '<text x="0.5" y="12.5" fill="currentColor" font-size="4.5" font-family="sans-serif" font-weight="700">3</text>' +
          '<path d="M5.5 2.5h9M5.5 6.5h9M5.5 10.5h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '</svg>' },
      { id: 'insertUnorderedList', label: '', title: 'Bullet list',     type: 'state',
        icon:
          '<svg width="15" height="13" viewBox="0 0 15 13" fill="none" aria-hidden="true">' +
          '<circle cx="1.5" cy="2.5" r="1.5" fill="currentColor"/>' +
          '<circle cx="1.5" cy="6.5" r="1.5" fill="currentColor"/>' +
          '<circle cx="1.5" cy="10.5" r="1.5" fill="currentColor"/>' +
          '<path d="M5.5 2.5h9M5.5 6.5h9M5.5 10.5h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '</svg>' },
      { id: 'insertHorizontalRule', label: '', title: 'Horizontal rule', type: 'state',
        icon:
          '<svg width="15" height="11" viewBox="0 0 15 11" fill="none" aria-hidden="true">' +
          '<path d="M0 2h15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.45"/>' +
          '<path d="M0 5.5h15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
          '<path d="M0 9h15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.45"/>' +
          '</svg>' },
      { id: 'createLink',       label: '🔗', title: 'Insert link',      type: 'link'  },
      {
        id: 'highlightMenu',
        label: '',
        title: 'Highlight options',
        type: 'highlight-menu',
        options: [
          { id: 'hlClear',  title: 'Clear highlight', type: 'highlight-clear' },
          { id: 'hlYellow', title: 'Highlight yellow', type: 'highlight', color: '#fef08a' },
          { id: 'hlGreen',  title: 'Highlight green',  type: 'highlight', color: '#dcfce7' },
          { id: 'hlRed',    title: 'Highlight red',    type: 'highlight', color: '#fee2e2' },
        ],
      },
      { id: '__sep2__',         label: '',   title: '',                 type: 'sep'   },
      { id: 'clearContent',     label: '',   title: 'Clear all content', type: 'action',
        btnClass: 'toolbar-btn--danger',
        icon:
          '<svg width="13" height="14" viewBox="0 0 13 14" fill="none" aria-hidden="true">' +
          '<path d="M4.5 3V2a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
          '<path d="M1 3h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '<path d="M2.5 3v8.5a1 1 0 001 1h6a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
          '<path d="M5 5.5v5M8 5.5v5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.65"/>' +
          '</svg>',
        action() {
          if (!confirm('Clear all content in this note? This cannot be undone.')) return;
          EDITOR.setHTML('');
          STORAGE.scheduleSave();
        },
      },
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

        if (cmd.type === 'highlight-menu') {
          const wrap = document.createElement('div');
          wrap.className = 'toolbar-dropdown';
          wrap.dataset.cmdId = cmd.id;

          const trigger = document.createElement('button');
          trigger.className = 'toolbar-btn toolbar-btn--highlight-trigger';
          trigger.title = cmd.title;
          trigger.setAttribute('aria-label', cmd.title);
          trigger.setAttribute('aria-haspopup', 'menu');
          trigger.setAttribute('aria-expanded', 'false');
          trigger.innerHTML =
            '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">' +
            '<path d="M11.7 2.2l4.1 4.1-6.6 6.6-4.8.7.7-4.8 6.6-6.6z" fill="currentColor" opacity="0.9"/>' +
            '<path d="M10.8 3.1l4.1 4.1" stroke="var(--color-surface)" stroke-width="1.2" stroke-linecap="round"/>' +
            '<path d="M3.5 15h11" stroke="#fef08a" stroke-width="2.4" stroke-linecap="round"/>' +
            '</svg>';
          trigger.addEventListener('mousedown', (e) => e.preventDefault());
          trigger.addEventListener('click', () => {
            TOOLBAR.toggleHighlightMenu();
          });

          const menu = document.createElement('div');
          menu.className = 'toolbar-dropdown-menu';
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-label', 'Highlight options');

          cmd.options.forEach((opt) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'toolbar-dropdown-item';
            item.setAttribute('role', 'menuitem');
            item.title = opt.title;
            item.dataset.cmdId = opt.id;

            if (opt.type === 'highlight-clear') {
              item.innerHTML =
                '<span class="toolbar-dropdown-item__label">Clear highlight</span>';
            } else {
              item.innerHTML =
                '<span class="toolbar-dropdown-item__swatch" style="background:' + opt.color + ';"></span>' +
                '<span class="toolbar-dropdown-item__label">' + opt.title.replace('Highlight ', '') + '</span>';
            }

            item.addEventListener('mousedown', (e) => e.preventDefault());
            item.addEventListener('click', () => {
              TOOLBAR.onButtonClick(opt);
              TOOLBAR.closeHighlightMenu();
            });
            menu.appendChild(item);
          });

          wrap.appendChild(trigger);
          wrap.appendChild(menu);
          el.appendChild(wrap);

          TOOLBAR._highlightMenuEl = menu;
          TOOLBAR._highlightTriggerEl = trigger;
          return;
        }

        const btn = document.createElement('button');
        btn.className = 'toolbar-btn' + (cmd.btnClass ? ' ' + cmd.btnClass : '');
        if (cmd.icon) {
          btn.innerHTML = cmd.icon;
        } else {
          btn.textContent = cmd.label;
        }
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

      if (!TOOLBAR._didBindGlobalClose) {
        TOOLBAR._didBindGlobalClose = true;
        document.addEventListener('mousedown', (e) => {
          if (!TOOLBAR._highlightMenuOpen) return;
          if (!TOOLBAR._highlightMenuEl || !TOOLBAR._highlightTriggerEl) return;
          if (TOOLBAR._highlightMenuEl.contains(e.target)) return;
          if (TOOLBAR._highlightTriggerEl.contains(e.target)) return;
          TOOLBAR.closeHighlightMenu();
        });
      }
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
      } else if (cmd.type === 'highlight') {
        document.execCommand('hiliteColor', false, cmd.color);
      } else if (cmd.type === 'highlight-clear') {
        document.execCommand('hiliteColor', false, 'transparent');
      } else if (cmd.type === 'action') {
        if (cmd.action) cmd.action();
        return; // scheduleSave handled inside action if needed
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
        if (cmd.type === 'sep' || cmd.type === 'highlight' || cmd.type === 'highlight-menu') return;
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

    updateClearState() {
      if (!TOOLBAR.el) return;
      const btn = TOOLBAR.el.querySelector('[data-cmd-id="clearContent"]');
      if (!btn) return;
      btn.disabled = EDITOR.getHTML() === '';
    },

    toggleHighlightMenu() {
      if (!TOOLBAR._highlightMenuEl || !TOOLBAR._highlightTriggerEl) return;
      if (TOOLBAR._highlightMenuOpen) {
        TOOLBAR.closeHighlightMenu();
        return;
      }
      TOOLBAR._highlightMenuOpen = true;
      TOOLBAR._highlightMenuEl.classList.add('is-open');
      TOOLBAR._highlightTriggerEl.setAttribute('aria-expanded', 'true');
    },

    closeHighlightMenu() {
      if (!TOOLBAR._highlightMenuEl || !TOOLBAR._highlightTriggerEl) return;
      TOOLBAR._highlightMenuOpen = false;
      TOOLBAR._highlightMenuEl.classList.remove('is-open');
      TOOLBAR._highlightTriggerEl.setAttribute('aria-expanded', 'false');
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
        item.setAttribute('tabindex', '0');
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
        delBtn.setAttribute('tabindex', '-1');
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

        // Keyboard: Enter → rename, ArrowLeft/Right → move focus between tabs
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            TABS.startRename(tab.id, item, label);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const items = Array.from(TABS.listEl.querySelectorAll('.tab-item'));
            const idx = items.indexOf(item);
            const next = e.key === 'ArrowRight' ? items[idx + 1] : items[idx - 1];
            if (next) next.focus();
          }
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

    // Wire up link click-to-open
    LINKS.init(editorEl);

    // Wire up image paste + resize overlay
    IMAGES.init(editorEl);

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
