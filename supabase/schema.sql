-- ============================================================
-- Target Academy Coaching Centre — Learning Platform
-- Phase 1 database schema (Supabase / PostgreSQL)
-- Run in Supabase SQL Editor AFTER the project is created.
-- Auth: Supabase Auth (auth.users). App roles live in profiles.
-- ============================================================

-- ---------- Roles & profiles ----------
create type public.user_role as enum ('admin','teacher','student','parent');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null default 'student',
  full_name text not null,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Helper: current user's role (used by RLS policies)
create or replace function public.my_role()
returns public.user_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(public.my_role() in ('admin','teacher'), false) $$;

-- ---------- Academic structure ----------
create table public.academic_sessions (
  id bigint generated always as identity primary key,
  name text not null,                       -- e.g. 2026-27
  starts_on date, ends_on date,
  is_current boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.classes (
  id bigint generated always as identity primary key,
  name text not null,                       -- e.g. Class 5
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.batches (
  id bigint generated always as identity primary key,
  class_id bigint not null references public.classes(id) on delete cascade,
  name text not null,                       -- e.g. Morning A
  created_at timestamptz not null default now()
);

create table public.subjects (
  id bigint generated always as identity primary key,
  class_id bigint not null references public.classes(id) on delete cascade,
  name text not null,
  name_hi text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.chapters (
  id bigint generated always as identity primary key,
  subject_id bigint not null references public.subjects(id) on delete cascade,
  name text not null,
  name_hi text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.topics (
  id bigint generated always as identity primary key,
  chapter_id bigint not null references public.chapters(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Which class/batch a student belongs to; which classes a teacher teaches
create table public.enrollments (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  batch_id bigint references public.batches(id) on delete set null,
  session_id bigint references public.academic_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, class_id)
);

-- Parent <-> student links (Phase 6 use; table ready now)
create table public.guardian_links (
  id bigint generated always as identity primary key,
  guardian_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (guardian_id, student_id)
);

-- Am I enrolled in this class? (RLS helper)
create or replace function public.enrolled_in(p_class_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from public.enrollments e
  where e.user_id = auth.uid() and e.class_id = p_class_id
) or public.is_staff() $$;

-- ---------- Notes ----------
create table public.notes (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  subject_id bigint references public.subjects(id) on delete set null,
  chapter_id bigint references public.chapters(id) on delete set null,
  topic_id bigint references public.topics(id) on delete set null,
  title text not null,
  description text,
  body text,                                -- text-based note content
  file_path text,                           -- storage path for PDF/document notes
  tags text[] not null default '{}',
  is_downloadable boolean not null default true,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Study materials ----------
create table public.materials (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  subject_id bigint references public.subjects(id) on delete set null,
  chapter_id bigint references public.chapters(id) on delete set null,
  topic_id bigint references public.topics(id) on delete set null,
  title text not null,
  description text,
  kind text not null check (kind in ('pdf','worksheet','practice','summary','revision','question_bank','sample_paper','pyq','image','video_link','doc')),
  file_path text,                           -- storage path (private bucket)
  external_url text,                        -- authorised video/document links
  difficulty text not null default 'medium' check (difficulty in ('easy','medium','hard')),
  is_downloadable boolean not null default true,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bookmarks + completion for notes & materials
create table public.bookmarks (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_type text not null check (item_type in ('note','material')),
  item_id bigint not null,
  created_at timestamptz not null default now(),
  unique (user_id, item_type, item_id)
);

create table public.content_progress (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_type text not null check (item_type in ('note','material')),
  item_id bigint not null,
  completed boolean not null default false,
  last_opened_at timestamptz not null default now(),
  unique (user_id, item_type, item_id)
);

-- ---------- Question bank ----------
create table public.questions (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  subject_id bigint references public.subjects(id) on delete set null,
  chapter_id bigint references public.chapters(id) on delete set null,
  topic_id bigint references public.topics(id) on delete set null,
  qtype text not null check (qtype in ('mcq_single','mcq_multi','true_false','fill_blank','short','descriptive')),
  question_text text not null,
  image_path text,
  options jsonb,                            -- [{key:'A',text:'...'}] for MCQ types
  correct_answer jsonb,                     -- SERVER-SIDE ONLY via RLS (never exposed to students)
  explanation text,
  marks numeric not null default 1,
  difficulty text not null default 'medium' check (difficulty in ('easy','medium','hard')),
  status text not null default 'published' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now()
);

-- Student-safe view of questions (no correct_answer / explanation until released)
create view public.questions_student as
  select id, class_id, subject_id, chapter_id, topic_id, qtype,
         question_text, image_path, options, marks, difficulty
  from public.questions where status = 'published';

-- ---------- Tests ----------
create table public.tests (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  subject_id bigint references public.subjects(id) on delete set null,
  chapter_id bigint references public.chapters(id) on delete set null,
  title text not null,
  instructions text,
  duration_minutes int not null default 30,
  total_marks numeric not null default 0,
  negative_marking numeric not null default 0,
  passing_percent numeric not null default 33,
  starts_at timestamptz,
  ends_at timestamptz,
  shuffle_questions boolean not null default false,
  shuffle_options boolean not null default false,
  max_attempts int not null default 1,
  result_release text not null default 'immediate' check (result_release in ('immediate','after_end','manual')),
  results_released boolean not null default false,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now()
);

create table public.test_questions (
  test_id bigint not null references public.tests(id) on delete cascade,
  question_id bigint not null references public.questions(id) on delete cascade,
  sort_order int not null default 0,
  marks numeric,                            -- override; null = question's own marks
  primary key (test_id, question_id)
);

create table public.test_attempts (
  id bigint generated always as identity primary key,
  test_id bigint not null references public.tests(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  status text not null default 'in_progress' check (status in ('in_progress','submitted','auto_submitted')),
  score numeric,
  max_score numeric,
  percent numeric,
  passed boolean,
  time_taken_seconds int,
  unique (test_id, student_id, started_at)
);

create table public.attempt_responses (
  id bigint generated always as identity primary key,
  attempt_id bigint not null references public.test_attempts(id) on delete cascade,
  question_id bigint not null references public.questions(id) on delete cascade,
  answer jsonb,                             -- student's answer (option keys / text)
  marked_for_review boolean not null default false,
  is_correct boolean,                       -- set by server scoring only
  marks_awarded numeric,
  answered_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);

-- Server-side scoring: the ONLY place marks are computed.
-- Called by the student client at submit time, but runs with definer
-- rights and validates everything against the protected answer keys.
create or replace function public.submit_attempt(p_attempt_id bigint)
returns public.test_attempts
language plpgsql security definer set search_path = public
as $$
declare
  v_attempt public.test_attempts;
  v_test public.tests;
  v_score numeric := 0;
  v_max numeric := 0;
  r record;
  v_marks numeric;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id;
  if v_attempt is null then raise exception 'attempt not found'; end if;
  if v_attempt.student_id <> auth.uid() then raise exception 'not your attempt'; end if;
  if v_attempt.status <> 'in_progress' then raise exception 'already submitted'; end if;

  select * into v_test from public.tests where id = v_attempt.test_id;

  for r in
    select q.id as qid, q.qtype, q.correct_answer,
           coalesce(tq.marks, q.marks) as qmarks,
           ar.answer
    from public.test_questions tq
    join public.questions q on q.id = tq.question_id
    left join public.attempt_responses ar
      on ar.attempt_id = p_attempt_id and ar.question_id = q.id
    where tq.test_id = v_attempt.test_id
  loop
    v_max := v_max + r.qmarks;
    if r.answer is not null and r.qtype in ('mcq_single','true_false','fill_blank') then
      if r.answer = r.correct_answer then
        update public.attempt_responses
          set is_correct = true, marks_awarded = r.qmarks
          where attempt_id = p_attempt_id and question_id = r.qid;
        v_score := v_score + r.qmarks;
      else
        update public.attempt_responses
          set is_correct = false, marks_awarded = -v_test.negative_marking
          where attempt_id = p_attempt_id and question_id = r.qid;
        v_score := v_score - v_test.negative_marking;
      end if;
    end if;
    -- mcq_multi / short / descriptive: left for teacher evaluation in Phase 1.
  end loop;

  update public.test_attempts
    set status = 'submitted',
        submitted_at = now(),
        score = greatest(v_score, 0),
        max_score = v_max,
        percent = case when v_max > 0 then round((greatest(v_score,0) / v_max) * 100, 2) else 0 end,
        passed = case when v_max > 0 then (greatest(v_score,0) / v_max) * 100 >= v_test.passing_percent else false end,
        time_taken_seconds = extract(epoch from (now() - v_attempt.started_at))::int
    where id = p_attempt_id
    returning * into v_attempt;
  return v_attempt;
end;
$$;

-- ---------- Assignments ----------
create table public.assignments (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  subject_id bigint references public.subjects(id) on delete set null,
  chapter_id bigint references public.chapters(id) on delete set null,
  title text not null,
  instructions text,
  material_id bigint references public.materials(id) on delete set null,
  due_at timestamptz,
  max_marks numeric,
  allow_resubmit boolean not null default false,
  status text not null default 'published' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now()
);

create table public.submissions (
  id bigint generated always as identity primary key,
  assignment_id bigint not null references public.assignments(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  body text,
  file_path text,
  submitted_at timestamptz not null default now(),
  marks numeric,
  feedback text,
  status text not null default 'submitted' check (status in ('submitted','reviewed','correction_requested')),
  unique (assignment_id, student_id)
);

-- ---------- Attendance & timetable ----------
create table public.attendance (
  id bigint generated always as identity primary key,
  student_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  on_date date not null,
  status text not null check (status in ('present','absent','leave')),
  marked_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (student_id, on_date)
);

create table public.timetable_entries (
  id bigint generated always as identity primary key,
  class_id bigint not null references public.classes(id) on delete cascade,
  batch_id bigint references public.batches(id) on delete cascade,
  subject_id bigint references public.subjects(id) on delete set null,
  teacher_id uuid references public.profiles(id) on delete set null,
  weekday int not null check (weekday between 0 and 6),  -- 0 = Sunday
  starts_at time not null,
  ends_at time not null,
  created_at timestamptz not null default now()
);

create table public.holidays (
  id bigint generated always as identity primary key,
  on_date date not null,
  title text not null,
  created_at timestamptz not null default now()
);

-- ---------- Announcements & notifications ----------
create table public.announcements (
  id bigint generated always as identity primary key,
  author_id uuid references public.profiles(id) on delete set null,
  class_id bigint references public.classes(id) on delete cascade,  -- null = everyone
  title text not null,
  body text,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,                       -- note|material|test|assignment|result|attendance|announcement|fee
  title text not null,
  body text,
  link text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Doubts (Phase 3 module; table ready) ----------
create table public.doubts (
  id bigint generated always as identity primary key,
  student_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint references public.classes(id) on delete set null,
  subject_id bigint references public.subjects(id) on delete set null,
  chapter_id bigint references public.chapters(id) on delete set null,
  question_text text not null,
  image_path text,
  answer_text text,
  answered_by uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open','answered','closed')),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

-- ---------- Audit log ----------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity text,
  entity_id text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index idx_notes_class on public.notes(class_id, status);
create index idx_materials_class on public.materials(class_id, status);
create index idx_questions_bank on public.questions(class_id, subject_id, chapter_id, status);
create index idx_attempts_student on public.test_attempts(student_id, test_id);
create index idx_attendance_student on public.attendance(student_id, on_date);
create index idx_notifications_user on public.notifications(user_id, is_read);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles enable row level security;
alter table public.academic_sessions enable row level security;
alter table public.classes enable row level security;
alter table public.batches enable row level security;
alter table public.subjects enable row level security;
alter table public.chapters enable row level security;
alter table public.topics enable row level security;
alter table public.enrollments enable row level security;
alter table public.guardian_links enable row level security;
alter table public.notes enable row level security;
alter table public.materials enable row level security;
alter table public.bookmarks enable row level security;
alter table public.content_progress enable row level security;
alter table public.questions enable row level security;
alter table public.tests enable row level security;
alter table public.test_questions enable row level security;
alter table public.test_attempts enable row level security;
alter table public.attempt_responses enable row level security;
alter table public.assignments enable row level security;
alter table public.submissions enable row level security;
alter table public.attendance enable row level security;
alter table public.timetable_entries enable row level security;
alter table public.holidays enable row level security;
alter table public.announcements enable row level security;
alter table public.notifications enable row level security;
alter table public.doubts enable row level security;
alter table public.audit_logs enable row level security;

-- Auto-create a profile when a user signs up (role defaults to student;
-- an admin promotes teachers/admins from the Admin panel).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'student')
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Profiles: read own; staff read all; only admin changes roles.
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or public.is_staff());
create policy profiles_admin_write on public.profiles for update
  using (public.my_role() = 'admin');

-- Academic structure: any signed-in user reads; staff write.
do $$
declare t text;
begin
  foreach t in array array['academic_sessions','classes','batches','subjects','chapters','topics','holidays','timetable_entries']
  loop
    execute format('create policy %I_read on public.%I for select using (auth.uid() is not null)', t, t);
    execute format('create policy %I_staff_write on public.%I for all using (public.is_staff()) with check (public.is_staff())', t, t);
  end loop;
end $$;

-- Enrollments: own rows, or staff.
create policy enroll_read on public.enrollments for select
  using (user_id = auth.uid() or public.is_staff());
create policy enroll_staff_write on public.enrollments for all
  using (public.is_staff()) with check (public.is_staff());

-- Guardian links: guardian sees own links; staff manage.
create policy guardian_read on public.guardian_links for select
  using (guardian_id = auth.uid() or student_id = auth.uid() or public.is_staff());
create policy guardian_staff_write on public.guardian_links for all
  using (public.is_staff()) with check (public.is_staff());

-- Notes & materials: published + enrolled (or staff); teachers manage own; admin all.
create policy notes_read on public.notes for select
  using (public.is_staff() or (status = 'published' and public.enrolled_in(class_id)));
create policy notes_write on public.notes for all
  using (teacher_id = auth.uid() or public.my_role() = 'admin')
  with check (teacher_id = auth.uid() or public.my_role() = 'admin');
create policy materials_read on public.materials for select
  using (public.is_staff() or (status = 'published' and public.enrolled_in(class_id)));
create policy materials_write on public.materials for all
  using (teacher_id = auth.uid() or public.my_role() = 'admin')
  with check (teacher_id = auth.uid() or public.my_role() = 'admin');

-- Bookmarks & progress: strictly own.
create policy bookmarks_own on public.bookmarks for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy progress_own on public.content_progress for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Questions: staff only on the base table (answer keys live here).
-- Students NEVER select from public.questions directly.
create policy questions_staff on public.questions for all
  using (public.is_staff()) with check (public.is_staff());

-- Secure delivery of test questions to a student with a live attempt
-- (or for practice/preview rules) — never includes correct_answer.
create or replace function public.get_test_questions(p_test_id bigint)
returns table (
  question_id bigint, qtype text, question_text text, image_path text,
  options jsonb, marks numeric, sort_order int
)
language plpgsql security definer set search_path = public
as $$
declare v_test public.tests;
begin
  select * into v_test from public.tests where id = p_test_id;
  if v_test is null then raise exception 'test not found'; end if;
  if not public.is_staff() then
    if v_test.status <> 'published' then raise exception 'test not available'; end if;
    if not public.enrolled_in(v_test.class_id) then raise exception 'not enrolled'; end if;
  end if;
  return query
    select q.id, q.qtype, q.question_text, q.image_path, q.options,
           coalesce(tq.marks, q.marks), tq.sort_order
    from public.test_questions tq
    join public.questions q on q.id = tq.question_id
    where tq.test_id = p_test_id
    order by case when v_test.shuffle_questions then random() else tq.sort_order end;
end;
$$;

-- Tests: staff manage own; students see published tests of enrolled classes.
create policy tests_staff_write on public.tests for all
  using (teacher_id = auth.uid() or public.my_role() = 'admin')
  with check (teacher_id = auth.uid() or public.my_role() = 'admin');
create policy tests_student_read on public.tests for select
  using (public.is_staff() or (status = 'published' and public.enrolled_in(class_id)));
create policy test_questions_staff on public.test_questions for all
  using (public.is_staff()) with check (public.is_staff());

-- Attempts & responses: student owns theirs; staff read for their classes.
create policy attempts_own_read on public.test_attempts for select
  using (student_id = auth.uid() or public.is_staff());
create policy attempts_own_insert on public.test_attempts for insert
  with check (student_id = auth.uid());
create policy responses_via_attempt on public.attempt_responses for all
  using (exists (select 1 from public.test_attempts a
                 where a.id = attempt_id and (a.student_id = auth.uid() or public.is_staff())))
  with check (exists (select 1 from public.test_attempts a
                 where a.id = attempt_id and a.student_id = auth.uid()
                   and a.status = 'in_progress'));

-- Assignments & submissions.
create policy assignments_read on public.assignments for select
  using (public.is_staff() or (status = 'published' and public.enrolled_in(class_id)));
create policy assignments_write on public.assignments for all
  using (teacher_id = auth.uid() or public.my_role() = 'admin')
  with check (teacher_id = auth.uid() or public.my_role() = 'admin');
create policy submissions_own on public.submissions for all
  using (student_id = auth.uid() or public.is_staff())
  with check (student_id = auth.uid() or public.is_staff());

-- Attendance: student/guardian read own/linked; staff manage.
create policy attendance_read on public.attendance for select
  using (student_id = auth.uid() or public.is_staff()
         or exists (select 1 from public.guardian_links g
                    where g.guardian_id = auth.uid() and g.student_id = attendance.student_id));
create policy attendance_write on public.attendance for all
  using (public.is_staff()) with check (public.is_staff());

-- Announcements: everyone-targeted or own class; staff write.
create policy announcements_read on public.announcements for select
  using (class_id is null or public.enrolled_in(class_id) or public.is_staff());
create policy announcements_write on public.announcements for all
  using (public.is_staff()) with check (public.is_staff());

-- Notifications & doubts: own only (doubts also visible to staff).
create policy notifications_own on public.notifications for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy doubts_own on public.doubts for select
  using (student_id = auth.uid() or public.is_staff());
create policy doubts_insert on public.doubts for insert
  with check (student_id = auth.uid());
create policy doubts_staff_answer on public.doubts for update
  using (public.is_staff() or student_id = auth.uid());

-- Audit logs: admin read; inserts happen via definer functions only.
create policy audit_admin_read on public.audit_logs for select
  using (public.my_role() = 'admin');

-- ============================================================
-- Storage buckets (create in dashboard too; SQL for reference)
--   materials  (private)  — PDFs, worksheets, submissions
--   notes-files(private)  — PDF notes
--   images     (public)   — question images, thumbnails
-- insert into storage.buckets (id, name, public)
-- values ('materials','materials', false),
--        ('notes-files','notes-files', false),
--        ('images','images', true)
-- on conflict (id) do nothing;
-- ============================================================

-- ============================================================
-- Patch (applied 2026-10-21): table privileges for API roles.
-- RLS above decides WHICH rows; these grants open the door at all.
-- anon stays locked out of data tables (login runs via Auth API).
-- ============================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select on public.questions_student to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;

-- ============================================================
-- Patch (2026-10-21): Storage policies.
-- File paths are "<class_id>/<file>" — the first folder names the class,
-- so a student can only read files of classes they are enrolled in.
-- ============================================================
create policy "staff upload files" on storage.objects for insert to authenticated
  with check (bucket_id in ('materials','notes-files','images') and public.is_staff());
create policy "staff update files" on storage.objects for update to authenticated
  using (bucket_id in ('materials','notes-files','images') and public.is_staff())
  with check (bucket_id in ('materials','notes-files','images') and public.is_staff());
create policy "staff delete files" on storage.objects for delete to authenticated
  using (bucket_id in ('materials','notes-files','images') and public.is_staff());
create policy "read class files" on storage.objects for select to authenticated
  using (bucket_id in ('materials','notes-files')
    and (public.is_staff()
         or public.enrolled_in(((storage.foldername(name))[1])::bigint)));

-- ============================================================
-- Patch (2026-10-21): attempt review for students.
-- Correct answers + explanations are revealed ONLY after the
-- attempt is submitted, only to the attempt owner (or staff),
-- and only when the test's result-release rule allows it.
-- ============================================================
create or replace function public.get_attempt_review(p_attempt_id bigint)
returns table (
  question_id bigint, qtype text, question_text text, options jsonb,
  correct_answer jsonb, explanation text, my_answer jsonb,
  is_correct boolean, marks_awarded numeric, q_marks numeric
)
language plpgsql security definer set search_path = public
as $$
declare v_attempt public.test_attempts; v_test public.tests;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id;
  if v_attempt is null then raise exception 'attempt not found'; end if;
  if v_attempt.student_id <> auth.uid() and not public.is_staff() then
    raise exception 'not your attempt';
  end if;
  if v_attempt.status = 'in_progress' then raise exception 'test still running'; end if;
  select * into v_test from public.tests where id = v_attempt.test_id;
  if not public.is_staff() then
    if v_test.result_release = 'manual' and not v_test.results_released then
      raise exception 'result not released yet';
    end if;
    if v_test.result_release = 'after_end' and v_test.ends_at is not null and now() < v_test.ends_at then
      raise exception 'result not released yet';
    end if;
  end if;
  return query
    select q.id, q.qtype, q.question_text, q.options, q.correct_answer, q.explanation,
           ar.answer, ar.is_correct, ar.marks_awarded, coalesce(tq.marks, q.marks)
    from public.test_questions tq
    join public.questions q on q.id = tq.question_id
    left join public.attempt_responses ar
      on ar.attempt_id = p_attempt_id and ar.question_id = q.id
    order by tq.sort_order;
end;
$$;

-- ============================================================
-- Patch (2026-10-21): full student profile + fees.
-- ============================================================
alter table public.profiles add column if not exists dob date;
alter table public.profiles add column if not exists father_name text;
alter table public.profiles add column if not exists mother_name text;
alter table public.profiles add column if not exists admission_date date default current_date;
alter table public.profiles add column if not exists address text;
alter table public.profiles add column if not exists photo_path text;

-- Students may update their OWN profile details (not their role).
create policy profiles_self_update on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create or replace function public.guard_profile_role()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null
     and new.role is distinct from old.role
     and coalesce(public.my_role(), 'student') <> 'admin' then
    raise exception 'role can only be changed by admin';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_role on public.profiles;
create trigger trg_guard_role before update on public.profiles
  for each row execute function public.guard_profile_role();

-- Fee plans (per class) + fee records (per student)
create table public.fee_plans (
  id bigint generated always as identity primary key,
  class_id bigint not null references public.classes(id) on delete cascade,
  fee_type text not null check (fee_type in ('monthly','yearly')),
  amount numeric not null,
  unique (class_id, fee_type)
);
create table public.fee_records (
  id bigint generated always as identity primary key,
  student_id uuid not null references public.profiles(id) on delete cascade,
  class_id bigint references public.classes(id) on delete set null,
  fee_type text not null check (fee_type in ('monthly','yearly','admission','exam','other')),
  period text not null,
  amount numeric not null,
  paid_amount numeric not null default 0,
  due_date date,
  status text not null default 'unpaid' check (status in ('unpaid','partial','paid')),
  note text,
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, fee_type, period)
);
alter table public.fee_plans enable row level security;
alter table public.fee_records enable row level security;
grant select, insert, update, delete on public.fee_plans to authenticated;
grant select, insert, update, delete on public.fee_records to authenticated;
create policy fee_plans_staff on public.fee_plans for all
  using (public.is_staff()) with check (public.is_staff());
create policy fee_records_staff on public.fee_records for all
  using (public.is_staff()) with check (public.is_staff());
create policy fee_records_own_read on public.fee_records for select
  using (student_id = auth.uid()
    or exists (select 1 from public.guardian_links g
               where g.guardian_id = auth.uid() and g.student_id = fee_records.student_id));
create index idx_fee_student on public.fee_records(student_id, status);

-- Avatars bucket ('avatars', private; create in dashboard)
create policy "avatar upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()));
create policy "avatar update own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()))
  with check (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()));
create policy "avatar read signed-in" on storage.objects for select to authenticated
  using (bucket_id = 'avatars');

-- Patch (2026-10-21): allow admins to DELETE profiles (was UPDATE-only,
-- so app deletes silently affected 0 rows).
create policy profiles_admin_delete on public.profiles for delete
  using (public.my_role() = 'admin');
-- ============================================================
-- Patch (2026-10-21): Instant feedback / Practice mode for tests.
-- Adds tests.instant_feedback + reveal_answer() RPC.
-- The student's FIRST saved answer is what reveal judges;
-- the app locks the options after the first click.
-- ============================================================
alter table public.tests add column if not exists instant_feedback boolean not null default false;

create or replace function public.reveal_answer(p_attempt_id bigint, p_question_id bigint)
returns table (correct_answer jsonb, explanation text, is_correct boolean)
language plpgsql security definer set search_path = public
as $$
declare v_attempt public.test_attempts; v_q public.questions; v_ans jsonb;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id;
  if v_attempt is null then raise exception 'attempt not found'; end if;
  if v_attempt.student_id <> auth.uid() and not public.is_staff() then
    raise exception 'not your attempt';
  end if;
  select answer into v_ans from public.attempt_responses
    where attempt_id = p_attempt_id and question_id = p_question_id;
  if v_ans is null then raise exception 'answer first'; end if;
  select * into v_q from public.questions where id = p_question_id;
  if v_q is null then raise exception 'question not found'; end if;
  return query select v_q.correct_answer, v_q.explanation,
    case
      when v_q.qtype in ('mcq_single','true_false')
        then (v_q.correct_answer ->> 0) = (v_ans ->> 0)
      else null
    end;
end;
$$;

-- Turn practice mode ON for all existing tests (the imported Class 12 tests).
update public.tests set instant_feedback = true where instant_feedback = false;
-- ============================================================
-- Patch (2026-10-21): AI answers for doubts.
-- ai_answer is written ONLY by the answer-doubt Edge Function
-- (service role). Students/teachers keep using answer_text.
-- ============================================================
alter table public.doubts add column if not exists ai_answer text;
alter table public.doubts add column if not exists ai_answered_at timestamptz;

-- ============================================================
-- PATCH (21 Oct 2026): service_role access for Edge Functions
-- The answer-doubt function writes via the service-role key and
-- hit "permission denied for table doubts" — grant it explicitly.
-- ============================================================
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ============================================================
-- PATCH v18 (21 Oct 2026): notifications fan-out, leaderboard, live classes
-- (full text in patch_v18.sql)
-- ============================================================
-- ============================================================
-- Target Academy — PATCH v18 (21 Oct 2026)
-- Notifications fan-out + Leaderboard RPC + Live Classes
-- ============================================================

-- 1) Staff may create notifications for other users (announcements,
--    test publishes, doubt answers). Reading stays own-only.
create policy notifications_staff_insert on public.notifications for insert
  with check (public.is_staff());

-- 2) Leaderboard: aggregates only (name, tests given, average %) —
--    students never read each other's raw attempts.
create or replace function public.get_leaderboard(p_class_id bigint default null)
returns table(student_id uuid, full_name text, tests_given int, avg_pct numeric)
language sql
security definer
set search_path = public
as $$
  select a.student_id, p.full_name, count(*)::int as tests_given,
         round(avg(a.percent)) as avg_pct
  from public.test_attempts a
  join public.tests t on t.id = a.test_id
  join public.profiles p on p.id = a.student_id
  where a.status = 'submitted'
    and (p_class_id is null or t.class_id = p_class_id)
  group by a.student_id, p.full_name
  order by avg(a.percent) desc, count(*) desc
  limit 50;
$$;
grant execute on function public.get_leaderboard(bigint) to authenticated;

-- 3) Live Classes
create table if not exists public.live_classes (
  id bigint generated always as identity primary key,
  class_id bigint not null references public.classes(id) on delete cascade,
  title text not null,
  meet_link text not null,
  starts_at timestamptz not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_live_classes_time on public.live_classes(starts_at);
alter table public.live_classes enable row level security;
create policy live_read on public.live_classes for select
  using (public.is_staff() or public.enrolled_in(class_id));
create policy live_write on public.live_classes for all
  using (public.is_staff()) with check (public.is_staff());
grant select, insert, update, delete on public.live_classes to authenticated;
grant usage, select on sequence public.live_classes_id_seq to authenticated;

-- Verify:
select
  (select count(*) from pg_policies where tablename = 'live_classes') as live_policies,
  (select count(*) from pg_policies where policyname = 'notifications_staff_insert') as notif_staff_policy,
  (select count(*) from pg_proc where proname = 'get_leaderboard') as leaderboard_fn;
