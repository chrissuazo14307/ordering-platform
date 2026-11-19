// Shared helpers for all screens
window.APP = {
  config: null,
  async loadConfig() {
    if (!this.config) this.config = await (await fetch('/api/config')).json();
    return this.config;
  },
  money(cents) {
    const c = this.config?.currency || 'USD';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(cents / 100); }
    catch { return (cents / 100).toFixed(2); }
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  },
  time(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; },
  dateTime(iso) { return iso ? new Date(iso).toLocaleString() : ''; },
  minutesSince(iso) { return Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000)); },
  async api(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || data || 'Request failed');
    return data;
  },
  toast(msg, kind = '') {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.className = 'show ' + kind;
    clearTimeout(this._t); this._t = setTimeout(() => (el.className = ''), 3000);
  },
  // Short beep for new orders (no audio files needed)
  beep() {
    try {
      const ctx = this._ctx || (this._ctx = new AudioContext());
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.15;
      o.start(); o.stop(ctx.currentTime + 0.25);
    } catch {}
  },
  statusLabel: {
    pending: 'Awaiting confirmation', confirmed: 'Sent to kitchen', preparing: 'Cooking',
    ready: 'Ready / Invoiced', closed: 'Completed', cancelled: 'Cancelled',
  },
};
