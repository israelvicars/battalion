export const APP_CSS = `
:root {
  color-scheme: light;
  --navy: #0B1F3A;
  --teal: #1E7F86;
  --gold: #F2B705;
  --coral: #E4572E;
  --paper: #F5EDD8;
  --ink: #1A1A1A;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--paper); background-color: var(--navy); background-image: linear-gradient(90deg, rgba(245,237,216,.08) 1px, transparent 1px), linear-gradient(rgba(245,237,216,.08) 1px, transparent 1px); background-size: 32px 32px; }
a { color: var(--gold); text-underline-offset: .2em; }
header { background: var(--navy); border-bottom: 4px solid var(--gold); }
.shell { width: min(1160px, calc(100% - 2rem)); margin: 0 auto; }
.mast { display: flex; align-items: center; gap: 1rem; padding: 1.1rem 0 .8rem; }
.brand { color: var(--paper); font-family: Impact, "Arial Narrow Bold", system-ui, sans-serif; font-size: clamp(1.7rem, 5vw, 2.6rem); letter-spacing: .08em; text-decoration: none; }
.brand-mark { width: 2.3rem; height: 2.3rem; flex: 0 0 auto; }
.eyebrow { color: var(--gold); font-size: .72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .14em; }
nav { display: flex; flex-wrap: wrap; gap: .45rem; padding-bottom: 1rem; }
nav a { padding: .5rem .75rem; color: var(--paper); border: 1px dashed var(--teal); text-decoration: none; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
nav a:hover, nav a:focus-visible { color: var(--navy); background: var(--gold); border-color: var(--gold); }
main { padding: 2.2rem 0 4rem; }
h1, h2 { font-family: Impact, "Arial Narrow Bold", system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; }
h1 { display: flex; align-items: center; gap: .75rem; margin: 0 0 .35rem; font-size: clamp(1.8rem, 4vw, 3rem); }
.section-mark { width: 1.7rem; height: 1.7rem; flex: 0 0 auto; }
h2 { margin: 0 0 1rem; font-size: 1rem; }
p { line-height: 1.6; }
.lede { margin: 0 0 2rem; color: var(--paper); opacity: .86; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 1.25rem; }
.card { min-width: 0; padding: 1.1rem; color: var(--ink); border: 3px solid var(--teal); background: var(--paper); box-shadow: 8px 8px 0 var(--teal); }
.card-head { display: flex; justify-content: space-between; gap: 1rem; align-items: start; }
.card h2 { color: var(--navy); }
.poster-head { margin: -1.1rem -1.1rem 1rem; padding: .7rem 1.1rem; color: var(--paper); background: var(--navy); border-bottom: 4px solid var(--gold); }
.poster-head h2 { margin: 0; color: var(--paper); }
.status { display: inline-flex; gap: .45rem; align-items: center; padding: .25rem .45rem; color: var(--navy); background: var(--teal); font-size: .7rem; font-weight: 900; text-transform: uppercase; }
.status.waiting { background: var(--gold); }
.status.blocked { color: var(--paper); background: var(--coral); }
.status input { accent-color: var(--teal); }
.meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .4rem .8rem; margin: 1rem 0 0; font-size: .83rem; }
.meta dt { color: var(--teal); font-weight: 800; text-transform: uppercase; }
.meta dd { margin: 0; overflow-wrap: anywhere; }
.stack { display: grid; gap: 1.1rem; }
.row { display: flex; flex-wrap: wrap; gap: .7rem; align-items: center; justify-content: space-between; }
.badge { display: inline-block; padding: .22rem .45rem; color: var(--navy); background: var(--gold); font-size: .7rem; font-weight: 900; text-transform: uppercase; }
.badge.untrusted { color: var(--paper); background: var(--coral); }
.message { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.message.untrusted { border-left: 4px solid var(--gold); padding-left: .8rem; }
.muted { color: var(--paper); opacity: .72; }
.danger { color: var(--coral); }
pre { margin: .75rem 0 0; padding: .8rem; overflow: auto; color: var(--paper); border: 2px solid var(--teal); background: var(--navy); white-space: pre-wrap; overflow-wrap: anywhere; font: .82rem/1.5 ui-monospace, Menlo, monospace; }
button { border: 3px solid var(--navy); padding: .55rem .8rem; color: var(--navy); background: var(--gold); font: 900 .8rem system-ui, sans-serif; text-transform: uppercase; letter-spacing: .05em; cursor: pointer; }
button.secondary { color: var(--paper); background: var(--teal); }
button.danger { color: var(--paper); border-color: var(--coral); background: var(--coral); }
button:disabled { opacity: .55; cursor: wait; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.stamp { transform: rotate(-2deg); border-radius: 50%; }
.stamp.deny { color: var(--paper); background: var(--coral); }
.flash { min-height: 1.5rem; margin: 0 0 1rem; color: var(--gold); font-weight: 800; }
.route { border-left: 3px dashed var(--gold); padding-left: 1.1rem; }
footer { padding: 1rem 0 2rem; color: var(--paper); opacity: .8; border-top: 1px dashed var(--gold); font-size: .75rem; }
@media (max-width: 560px) { .shell { width: min(100% - 1rem, 1160px); } .mast { align-items: start; flex-wrap: wrap; } }
`;

export const APP_JS = `
const csrf = document.querySelector('meta[name="ttb-csrf"]')?.content ?? '';
const flashText = (message) => { const element = document.querySelector('[data-flash]'); if (element) element.textContent = message; };
document.addEventListener('click', async (event) => {
  const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
  if (!button || button.disabled) return;
  button.disabled = true; flashText('Signal in progress…');
  try {
    const response = await fetch(button.dataset.action, { method: 'POST', headers: { 'X-TTB-CSRF': csrf, 'Accept': 'application/json' }, credentials: 'same-origin' });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error ?? 'Action failed');
    flashText('Signal received.'); location.reload();
  } catch (error) { flashText(error instanceof Error ? error.message : 'Action failed'); button.disabled = false; }
});
const main = document.querySelector('main[data-live="true"]');
if (main) { let polling = false; let interval; const refresh = async () => { if (polling || document.hidden) return; polling = true; try { const response = await fetch(location.pathname + location.search, { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'text/html' } }); if (response.status === 401) { clearInterval(interval); return; } if (!response.ok) return; const html = await response.text(); const next = new DOMParser().parseFromString(html, 'text/html').querySelector('main'); if (!next || next.innerHTML === main.innerHTML) return; const message = document.querySelector('[data-flash]')?.textContent ?? ''; main.innerHTML = next.innerHTML; const nextFlash = main.querySelector('[data-flash]'); if (nextFlash && message) nextFlash.textContent = message; } catch {} finally { polling = false; } }; interval = setInterval(refresh, 2000); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
`;

export const SERVICE_WORKER = `
const CACHE = 'battalion-static-v3';
const STATIC = ['/app.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => { const url = new URL(event.request.url); if (event.request.method !== 'GET' || url.origin !== self.location.origin || !STATIC.includes(url.pathname)) return; event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))); });
`;

export const MANIFEST = JSON.stringify({ name: "Battalion", short_name: "Battalion", description: "Local-first agent mesh control surface", start_url: "/", display: "standalone", background_color: "#0B1F3A", theme_color: "#0B1F3A", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }] });

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Battalion compass wheel"><rect width="128" height="128" rx="18" fill="#0B1F3A"/><g fill="none" stroke="#F2B705" stroke-width="6" stroke-linecap="round"><circle cx="64" cy="64" r="35"/><circle cx="64" cy="64" r="12"/><path d="M64 18v24M64 86v24M18 64h24M86 64h24M38 38l17 17M73 73l17 17M90 38L73 55M55 73L38 90"/></g><path d="m64 20 7 27-7 17-7-17zM108 64l-27 7-17-7 17-7zM64 108l-7-27 7-17 7 17zM20 64l27-7 17 7-17 7z" fill="#1E7F86"/></svg>`;
