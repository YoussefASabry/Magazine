/**
 * Small shared browser helpers. No build step.
 */

const Utils = {
  escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  escapeAttr(value) {
    return this.escapeHtml(value);
  },

  sanitize(html) {
    const input = String(html ?? '');
    if (window.DOMPurify) {
      return window.DOMPurify.sanitize(input, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
        FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload']
      });
    }
    return this.escapeHtml(input).replace(/\n/g, '<br>');
  },

  slugify(value) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  },

  studentUrl(studentOrName) {
    const student =
      typeof studentOrName === 'string'
        ? window.DataStore?.getStudent(studentOrName)
        : studentOrName;
    if (student?.slug) return `student.html?slug=${encodeURIComponent(student.slug)}`;
    return `student.html?name=${encodeURIComponent(
      typeof studentOrName === 'string' ? studentOrName : studentOrName?.name || ''
    )}`;
  },

  articleUrl(eventOrId) {
    const id = typeof eventOrId === 'string' ? eventOrId : eventOrId?.id || eventOrId?.slug;
    return `article.html?id=${encodeURIComponent(id || '')}`;
  },

  queryParam(name) {
    return new URLSearchParams(window.location.search).get(name) || '';
  },

  youtubeId(value) {
    const input = String(value ?? '').trim();
    if (!input) return '';
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

    try {
      const url = new URL(input);
      const host = url.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
      if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
        if (url.pathname === '/watch') return url.searchParams.get('v') || '';
        const parts = url.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) return parts[1] || '';
      }
    } catch {
      return '';
    }
    return '';
  },

  youtubeEmbedUrl(value) {
    const id = this.youtubeId(value);
    if (!id) return '';
    return `https://www.youtube-nocookie.com/embed/${id}?rel=0&enablejsapi=1`;
  },

  formatDate(value) {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  },

  truncate(value, length = 150) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= length) return text;
    return `${text.slice(0, length - 1).trim()}…`;
  },

  debounce(fn, wait = 200) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  },

  setBusy(element, busy, label = 'Loading…') {
    if (!element) return;
    if (busy) {
      element.dataset.originalHtml = element.innerHTML;
      element.disabled = true;
      element.setAttribute('aria-busy', 'true');
      element.innerHTML = `<span class="spinner" aria-hidden="true"></span>${this.escapeHtml(label)}`;
    } else {
      element.disabled = false;
      element.removeAttribute('aria-busy');
      if (element.dataset.originalHtml) element.innerHTML = element.dataset.originalHtml;
    }
  },

  toast(message, type = 'info') {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const item = document.createElement('div');
    item.className = `toast toast-${type}`;
    item.textContent = message;
    host.appendChild(item);
    setTimeout(() => item.remove(), 3500);
  }
};

window.Utils = Utils;
