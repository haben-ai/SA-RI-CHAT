// Zero-dependency build: injects Supabase settings, inlines the CSS, adds a
// Content-Security-Policy, lightly minifies, versions the service worker and
// writes everything to ./dist.
//
//   node build.mjs           → build
//   node build.mjs --serve   → build, then serve ./dist on http://localhost:8080
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (f) => readFileSync(join(root, f), 'utf8');
const fail = (msg) => { console.error('\n✗ ' + msg + '\n'); process.exit(1); };

// .env (local development only; on Netlify/Vercel use the dashboard's environment variables)
if (existsSync(join(root, '.env'))) {
  for (const line of read('.env').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_ANON_KEY || '';
if (!/^https:\/\/[^/'"\s]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
  fail('SUPABASE_URL is missing or invalid (expected https://YOUR-PROJECT.supabase.co). See .env.example.');
}
if (!/^[A-Za-z0-9._-]{20,}$/.test(key)) fail('SUPABASE_ANON_KEY is missing or invalid. See .env.example.');

// Refuse to ship an admin key to browsers.
if (key.startsWith('sb_secret_')) fail('SUPABASE_ANON_KEY is a SECRET key. Use the anon / publishable key instead.');
if (key.split('.').length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
    if (payload.role !== 'anon') fail(`SUPABASE_ANON_KEY has role "${payload.role}". Use the anon (public) key, never service_role.`);
  } catch { /* not a JWT we can read; fine */ }
}

const origin = new URL(url).origin;
const wsOrigin = origin.replace(/^http/, 'ws');

const minCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,>])\s*/g, '$1').replace(/;}/g, '}').trim();
// Safe for this codebase: no template literals or multi-line strings.
const minJs = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');

const css = minCss(read('styles.css'));
const cssHash = createHash('sha256').update(css).digest('base64');
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  `style-src 'sha256-${cssHash}'`,
  `img-src 'self' blob: ${origin}`,
  `connect-src 'self' ${origin} ${wsOrigin}`,
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const app = minJs(read('app.js').replaceAll('__SUPABASE_URL__', url).replaceAll('__SUPABASE_ANON_KEY__', key));
const html = read('index.html')
  .replaceAll('__CSP__', csp)
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>${css}</style>`)
  .replace(/\n\s*/g, '\n');
const manifest = JSON.stringify(JSON.parse(read('manifest.json')));
const version = createHash('sha256').update(html + app + manifest).digest('hex').slice(0, 12);
const sw = minJs(read('service-worker.js').replaceAll('__VERSION__', version));

const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'icons'), { recursive: true });
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'app.js'), app);
writeFileSync(join(out, 'service-worker.js'), sw);
writeFileSync(join(out, 'manifest.json'), manifest);
for (const f of readdirSync(join(root, 'icons'))) copyFileSync(join(root, 'icons', f), join(out, 'icons', f));

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`✓ Built dist/ (version ${version})`);
console.log(`  index.html ${kb(html)} (CSS inlined)   app.js ${kb(app)}   service-worker.js ${kb(sw)}`);

if (process.argv.includes('--serve')) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
  const port = +(process.env.PORT || 8080);
  createServer((req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (!p || p.endsWith('/') || p.endsWith('\\')) p += 'index.html';
    const file = join(out, p);
    if (!file.startsWith(out) || !existsSync(file)) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(readFileSync(file));
  }).listen(port, () => console.log(`  Serving on http://localhost:${port}`));
}
