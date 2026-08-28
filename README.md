# TSE Tracker

Shared team tracker for RAC Phil TSE — work items, PMS/site rollout status,
hardware inventory (tablets, monitors), AnyDesk ID directory, and the
LakiWin site directory. Built as a static site backed by Supabase.

## Deploy

1. **Database**: open your Supabase project's SQL Editor, paste the contents
   of `schema.sql`, and run it once. This creates all tables and loads the
   existing data.
2. **Frontend config**: in `index.html`, find `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` near the top of the `<script>` block and set them to
   your Supabase project's values (Project Settings → API).
3. **Hosting**: deploy this folder to Vercel (no build step needed — it's a
   static `index.html`).
4. **Team passcode**: the site is gated by a simple shared passcode
   (`TEAM_PASSCODE` constant in `index.html`, default `RACTSE2026`). This is
   a light deterrent, not real security — anyone who reaches the URL and
   knows the passcode can read and write all data. Change the passcode
   before sharing, and consider adding real Supabase Auth later if stronger
   access control is needed.
