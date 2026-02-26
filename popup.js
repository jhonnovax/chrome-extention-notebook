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

  function deferNonCritical(task) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(task, { timeout: 200 });
      return;
    }
    setTimeout(task, 0);
  }

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
    EDIT_ICON_HIT_WIDTH_PX: 22,
    EDIT_ICON_HIT_HEIGHT_PX: 18,
    EDIT_ICON_TOP_OFFSET_PX: 20,
    PORTAL_TOKEN_RE: /\bPORTAL-[A-Za-z0-9]+\b/g,
    URL_OR_PORTAL_RE: /(https?:\/\/\S+|\bPORTAL-[A-Za-z0-9]+\b)/g,

    init(editorEl) {
      // Open links in a new tab on click
      editorEl.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        if (link) {
          e.preventDefault();

          if (LINKS._isEditIconHit(e, link)) {
            LINKS._editLink(link);
            return;
          }

          const href = link.href;
          if (/^https?:\/\//i.test(href)) chrome.tabs.create({ url: href });
        }
      });
    },

    _isEditIconHit(e, link) {
      if (!(e instanceof MouseEvent)) return false;
      const rect = link.getBoundingClientRect();
      const centerX = rect.left + (rect.width / 2);
      const withinX = Math.abs(e.clientX - centerX) <= (LINKS.EDIT_ICON_HIT_WIDTH_PX / 2);
      const top = rect.top - LINKS.EDIT_ICON_TOP_OFFSET_PX;
      const bottom = top + LINKS.EDIT_ICON_HIT_HEIGHT_PX;
      const withinY = e.clientY >= top && e.clientY <= bottom;
      return withinX && withinY;
    },

    _editLink(link) {
      const currentHref = link.getAttribute('href') || '';
      const nextHref = prompt('Edit URL:', currentHref || 'https://');
      if (!nextHref || !nextHref.trim()) return;

      const cleanedHref = nextHref.trim();
      const oldVisibleText = link.textContent || '';

      link.setAttribute('href', cleanedHref);
      if (oldVisibleText === currentHref || oldVisibleText === link.href) {
        link.textContent = cleanedHref;
      }

      STORAGE.scheduleSave();
      EDITOR.focus();
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
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
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

    buildPortalUrl(token) {
      return `https://on24-inc.atlassian.net/browse/${token}`;
    },

    _linkifyLine(line) {
      let result = '';
      let last = 0;
      let match;
      LINKS.URL_OR_PORTAL_RE.lastIndex = 0;

      while ((match = LINKS.URL_OR_PORTAL_RE.exec(line)) !== null) {
        const rawToken = match[1];
        result += escapeHTML(line.slice(last, match.index));

        if (/^https?:\/\//i.test(rawToken)) {
          const url = rawToken.replace(/[.,;:!?)\]'"]+$/, '');
          const trimmed = rawToken.length - url.length;
          result += `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(url)}</a>`;
          if (trimmed > 0) result += escapeHTML(rawToken.slice(-trimmed));
        } else {
          const portalUrl = LINKS.buildPortalUrl(rawToken);
          result += `<a href="${escapeHTML(portalUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(rawToken)}</a>`;
        }

        last = match.index + rawToken.length;
      }

      result += escapeHTML(line.slice(last));
      return result;
    },

    /** Convert plain text (possibly multi-line) with URLs into linkified HTML. */
    linkifyPlainText(text) {
      const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      return lines.map((line) => LINKS._linkifyLine(line)).join('<br>');
    },

    /** Linkify PORTAL tokens in HTML text nodes, skipping existing anchors. */
    linkifyPortalTokensInHTML(html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;

      const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      let node = walker.nextNode();
      while (node) {
        textNodes.push(node);
        node = walker.nextNode();
      }

      textNodes.forEach((textNode) => {
        const parentEl = textNode.parentElement;
        if (!parentEl || parentEl.closest('a')) return;
        const text = textNode.textContent || '';
        LINKS.PORTAL_TOKEN_RE.lastIndex = 0;
        if (!LINKS.PORTAL_TOKEN_RE.test(text)) return;

        LINKS.PORTAL_TOKEN_RE.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        while ((m = LINKS.PORTAL_TOKEN_RE.exec(text)) !== null) {
          const token = m[0];
          const idx = m.index;
          if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
          const a = document.createElement('a');
          a.href = LINKS.buildPortalUrl(token);
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = token;
          frag.appendChild(a);
          last = idx + token.length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));

        textNode.parentNode.replaceChild(frag, textNode);
      });

      return tpl.innerHTML;
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

      // Keep overlay bounds synced with popup viewport changes.
      window.addEventListener('resize', () => {
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
      if (!img || !IMAGES.overlay || !IMAGES._editorEl) return;
      const r = img.getBoundingClientRect();
      const er = IMAGES._editorEl.getBoundingClientRect();
      const ov = IMAGES.overlay;

      // Keep the overlay constrained to the editor viewport so it never
      // overlaps toolbar/tab UI when the image is partially off-screen.
      const left   = Math.max(r.left, er.left);
      const top    = Math.max(r.top, er.top);
      const right  = Math.min(r.right, er.right);
      const bottom = Math.min(r.bottom, er.bottom);
      const width  = right - left;
      const height = bottom - top;

      if (width <= 0 || height <= 0) {
        ov.style.display = 'none';
        return;
      }

      ov.style.display = 'block';
      ov.style.left   = left + 'px';
      ov.style.top    = top + 'px';
      ov.style.width  = width + 'px';
      ov.style.height = height + 'px';
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
     LIST_REORDER — hover handle + drag-to-reorder list items
     ============================================================ */
  const LIST_REORDER = {
    _editorEl: null,
    _handleEl: null,
    _hoverLi: null,
    _dragLi: null,
    _dragList: null,
    _isDragging: false,
    _didMove: false,
    _isHandleHovered: false,
    _onDragMove: null,
    _onDragUp: null,

    init(editorEl) {
      LIST_REORDER._editorEl = editorEl;
      LIST_REORDER._buildHandle();

      editorEl.addEventListener('mousemove', (e) => {
        if (LIST_REORDER._isDragging) return;
        const li = LIST_REORDER._getSortableLi(e.target);
        if (li !== LIST_REORDER._hoverLi) {
          LIST_REORDER._hoverLi = li;
          LIST_REORDER._repositionHandle();
        }
      });

      editorEl.addEventListener('mouseleave', (e) => {
        if (LIST_REORDER._isDragging) return;
        if (LIST_REORDER._isHandleTarget(e.relatedTarget)) return;
        if (!editorEl.contains(e.relatedTarget)) {
          LIST_REORDER._hoverLi = null;
          LIST_REORDER._hideHandle();
        }
      });

      editorEl.addEventListener('scroll', () => {
        if (!LIST_REORDER._isDragging) LIST_REORDER._repositionHandle();
      });

      window.addEventListener('resize', () => {
        if (!LIST_REORDER._isDragging) LIST_REORDER._repositionHandle();
      });
    },

    _buildHandle() {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-drag-handle';
      btn.setAttribute('aria-label', 'Drag to reorder list item');
      btn.innerHTML =
        '<svg viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
        '<circle cx="3" cy="2" r="1" fill="currentColor"/>' +
        '<circle cx="7" cy="2" r="1" fill="currentColor"/>' +
        '<circle cx="3" cy="5" r="1" fill="currentColor"/>' +
        '<circle cx="7" cy="5" r="1" fill="currentColor"/>' +
        '<circle cx="3" cy="8" r="1" fill="currentColor"/>' +
        '<circle cx="7" cy="8" r="1" fill="currentColor"/>' +
        '</svg>';
      btn.addEventListener('mousedown', (e) => LIST_REORDER._startDrag(e));
      btn.addEventListener('mouseenter', () => {
        LIST_REORDER._isHandleHovered = true;
        LIST_REORDER._handleEl.classList.add('is-visible');
      });
      btn.addEventListener('mouseleave', () => {
        LIST_REORDER._isHandleHovered = false;
        if (!LIST_REORDER._isDragging) {
          LIST_REORDER._hideHandle();
        }
      });
      document.body.appendChild(btn);
      LIST_REORDER._handleEl = btn;
    },

    _isHandleTarget(node) {
      return !!(LIST_REORDER._handleEl && node && (node === LIST_REORDER._handleEl || LIST_REORDER._handleEl.contains(node)));
    },

    _getSortableLi(target) {
      const li = target && target.closest ? target.closest('li') : null;
      if (!li || !LIST_REORDER._editorEl || !LIST_REORDER._editorEl.contains(li)) return null;
      const parent = li.parentElement;
      if (!parent) return null;
      const tag = parent.tagName;
      if (tag !== 'UL' && tag !== 'OL') return null;
      return li;
    },

    _repositionHandle() {
      const li = LIST_REORDER._hoverLi;
      if (!li || !LIST_REORDER._editorEl || !LIST_REORDER._editorEl.contains(li)) {
        LIST_REORDER._hoverLi = null;
        LIST_REORDER._hideHandle();
        return;
      }

      LIST_REORDER._handleEl.classList.add('is-visible');
      const rect = li.getBoundingClientRect();
      const size = 18;
      const top = rect.top + (rect.height - size) / 2;
      const left = rect.left - size - 6;
      LIST_REORDER._handleEl.style.top = Math.round(top) + 'px';
      LIST_REORDER._handleEl.style.left = Math.round(left) + 'px';
    },

    _hideHandle() {
      if (!LIST_REORDER._handleEl) return;
      if (LIST_REORDER._isHandleHovered) return;
      LIST_REORDER._handleEl.classList.remove('is-visible');
    },

    _startDrag(e) {
      const li = LIST_REORDER._hoverLi;
      if (!li) return;
      e.preventDefault();
      e.stopPropagation();

      LIST_REORDER._dragLi = li;
      LIST_REORDER._dragList = li.parentElement;
      LIST_REORDER._isDragging = true;
      LIST_REORDER._didMove = false;

      li.classList.add('is-reordering');
      LIST_REORDER._handleEl.classList.add('is-dragging');
      document.body.classList.add('is-list-dragging');

      LIST_REORDER._onDragMove = (ev) => LIST_REORDER._dragMove(ev);
      LIST_REORDER._onDragUp = (ev) => LIST_REORDER._endDrag(ev);
      document.addEventListener('mousemove', LIST_REORDER._onDragMove);
      document.addEventListener('mouseup', LIST_REORDER._onDragUp);
      LIST_REORDER._dragMove(e);
    },

    _dragMove(e) {
      if (!LIST_REORDER._isDragging || !LIST_REORDER._dragLi || !LIST_REORDER._dragList) return;

      const target = document.elementFromPoint(e.clientX, e.clientY);
      const targetList = LIST_REORDER._getClosestList(target);
      if (
        target &&
        LIST_REORDER._editorEl &&
        LIST_REORDER._editorEl.contains(target) &&
        targetList &&
        // Prevent invalid DOM cycles (cannot move a node into its own descendant list).
        !LIST_REORDER._dragLi.contains(targetList)
      ) {
        const ref = LIST_REORDER._getInsertRefForY(
          targetList,
          e.clientY,
          LIST_REORDER._dragLi
        );
        // No-op if insertion point is unchanged.
        if (ref !== LIST_REORDER._dragLi && ref !== LIST_REORDER._dragLi.nextSibling) {
          const prevParent = LIST_REORDER._dragLi.parentElement;
          const prevNext = LIST_REORDER._dragLi.nextSibling;
          targetList.insertBefore(LIST_REORDER._dragLi, ref);
          LIST_REORDER._dragList = LIST_REORDER._dragLi.parentElement;
          if (LIST_REORDER._dragLi.parentElement !== prevParent || LIST_REORDER._dragLi.nextSibling !== prevNext) {
            LIST_REORDER._didMove = true;
          }
        }
      }

      LIST_REORDER._hoverLi = LIST_REORDER._dragLi;
      LIST_REORDER._repositionHandle();
    },

    _getClosestList(target) {
      if (!target || !target.closest) return null;
      const list = target.closest('ul,ol');
      if (!list) return null;
      const tag = list.tagName;
      return (tag === 'UL' || tag === 'OL') ? list : null;
    },

    _getInsertRefForY(listEl, clientY, skipLi) {
      if (!listEl) return null;
      const items = Array.from(listEl.children).filter((el) => el.tagName === 'LI' && el !== skipLi);
      for (const li of items) {
        const rect = li.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) return li;
      }
      return null;
    },

    _endDrag(e) {
      if (!LIST_REORDER._isDragging) return;

      document.removeEventListener('mousemove', LIST_REORDER._onDragMove);
      document.removeEventListener('mouseup', LIST_REORDER._onDragUp);
      LIST_REORDER._onDragMove = null;
      LIST_REORDER._onDragUp = null;

      if (LIST_REORDER._dragLi) {
        LIST_REORDER._dragLi.classList.remove('is-reordering');
      }
      LIST_REORDER._handleEl.classList.remove('is-dragging');
      document.body.classList.remove('is-list-dragging');
      LIST_REORDER._isHandleHovered = false;

      const moved = LIST_REORDER._didMove;
      LIST_REORDER._isDragging = false;
      LIST_REORDER._dragLi = null;
      LIST_REORDER._dragList = null;
      LIST_REORDER._didMove = false;

      const target = document.elementFromPoint(e.clientX, e.clientY);
      LIST_REORDER._hoverLi = LIST_REORDER._getSortableLi(target);
      LIST_REORDER._repositionHandle();

      if (moved) {
        TOOLBAR.updateClearState();
        STORAGE.scheduleSave();
      }
    },
  };

  /* ============================================================
     EDITOR — contenteditable wrapper
     ============================================================ */
  const EDITOR = {
    el: null,

    _stripFontStyleDecls(styleText) {
      if (!styleText) return '';
      const parts = styleText
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean);

      const kept = parts.filter((part) => {
        const idx = part.indexOf(':');
        if (idx === -1) return false;
        const prop = part.slice(0, idx).trim().toLowerCase();
        return prop !== 'font-family' && prop !== 'font-size' && prop !== 'font';
      });

      return kept.join('; ');
    },

    sanitizePastedHTML(html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;

      tpl.content.querySelectorAll('*').forEach((node) => {
        // Remove app-specific metadata attributes from pasted HTML (e.g. Teams).
        Array.from(node.attributes || []).forEach((attr) => {
          if (attr && attr.name && attr.name.toLowerCase().startsWith('data-')) {
            node.removeAttribute(attr.name);
          }
        });

        const style = node.getAttribute('style');
        if (style != null) {
          const sanitizedStyle = EDITOR._stripFontStyleDecls(style);
          if (sanitizedStyle) node.setAttribute('style', sanitizedStyle);
          else node.removeAttribute('style');
        }

        // Remove deprecated font-tag attributes that can override editor defaults.
        if (node.tagName === 'FONT') {
          node.removeAttribute('face');
          node.removeAttribute('size');
          node.removeAttribute('color');
        }
      });

      // Unwrap single top-level span wrappers often added by clipboard sources.
      // They can carry no semantic value and may create inconsistent layout.
      while (
        tpl.content.childNodes.length === 1 &&
        tpl.content.firstChild &&
        tpl.content.firstChild.nodeType === Node.ELEMENT_NODE &&
        tpl.content.firstChild.tagName === 'SPAN'
      ) {
        const wrapper = tpl.content.firstChild;
        const frag = document.createDocumentFragment();
        while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
        tpl.content.replaceChildren(frag);
      }

      return tpl.innerHTML;
    },

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

      // Keep rich pasted content, but strip font-size/font-family overrides.
      el.addEventListener('paste', (e) => {
        const htmlData = (e.clipboardData && e.clipboardData.getData('text/html')) || '';
        const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';

        if (htmlData) {
          e.preventDefault();
          const sanitized = EDITOR.sanitizePastedHTML(htmlData);
          const linkified = LINKS.linkifyPortalTokensInHTML(sanitized);
          document.execCommand('insertHTML', false, linkified);
          STORAGE.scheduleSave();
          return;
        }

        if (text && (/(https?:\/\/|PORTAL-[A-Za-z0-9]+)/i.test(text))) {
          e.preventDefault();
          const html = LINKS.linkifyPlainText(text);
          document.execCommand('insertHTML', false, html);
          STORAGE.scheduleSave();
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
      EDITOR.normalizeHighlightColorsToTheme();
      TOOLBAR.updateClearState();
    },

    normalizeHighlightColorsToTheme() {
      if (!EDITOR.el || !document.body) return;
      const lookup = TOOLBAR.getKnownHighlightColorLookup();
      if (!Object.keys(lookup).length) return;

      const nodes = EDITOR.el.querySelectorAll('[style]');
      nodes.forEach((node) => {
        const bgColor = (node.style && node.style.backgroundColor) ? node.style.backgroundColor.trim() : '';
        const bg = bgColor || ((node.style && node.style.background) ? node.style.background.trim() : '');
        if (!bg) return;

        const canonical = TOOLBAR._toCanonicalColor(bg);
        const key = canonical ? lookup[canonical] : '';
        if (!key) return;

        node.style.backgroundColor = TOOLBAR.getThemeHighlightColorByKey(key);
      });
    },

    focus(placeCaretAtEnd = true) {
      if (!EDITOR.el) return;
      EDITOR.el.focus({ preventScroll: true });
      if (!placeCaretAtEnd) return;
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
      { id: 'undo', label: '', title: 'Undo (Ctrl/Cmd+Z)', type: 'state',
        icon:
          '<svg width="15" height="13" viewBox="0 0 15 13" fill="none" aria-hidden="true">' +
          '<path d="M5.1 3.1L2.1 6.1L5.1 9.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<path d="M2.4 6.1H8.6C10.8 6.1 12.5 7.8 12.5 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '</svg>' },
      { id: 'redo', label: '', title: 'Redo (Ctrl/Cmd+Shift+Z)', type: 'state',
        icon:
          '<svg width="15" height="13" viewBox="0 0 15 13" fill="none" aria-hidden="true">' +
          '<path d="M9.9 3.1L12.9 6.1L9.9 9.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<path d="M12.6 6.1H6.4C4.2 6.1 2.5 7.8 2.5 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '</svg>' },
      { id: '__sep1__',         label: '',   title: '',                 type: 'sep'   },
      { id: 'bold',             label: 'B',  title: 'Bold (Ctrl+B)',    type: 'state' },
      { id: 'italic',           label: 'I',  title: 'Italic (Ctrl+I)',  type: 'state' },
      { id: 'underline',        label: 'U',  title: 'Underline (Ctrl+U)', type: 'state' },
      { id: 'strikeThrough',    label: 'S',  title: 'Strikethrough',    type: 'state' },
      { id: 'highlightMenu',    label: '',   title: 'Highlight options', type: 'highlight-menu',
        options: [
          { id: 'hlClear',  title: 'Remove color', type: 'highlight-clear' },
          { id: 'hlYellow', title: 'Highlight yellow', type: 'highlight', key: 'yellow', colorVar: '--highlight-yellow' },
          { id: 'hlGreen',  title: 'Highlight green',  type: 'highlight', key: 'green', colorVar: '--highlight-green' },
          { id: 'hlRed',    title: 'Highlight red',    type: 'highlight', key: 'red', colorVar: '--highlight-red' },
        ],
      },
      { id: 'createLink',       label: '🔗', title: 'Insert link',      type: 'link'  },
      { id: 'stripSelectionHtml', label: '', title: 'Remove format',    type: 'plain-text',
        icon: '<span aria-hidden="true">T<span style="color:var(--color-danger);font-size:9px;">X</span></span>' },
      { id: 'h1',               label: 'H1', title: 'Heading 1',        type: 'block', block: 'h1' },
      { id: 'h2',               label: 'H2', title: 'Heading 2',        type: 'block', block: 'h2' },
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
      { id: 'outdent', label: '', title: 'Outdent', type: 'state',
        icon:
          '<svg width="15" height="13" viewBox="0 0 15 13" fill="none" aria-hidden="true">' +
          '<path d="M6 2.5h8M6 5h8M6 7.5h8M6 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
          '<path d="M1.8 6.5L4.6 4.8V8.2L1.8 6.5Z" fill="currentColor"/>' +
          '</svg>' },
      { id: 'indent', label: '', title: 'Indent', type: 'state',
        icon:
          '<svg width="15" height="13" viewBox="0 0 15 13" fill="none" aria-hidden="true">' +
          '<path d="M1 2.5h8M1 5h8M1 7.5h8M1 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
          '<path d="M13.2 6.5L10.4 4.8V8.2L13.2 6.5Z" fill="currentColor"/>' +
          '</svg>' },
      { id: 'insertHorizontalRule', label: '', title: 'Horizontal rule', type: 'state',
        icon:
          '<svg width="15" height="11" viewBox="0 0 15 11" fill="none" aria-hidden="true">' +
          '<path d="M1 5.5H14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
          '</svg>' },
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
          trigger.innerHTML = '<span class="toolbar-highlight-glyph" aria-hidden="true">A</span>';
          trigger.addEventListener('mousedown', (e) => e.preventDefault());
          trigger.addEventListener('click', () => {
            TOOLBAR.toggleHighlightMenu();
          });

          const menu = document.createElement('div');
          menu.className = 'toolbar-dropdown-menu';
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-label', 'Highlight options');

          const colorRow = document.createElement('div');
          colorRow.className = 'toolbar-dropdown-colors';

          cmd.options.forEach((opt) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'toolbar-dropdown-item';
            item.setAttribute('role', 'menuitem');
            item.title = opt.title;
            item.dataset.cmdId = opt.id;

            if (opt.type === 'highlight-clear') {
              item.classList.add('toolbar-dropdown-item--remove');
              item.innerHTML =
                '<span class="toolbar-dropdown-item__icon" aria-hidden="true">' +
                  '<svg width="18" height="18" viewBox="0 0 18 18" fill="none">' +
                    '<path d="M8.4 3.2a1.2 1.2 0 011.7 0l4.7 4.7a1.2 1.2 0 010 1.7l-2.7 2.7-6.4-6.4z" fill="#111111"/>' +
                    '<path d="M2.6 9l2.7-2.7 6.4 6.4L9 15.4a1.2 1.2 0 01-1.7 0L2.6 10.7a1.2 1.2 0 010-1.7z" fill="#ffffff"/>' +
                    '<path d="M5.3 6.3l6.4 6.4M8.4 3.2a1.2 1.2 0 011.7 0l4.7 4.7a1.2 1.2 0 010 1.7L9 15.4a1.2 1.2 0 01-1.7 0L2.6 10.7a1.2 1.2 0 010-1.7L8.4 3.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
                  '</svg>' +
                '</span>' +
                '<span class="toolbar-dropdown-item__label">Remove color</span>';
            } else {
              item.classList.add('toolbar-dropdown-item--color');
              item.setAttribute('aria-label', opt.title);
              item.innerHTML =
                '<span class="toolbar-dropdown-item__swatch" style="background:var(' + opt.colorVar + ');"></span>';
            }

            item.addEventListener('mousedown', (e) => e.preventDefault());
            item.addEventListener('click', () => {
              TOOLBAR.onButtonClick(opt);
              TOOLBAR.closeHighlightMenu();
            });

            if (opt.type === 'highlight-clear') {
              menu.appendChild(item);
            } else {
              colorRow.appendChild(item);
            }
          });

          menu.appendChild(colorRow);
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
        document.execCommand('hiliteColor', false, TOOLBAR.getThemeHighlightColor(cmd.colorVar));
        EDITOR.normalizeHighlightColorsToTheme();
      } else if (cmd.type === 'highlight-clear') {
        document.execCommand('hiliteColor', false, 'transparent');
        EDITOR.normalizeHighlightColorsToTheme();
      } else if (cmd.type === 'action') {
        if (cmd.action) cmd.action();
        return; // scheduleSave handled inside action if needed
      } else if (cmd.type === 'plain-text') {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        if (!EDITOR.el.contains(range.commonAncestorContainer)) return;

        const fragment = range.cloneContents();
        const container = document.createElement('div');
        container.appendChild(fragment);
        const plainText = (container.textContent || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const html = escapeHTML(plainText).replace(/\n/g, '<br>');
        document.execCommand('insertHTML', false, html);
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

    getThemeHighlightColor(colorVar) {
      if (!colorVar) return '#fde68a';
      const value = getComputedStyle(document.documentElement).getPropertyValue(colorVar).trim();
      return value || '#fde68a';
    },

    getThemeHighlightColorByKey(key) {
      if (key === 'yellow') return TOOLBAR.getThemeHighlightColor('--highlight-yellow');
      if (key === 'green') return TOOLBAR.getThemeHighlightColor('--highlight-green');
      if (key === 'red') return TOOLBAR.getThemeHighlightColor('--highlight-red');
      return '#fde68a';
    },

    _toCanonicalColor(value) {
      if (!value) return '';
      const probe = document.createElement('span');
      probe.style.color = '';
      probe.style.color = value;
      if (!probe.style.color) return '';
      document.body.appendChild(probe);
      const canonical = getComputedStyle(probe).color.replace(/\s+/g, '').toLowerCase();
      probe.remove();
      return canonical;
    },

    getKnownHighlightColorLookup() {
      const entries = [
        ['yellow', '#fde68a'],
        ['yellow', '#a16207'],
        ['green', '#bbf7d0'],
        ['green', '#166534'],
        ['red', '#fecaca'],
        ['red', '#991b1b'],
      ];
      const map = {};
      entries.forEach(([key, color]) => {
        const canonical = TOOLBAR._toCanonicalColor(color);
        if (canonical) map[canonical] = key;
      });
      return map;
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
    _dragTabId: null,
    _dropTabId: null,
    _dropPos: null,
    _didDrag: false,
    _textMeasureCanvas: null,

    render(listEl) {
      TABS.listEl = listEl;
      TABS.redraw();
    },

    redraw() {
      const el = TABS.listEl;
      if (!el) return;

      const frag = document.createDocumentFragment();

      STATE.tabs.forEach((tab) => {
        const item = document.createElement('div');
        item.className = 'tab-item' + (tab.id === STATE.activeTabId ? ' is-active' : '');
        item.setAttribute('role', 'tab');
        item.setAttribute('aria-selected', tab.id === STATE.activeTabId ? 'true' : 'false');
        item.setAttribute('tabindex', '0');
        item.dataset.tabId = tab.id;
        item.draggable = true;

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
        frag.appendChild(item);

        // Click on tab → switch
        item.addEventListener('click', (e) => {
          if (TABS._didDrag) {
            TABS._didDrag = false;
            return;
          }
          if (e.target === delBtn || delBtn.contains(e.target)) return;
          TABS.switchTo(tab.id);
        });

        // Double-click label → rename
        label.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          TABS.startRename(tab.id, item, label);
        });

        // Keyboard: Space → activate, Enter → rename, ArrowLeft/Right → move focus between tabs
        item.addEventListener('keydown', (e) => {
          // Let caret navigation work inside rename input without tab-level shortcuts.
          if (item.classList.contains('tab-item--rename') || (e.target && e.target.classList && e.target.classList.contains('tab-rename-input'))) {
            return;
          }

          if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            TABS.switchTo(tab.id);
          } else if (e.key === 'Enter') {
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

        // Drag-and-drop reorder
        item.addEventListener('dragstart', (e) => TABS.onDragStart(e, tab.id, delBtn));
        item.addEventListener('dragover', (e) => TABS.onDragOver(e, tab.id));
        item.addEventListener('drop', (e) => TABS.onDrop(e, tab.id));
        item.addEventListener('dragend', () => TABS.clearDragState());
      });

      el.replaceChildren(frag);
    },

    onDragStart(e, tabId, delBtn) {
      if (!e.dataTransfer) return;
      if (e.target === delBtn || delBtn.contains(e.target)) {
        e.preventDefault();
        return;
      }
      TABS._dragTabId = tabId;
      TABS._dropTabId = null;
      TABS._dropPos = null;
      TABS._didDrag = false;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabId);
      if (e.currentTarget && e.currentTarget.classList) {
        e.currentTarget.classList.add('is-dragging');
      }
    },

    onDragOver(e, tabId) {
      if (!TABS._dragTabId || TABS._dragTabId === tabId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

      const rect = e.currentTarget.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const pos = e.clientX < midpoint ? 'before' : 'after';

      if (TABS._dropTabId !== tabId || TABS._dropPos !== pos) {
        TABS._dropTabId = tabId;
        TABS._dropPos = pos;
        TABS.applyDropClasses();
      }
    },

    onDrop(e, tabId) {
      if (!TABS._dragTabId || TABS._dragTabId === tabId) return;
      e.preventDefault();

      const fromIdx = STATE.tabs.findIndex((t) => t.id === TABS._dragTabId);
      const targetIdx = STATE.tabs.findIndex((t) => t.id === tabId);
      if (fromIdx === -1 || targetIdx === -1) {
        TABS.clearDragState();
        return;
      }

      let toIdx = targetIdx + (TABS._dropPos === 'after' ? 1 : 0);
      const [moved] = STATE.tabs.splice(fromIdx, 1);
      if (fromIdx < toIdx) toIdx -= 1;
      STATE.tabs.splice(toIdx, 0, moved);

      TABS._didDrag = true;
      TABS.redraw();
      STORAGE.scheduleSave();
    },

    applyDropClasses() {
      if (!TABS.listEl) return;
      const items = TABS.listEl.querySelectorAll('.tab-item');
      items.forEach((el) => {
        el.classList.remove('tab-item--drop-before', 'tab-item--drop-after');
        if (!TABS._dropTabId || el.dataset.tabId !== TABS._dropTabId) return;
        if (TABS._dropPos === 'before') el.classList.add('tab-item--drop-before');
        if (TABS._dropPos === 'after') el.classList.add('tab-item--drop-after');
      });
    },

    clearDragState() {
      TABS._dragTabId = null;
      TABS._dropTabId = null;
      TABS._dropPos = null;
      if (!TABS.listEl) return;
      const items = TABS.listEl.querySelectorAll('.tab-item');
      items.forEach((el) => {
        el.classList.remove('is-dragging', 'tab-item--drop-before', 'tab-item--drop-after');
      });
    },

    autosizeRenameInput(input, itemEl) {
      if (!input || !itemEl) return;

      if (!TABS._textMeasureCanvas) {
        TABS._textMeasureCanvas = document.createElement('canvas');
      }

      const ctx = TABS._textMeasureCanvas.getContext('2d');
      if (!ctx) return;

      const styles = getComputedStyle(input);
      const font = styles.font || [
        styles.fontStyle,
        styles.fontVariant,
        styles.fontWeight,
        styles.fontSize,
        styles.lineHeight !== 'normal' ? '/' + styles.lineHeight : '',
        styles.fontFamily,
      ].join(' ').trim();
      ctx.font = font;

      const value = input.value || '';
      const textWidth = Math.ceil(ctx.measureText(value || ' ').width);
      const horizontalExtra =
        parseFloat(styles.paddingLeft || '0') +
        parseFloat(styles.paddingRight || '0') +
        parseFloat(styles.borderLeftWidth || '0') +
        parseFloat(styles.borderRightWidth || '0') +
        2;

      const minWidth = Math.max(24, Math.ceil(horizontalExtra));
      const maxWidth = Math.max(minWidth, itemEl.clientWidth - 10);
      const desired = Math.min(maxWidth, Math.max(minWidth, textWidth + horizontalExtra));
      input.style.width = desired + 'px';
    },

    startRename(tabId, itemEl, labelEl) {
      if (tabId !== STATE.activeTabId) {
        TABS.switchTo(tabId);

        requestAnimationFrame(() => {
          if (!TABS.listEl) return;
          const nextItem = Array.from(TABS.listEl.querySelectorAll('.tab-item'))
            .find((el) => el.dataset.tabId === tabId);
          const nextLabel = nextItem && nextItem.querySelector('.tab-label');
          if (nextItem && nextLabel) {
            TABS.startRename(tabId, nextItem, nextLabel);
          }
        });

        return;
      }

      if (itemEl.classList.contains('tab-item--rename')) return; // already renaming

      itemEl.classList.add('tab-item--rename');

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tab-rename-input';

      const tab = STATE.tabs.find((t) => t.id === tabId);
      input.value = tab ? tab.name : '';

      itemEl.insertBefore(input, labelEl);
      TABS.autosizeRenameInput(input, itemEl);
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
      input.addEventListener('input', () => TABS.autosizeRenameInput(input, itemEl));
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
    const storedPromise = STORAGE.load();

    // Mount editor
    EDITOR.mount(editorEl);

    // Mount toolbar
    TOOLBAR.render(toolbarEl);

    // Wire up link click-to-open
    LINKS.init(editorEl);

    // Selection change → update toolbar active state
    document.addEventListener('selectionchange', () => {
      // Only update when editor has focus
      if (document.activeElement === editorEl) {
        TOOLBAR.updateActiveState();
      }
    });

    const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    const handleThemeChange = () => {
      EDITOR.normalizeHighlightColorsToTheme();
      STORAGE.scheduleSave();
    };
    if (themeMedia.addEventListener) {
      themeMedia.addEventListener('change', handleThemeChange);
    } else if (themeMedia.addListener) {
      themeMedia.addListener(handleThemeChange);
    }

    // Load persisted data
    let stored = await storedPromise;

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

    // Defer non-essential interaction modules until after initial UI paint.
    deferNonCritical(() => {
      IMAGES.init(editorEl);
      LIST_REORDER.init(editorEl);
    });

    // Focus editor on load without traversing all editor content.
    requestAnimationFrame(() => EDITOR.focus(false));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
