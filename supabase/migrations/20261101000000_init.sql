-- The Rising Times magazine: core schema, security, storage.
-- Run with `npx supabase db push` after linking the project.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.student_type as enum ('student', 'teacher');
create type public.student_class as enum ('Primary', 'Preparatory', 'Secondary');
create type public.event_status as enum ('draft', 'published', 'archived');
create type public.element_type as enum ('text', 'image', 'slideshow', 'video', 'quote', 'students', 'organizers');
create type public.people_kind as enum ('participant', 'organizer');
create type public.editor_role as enum ('admin', 'editor', 'viewer');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.slugify(p_text text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'));
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.students (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  role text not null default '',
  quote text not null default '',
  image_url text not null default '',
  star boolean not null default false,
  type public.student_type not null default 'student',
  class_level public.student_class,
  achievements text[] not null default '{}',
  is_top boolean not null default false,
  top_role text not null default '',
  sort_order integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  category text not null default 'School',
  date_label text not null default '',
  event_date date,
  featured boolean not null default false,
  status public.event_status not null default 'draft',
  sort_order integer not null default 0,
  cover_image_url text,
  seo_title text,
  seo_description text,
  og_image_url text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create table public.event_elements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  position integer not null default 0,
  type public.element_type not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.event_people (
  id uuid primary key default gen_random_uuid(),
  element_id uuid not null references public.event_elements(id) on delete cascade,
  student_id uuid references public.students(id) on delete set null,
  name_snapshot text not null default '',
  kind public.people_kind not null,
  role text not null default '',
  achievement text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.cse_positions (
  id uuid primary key default gen_random_uuid(),
  stage text not null check (stage in ('secondary', 'preparatory', 'primary')),
  role text not null check (role in ('president', 'vicePresident', 'science', 'religiousCulture', 'art', 'social', 'sports')),
  student_id uuid references public.students(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (stage, role)
);

create table public.site_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role public.editor_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_email text,
  action text not null,
  table_name text not null,
  record_id text,
  summary text,
  diff jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index events_status_sort_idx on public.events (status, sort_order, created_at desc);
create index events_published_idx on public.events (published_at desc) where status = 'published' and deleted_at is null;
create index students_class_idx on public.students (class_level, type, sort_order);
create index students_active_idx on public.students (deleted_at) where deleted_at is null;
create index event_elements_event_idx on public.event_elements (event_id, position);
create index event_people_element_idx on public.event_people (element_id, position);
create index event_people_student_idx on public.event_people (student_id);
create index audit_log_created_idx on public.audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- Updated-at triggers
-- ---------------------------------------------------------------------------
create trigger students_updated_at before update on public.students
for each row execute function public.set_updated_at();

create trigger events_updated_at before update on public.events
for each row execute function public.set_updated_at();

create trigger event_elements_updated_at before update on public.event_elements
for each row execute function public.set_updated_at();

create trigger site_settings_updated_at before update on public.site_settings
for each row execute function public.set_updated_at();

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Profile bootstrap
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    'viewer'::public.editor_role
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_editor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'editor')
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and coalesce(auth.jwt()->>'role', '') <> 'service_role'
     and not public.is_admin() then
    raise exception 'Only admins can change profile roles'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role
before update on public.profiles
for each row execute function public.protect_profile_role();

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := lower(tg_op);
  v_record text;
  v_summary text;
  v_diff jsonb;
begin
  if tg_op = 'DELETE' then
    v_record := coalesce(to_jsonb(old)->>'id', to_jsonb(old)->>'key', '');
    v_summary := coalesce(
      to_jsonb(old)->>'title',
      to_jsonb(old)->>'name',
      to_jsonb(old)->>'key',
      concat_ws(' ', to_jsonb(old)->>'stage', to_jsonb(old)->>'role'),
      ''
    );
    v_diff := jsonb_build_object('old', to_jsonb(old));
  elsif tg_op = 'UPDATE' then
    v_record := coalesce(to_jsonb(new)->>'id', to_jsonb(new)->>'key', '');
    v_summary := coalesce(
      to_jsonb(new)->>'title',
      to_jsonb(new)->>'name',
      to_jsonb(new)->>'key',
      concat_ws(' ', to_jsonb(new)->>'stage', to_jsonb(new)->>'role'),
      ''
    );
    v_diff := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
  else
    v_record := coalesce(to_jsonb(new)->>'id', to_jsonb(new)->>'key', '');
    v_summary := coalesce(
      to_jsonb(new)->>'title',
      to_jsonb(new)->>'name',
      to_jsonb(new)->>'key',
      concat_ws(' ', to_jsonb(new)->>'stage', to_jsonb(new)->>'role'),
      ''
    );
    v_diff := jsonb_build_object('new', to_jsonb(new));
  end if;

  insert into public.audit_log (actor_id, actor_email, action, table_name, record_id, summary, diff)
  values (auth.uid(), auth.jwt()->>'email', v_action, tg_table_name, v_record, v_summary, v_diff);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger audit_events after insert or update or delete on public.events
for each row execute function public.audit_row();

create trigger audit_students after insert or update or delete on public.students
for each row execute function public.audit_row();

create trigger audit_cse after insert or update or delete on public.cse_positions
for each row execute function public.audit_row();

create trigger audit_settings after insert or update or delete on public.site_settings
for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.students enable row level security;
alter table public.events enable row level security;
alter table public.event_elements enable row level security;
alter table public.event_people enable row level security;
alter table public.cse_positions enable row level security;
alter table public.site_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.audit_log enable row level security;

-- Students
create policy "Public can read active students" on public.students
for select to anon, authenticated using (deleted_at is null);

create policy "Editors can read all students" on public.students
for select to authenticated using (public.is_editor());

create policy "Editors can insert students" on public.students
for insert to authenticated with check (public.is_editor());

create policy "Editors can update students" on public.students
for update to authenticated using (public.is_editor()) with check (public.is_editor());

create policy "Editors can delete students" on public.students
for delete to authenticated using (public.is_editor());

-- Events
create policy "Public can read published events" on public.events
for select to anon, authenticated using (status = 'published' and deleted_at is null);

create policy "Editors can read all events" on public.events
for select to authenticated using (public.is_editor());

create policy "Editors can insert events" on public.events
for insert to authenticated with check (public.is_editor());

create policy "Editors can update events" on public.events
for update to authenticated using (public.is_editor()) with check (public.is_editor());

create policy "Editors can delete events" on public.events
for delete to authenticated using (public.is_editor());

-- Elements
create policy "Public can read elements of published events" on public.event_elements
for select to anon, authenticated using (
  exists (
    select 1 from public.events e
    where e.id = event_elements.event_id
      and e.status = 'published'
      and e.deleted_at is null
  )
);

create policy "Editors can read all elements" on public.event_elements
for select to authenticated using (public.is_editor());

create policy "Editors can write elements" on public.event_elements
for insert to authenticated with check (public.is_editor());

create policy "Editors can update elements" on public.event_elements
for update to authenticated using (public.is_editor()) with check (public.is_editor());

create policy "Editors can delete elements" on public.event_elements
for delete to authenticated using (public.is_editor());

-- People links
create policy "Public can read people of published events" on public.event_people
for select to anon, authenticated using (
  exists (
    select 1
    from public.event_elements el
    join public.events e on e.id = el.event_id
    where el.id = event_people.element_id
      and e.status = 'published'
      and e.deleted_at is null
  )
);

create policy "Editors can read all people" on public.event_people
for select to authenticated using (public.is_editor());

create policy "Editors can write people" on public.event_people
for insert to authenticated with check (public.is_editor());

create policy "Editors can update people" on public.event_people
for update to authenticated using (public.is_editor()) with check (public.is_editor());

create policy "Editors can delete people" on public.event_people
for delete to authenticated using (public.is_editor());

-- CSE
create policy "Public can read CSE positions" on public.cse_positions
for select to anon, authenticated using (true);

create policy "Editors can write CSE positions" on public.cse_positions
for insert to authenticated with check (public.is_editor());

create policy "Editors can update CSE positions" on public.cse_positions
for update to authenticated using (public.is_editor()) with check (public.is_editor());

create policy "Editors can delete CSE positions" on public.cse_positions
for delete to authenticated using (public.is_editor());

-- Settings
create policy "Public can read settings" on public.site_settings
for select to anon, authenticated using (true);

create policy "Editors can write settings" on public.site_settings
for insert to authenticated with check (public.is_editor());

create policy "Editors can update settings" on public.site_settings
for update to authenticated using (public.is_editor()) with check (public.is_editor());

create policy "Editors can delete settings" on public.site_settings
for delete to authenticated using (public.is_editor());

-- Profiles
create policy "Users can read own profile" on public.profiles
for select to authenticated using (id = (select auth.uid()));

create policy "Admins can read all profiles" on public.profiles
for select to authenticated using (public.is_admin());

create policy "Users can update own profile" on public.profiles
for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Audit log
create policy "Editors can read audit log" on public.audit_log
for select to authenticated using (public.is_editor());

-- ---------------------------------------------------------------------------
-- Grants (RLS still applies)
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

grant select on public.students, public.events, public.event_elements, public.event_people,
  public.cse_positions, public.site_settings to anon, authenticated;

grant select, insert, update, delete on public.students, public.events, public.event_elements,
  public.event_people, public.cse_positions, public.site_settings to authenticated;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.audit_log to authenticated;

grant all on public.students, public.events, public.event_elements, public.event_people,
  public.cse_positions, public.site_settings, public.profiles, public.audit_log to service_role;

grant usage, select on all sequences in schema public to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CSE seed rows (students assigned later)
-- ---------------------------------------------------------------------------
insert into public.cse_positions (stage, role)
select s, r
from unnest(array['secondary', 'preparatory', 'primary']) as s
cross join unnest(array['president', 'vicePresident', 'science', 'religiousCulture', 'art', 'social', 'sports']) as r
on conflict (stage, role) do nothing;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can read media" on storage.objects;
create policy "Public can read media" on storage.objects
for select to anon, authenticated using (bucket_id = 'media');

drop policy if exists "Editors can upload media" on storage.objects;
create policy "Editors can upload media" on storage.objects
for insert to authenticated with check (bucket_id = 'media' and public.is_editor());

drop policy if exists "Editors can update media" on storage.objects;
create policy "Editors can update media" on storage.objects
for update to authenticated using (bucket_id = 'media' and public.is_editor())
with check (bucket_id = 'media' and public.is_editor());

drop policy if exists "Editors can delete media" on storage.objects;
create policy "Editors can delete media" on storage.objects
for delete to authenticated using (bucket_id = 'media' and public.is_editor());
