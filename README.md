# Target Academy — Learning Platform

All-in-one coaching platform for Target Academy Coaching Centre (TACC),
Manikpur, Gopalganj, Bihar. Students log in from any phone, study notes and
materials, and take timed online tests scored on the server.

## Stack
- Frontend: single-page web app (mobile-first, Hindi + English)
- Backend & database: Supabase (PostgreSQL + Auth + Storage, Row Level Security)
- Hosting: Vercel (free) — code lives in this GitHub repository (public)

## Setup (one time)
1. Supabase: create a project, open SQL Editor, run `supabase/schema.sql`.
2. Supabase Dashboard → Storage: create buckets `materials` (private),
   `notes-files` (private), `images` (public).
3. Copy `.env.example` to `.env` and fill the project URL + anon key.
4. Create the first admin: sign up in the app, then in Supabase Table Editor
   set that user's `profiles.role` to `admin`.

## Security rules (non-negotiable)
- Answer keys live only in `public.questions`, which students cannot read.
- Test questions reach students only via `get_test_questions()` (no answers).
- Marks are computed only by `submit_attempt()` on the server.
- The service-role key is never used in frontend code.

## Status
Phase 1 in progress — schema ready; app modules being built phase by phase.
