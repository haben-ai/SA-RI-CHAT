# Private Chat

A tiny private 1-to-1 chat for two people on slow or unreliable connections.
Text first, small compressed photos second. No accounts, no profiles, no tracking.

- **Frontend:** plain HTML + CSS + vanilla JS (no frameworks, no npm dependencies)
- **Backend:** Supabase (Postgres + Row Level Security, Realtime, Storage)
- **Hosting:** any static host — Netlify or Vercel configs included
- **First visit:** ~12.5 KB gzipped in total. **Later visits:** 0 bytes from your host (served by the service worker)

```
index.html          page markup (CSS gets inlined at build time)
styles.css          all styles (CSS variables at the top for easy theming)
app.js              all logic: access, messages, realtime, photos, offline
service-worker.js   caches the app shell only (never messages or photos)
manifest.json       PWA manifest
icons/              192 / 512 px app icons
supabase/schema.sql complete database + security setup (run once)
build.mjs           zero-dependency build: injects env vars → dist/
netlify.toml        Netlify build + headers
vercel.json         Vercel build + headers
.env.example        the two settings you need
```

---

## How it works (architecture)

```
 Phone A ──HTTPS / WSS──►  Supabase  ◄──HTTPS / WSS── Phone B
   │   static files          ├─ Auth (anonymous sign-in → short-lived JWT)
   └── from Netlify/Vercel   ├─ Postgres (messages, RLS, join_room / send_message functions)
       (cached by the        ├─ Realtime (private channel "room:<id>")
        service worker)      └─ Storage (private bucket "chat-photos")
```

1. **Entering the chat.** You type the chat code and choose *Person A* or *Person B*.
   The app silently creates a Supabase **anonymous session**. This needs no email or password,
   and the user never sees it. The app then calls the database function `join_room(code, A|B)`.
   The database compares the code with a **bcrypt hash** stored in `rooms.code_hash`. If it matches,
   this device is added to `room_members`. The code itself is not stored anywhere, not even in the
   database.
2. **Staying signed in.** The session (an access token valid for 1 hour plus a refresh token) is kept
   in `localStorage`, so you don't need to enter the code again. The app refreshes the access
   token automatically.
3. **Reading.** Every table, storage and realtime rule asks one question: *is this session a member
   of this room?* Messages are read with plain REST calls, 30 at a time, newest first.
   "Load older messages" fetches the next 30 (cursor-based on `created_at`).
4. **Sending.** The app gives each message a UUID before sending it, then calls `send_message(...)`.
   The insert is idempotent (`on conflict (id) do nothing`), so retrying a message can never create
   a duplicate.
5. **Realtime.** A database trigger sends every new message to the **private** Realtime channel
   `room:<room_id>`. Only members can subscribe. The app speaks the Realtime WebSocket protocol
   directly in about 80 lines, instead of loading `supabase-js` (~50 KB gzipped).
6. **Photos.** The photo is resized and compressed in the browser into a full image
   (≤1280 px, aiming for ≤300 KB, never more than 1 MB) and a ~10–25 KB thumbnail. Both are uploaded
   to the private `chat-photos` bucket under `<room_id>/`. The message only stores their paths.
   To display photos, the app requests short-lived **signed URLs** in one batched request.

---

## Setup (about 10 minutes, no backend experience needed)

### 1. Create a Supabase project
Go to <https://supabase.com>, create a free project, and wait for it to finish starting.

### 2. Create the database, security rules and storage bucket
1. In the Supabase dashboard open **SQL Editor → New query**.
2. Paste the **entire** contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   It creates the tables, indexes, RLS policies, functions, the realtime trigger and policy,
   and the private storage bucket `chat-photos` with its policies. You can safely run it again.

### 3. Set your chat code
Still in the SQL Editor, run this with **your own** code (at least 10 letters/digits; longer is better):

```sql
select public.set_room_code('Private Chat', 'PUT-YOUR-OWN-LONG-CODE-HERE');
```

- Dashes, spaces and upper/lower case are ignored when people type the code.
- Only the bcrypt hash is stored. Don't save this query anywhere (and never commit it to Git).
- Running it again with a new code **changes** the code (see *Maintenance*).

Good code example: `RIVER-7KQ2-MANGO-93XD` (random words/characters, 16+ chars).

### 4. Enable anonymous sign-ins
**Authentication → Sign In / Providers → "Allow anonymous sign-ins" → enable → Save.**
This is what lets the app work without registration.

*(Recommended)* **Realtime → Settings → turn off "Allow public access"** so only private,
authorized channels can be used on your project.

### 5. Get your two settings
**Project Settings → API Keys** (or **Data API**):

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Project URL, e.g. `https://abcd1234.supabase.co` |
| `SUPABASE_ANON_KEY` | the **public** key: "anon public" (`eyJ…`) or "publishable" (`sb_publishable_…`) |

> ⚠️ **Never** use the `service_role` / `sb_secret_…` key. The build checks the key and refuses to
> run if you give it a secret key.

The anon/publishable key is designed to be public. It is shipped to browsers, and RLS is what
protects the data.

---

## Local development

Requires only [Node.js](https://nodejs.org) 18+ (no `npm install`).

```bash
cp .env.example .env
```

Then fill in the two values in `.env` and run:

```bash
node build.mjs --serve
```

Open <http://localhost:8080>. Each time you change `index.html`, `styles.css` or `app.js`,
run the command again.

Tips:
- To try both people on one computer, open `http://localhost:8080` and `http://127.0.0.1:8080`.
  They are different origins, so each keeps its own session.
- After a rebuild the service worker serves the new version on the **second** reload.
  You can also use DevTools → Application → Service workers → "Update on reload".

---

## Deploy

The build reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from environment variables and writes `dist/`.

### Netlify
1. Push this folder to a Git repository (`.env` and `dist/` are already git-ignored).
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. The build settings are read from `netlify.toml` (`node build.mjs`, publish `dist`).
4. **Site configuration → Environment variables:** add `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
5. Deploy. If you added the variables after the first deploy, use **Trigger deploy → Clear cache and deploy**.

Without Git: run `node build.mjs` locally and drag the `dist/` folder onto
<https://app.netlify.com/drop>.

### Vercel
1. Push to Git → Vercel → **Add New → Project** → import the repo.
2. Framework preset: **Other**. Build settings are read from `vercel.json`.
3. **Settings → Environment Variables:** add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Production + Preview).
4. Deploy (redeploy if you added the variables afterwards).

The site must be served over **HTTPS** (both hosts do this automatically). Service workers and
`crypto.randomUUID` need it.

---

## Using it

1. Open the site → enter the code → choose **Person A** (one of you) or **Person B** (the other) → **Enter chat**.
2. **Enter** sends; **Shift+Enter** adds a new line (desktop).
3. **+ → Photo** sends a compressed photo. Tap a photo to see it larger, then tap again to close.
4. **⋮ menu**
   - **Clear local session:** forget everything on this device.
   - **Leave chat:** also removes this device's access on the server.
5. *Install:* use the browser menu's "Add to Home screen" / "Install app".

Messages you write while offline stay on the device with **"Not sent — Retry"** and are sent
automatically when the connection returns.

---

## Security summary

**The chat code**
- It is never in the frontend code, the repository, or the database. Only a bcrypt hash
  (`rooms.code_hash`) is stored, and that table is not readable by browsers at all.
- It is checked inside Postgres (`join_room`, `SECURITY DEFINER`).
- Guessing is throttled: 5 wrong codes per device per 15 minutes and 50 wrong codes per hour
  overall. Supabase also rate-limits anonymous sign-ins per IP address. With a 16+ character
  random code, brute force is not realistic.

**Messages**
- RLS is on for every table. Browsers have **no** insert, update or delete rights.
- Reads require membership of the room (`is_room_member`). Writes go only through `send_message`,
  which checks membership, validates the content, and sets `sender_id` itself, so a client can't
  pretend to be the other person.
- Nobody (including the two of you) can edit or delete messages from the app.
- Realtime uses a **private** channel. Its RLS policy only lets members subscribe.

**Photos (Storage)**
- The `chat-photos` bucket is **private**, limited to 1 MB per file, and accepts only `image/jpeg`.
- Upload and read are allowed only inside `<your room id>/…`, for members.
  There are no update or delete policies, so photos can't be overwritten.
- Photos are shown through signed URLs that expire after 7 days. These are cached on the device
  so photos aren't downloaded again.
- Re-encoding in the browser **removes EXIF metadata**, including GPS location, before upload.

**Keys**
- Only the public anon/publishable key reaches the browser. `build.mjs` refuses `service_role` or
  secret keys. No database password or admin credential is used by the app.
- `.env` is git-ignored. Only `.env.example` (with no values) is committed.

**Browser hardening**
- A strict Content-Security-Policy is generated at build time. Scripts can load only from your
  site, and the app can connect only to your site and your Supabase project.
- `no-referrer`, `X-Frame-Options: DENY`, `nosniff`, and `noindex` are set.

**What is stored**

| Where | What |
|---|---|
| Supabase `auth.users` | one anonymous user id per device (no email, phone or name) |
| `room_members` | device id → room, "a" or "b" |
| `messages` | text or photo paths, sender ("a"/"b"), server timestamp |
| Storage | the compressed photos and thumbnails |
| Device `localStorage` | session tokens, room id, your letter, the last 50 messages (for instant/offline start), unsent messages, signed photo URLs. All of it is removed by *Clear local session* or *Leave chat*. |

**Intentionally NOT collected:** email, phone, names, profile pictures, contacts, location,
IP-based analytics, read receipts, typing status, presence/"last seen", or any third-party
scripts, fonts, analytics or ads. The app talks only to your host and your Supabase project.

---

## Performance & bandwidth summary

| | Size |
|---|---|
| `index.html` with inlined CSS | 7.6 KB raw / **2.9 KB gzip** |
| `app.js` | 23 KB raw / **8.1 KB gzip** |
| `service-worker.js` + `manifest.json` + icon | ~1.6 KB |
| **First visit total** | **≈ 12.5 KB** in 4–5 requests to your host |
| Later visits | **0 bytes** from your host (cache-first). The browser checks for a new `service-worker.js` (~1 KB, usually a `304`). |

**Opening the chat (returning user):** 1 WebSocket connection (~0.5 KB handshake + join) and 1 small
"what's new since my last message" request (a few hundred bytes when nothing changed). The last 50
messages appear instantly from the device. First open on a new device: one request for the latest
30 messages (~5 KB raw, ~1.5 KB gzipped).

**Text message:** ~150 bytes up + ~300 bytes down (the realtime push), plus HTTP/TLS overhead.
The realtime heartbeat is ~170 bytes every 30 s, only while the app is open.

**Photos:**
- Full image: ≤1280 px. The app tries JPEG quality 0.8 → 0.5, then 1024/800/640 px, until it is
  **≤300 KB**. It refuses anything over 1 MB (the bucket also enforces 1 MB). Small photos are never
  enlarged. In testing, a 7.5 MB 12-megapixel camera photo became **223 KB**.
- Thumbnail: ≤360 px, ~10–25 KB. Thumbnails are the only photo data downloaded automatically, and
  only when scrolled into view (`loading="lazy"`). The full image downloads only when you tap the photo.

**Caching strategy:**
- *Service worker:* caches only the app shell (HTML, JS, manifest, icon), cache-first, versioned per build.
  Supabase requests bypass it completely.
- *Device storage:* the last 50 messages, plus signed photo URLs so the browser's HTTP cache
  can reuse already-downloaded photos (uploaded with `Cache-Control: max-age=1 year`).

**Network behaviour:**
- No polling.
- On connection loss the app retries with backoff (1 → 2 → 5 → 10 → 20 → 30 → 60 s, with jitter),
  and retries immediately when the browser reports it is back `online`.
- A heartbeat that gets no reply closes the dead connection and reconnects.
- After any reconnect the app syncs missed messages (deduplicated by id) and re-sends unsent ones.

---

## Maintenance (SQL Editor)

```sql
-- Change the chat code (devices already inside stay inside):
select public.set_room_code('Private Chat', 'NEW-LONG-CODE');

-- Kick every device out (everyone must enter the code again):
delete from public.room_members
 where room_id = (select id from public.rooms where room_name = 'Private Chat');

-- Delete all messages (then empty the bucket in Storage → chat-photos):
delete from public.messages
 where room_id = (select id from public.rooms where room_name = 'Private Chat');

-- Remove leftover anonymous users that never joined / have left:
delete from auth.users u
 where u.is_anonymous
   and u.created_at < now() - interval '1 day'
   and not exists (select 1 from public.room_members m where m.user_id = u.id);
```

More rooms later: run `set_room_code('Another room', 'ANOTHER-CODE')`. Each room has its own code,
messages, channel and photo folder. The app joins whichever room the code belongs to.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Something went wrong" on the code screen | Anonymous sign-ins not enabled (step 4), or `schema.sql` not run. The browser console shows the HTTP status. |
| Correct code says "incorrect" | Make sure you ran `set_room_code`. Codes need ≥ 6 characters (≥ 10 to create). |
| Stays on "Reconnecting…" while messages still send | Realtime private channel refused. Re-run `schema.sql` (it creates the `realtime.messages` policy). |
| Photos don't appear | Re-run `schema.sql` (it creates the bucket and storage policies). |
| Build fails | Read the message: usually a missing or wrong `SUPABASE_URL` / `SUPABASE_ANON_KEY`. |
| Old version keeps showing | Close and reopen the app twice (a new service worker activates on the next load). |

---

## Limitations (by design)

- Photos that are still uploading are not saved if you close the app mid-upload. Unsent **text** messages are saved.
- No notifications. When the tab is in the background, its title shows the unread count, e.g. "(2) Private Chat".
- No editing or deleting of messages from the app.
- Anyone who has the code can join as A or B. Keep the code long and private.
