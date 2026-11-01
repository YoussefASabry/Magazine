-- Atomic write helpers used by the admin UI.
-- All functions are SECURITY INVOKER so RLS still applies to the caller.

create or replace function public.save_event(p_event jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid := nullif(p_event->>'id', '')::uuid;
  v_slug text;
  v_base text;
  v_i integer := 2;
  v_el jsonb;
  v_el_id uuid;
  v_people jsonb;
  v_person jsonb;
  v_kind public.people_kind;
  v_student_id uuid;
  v_position integer := 0;
  v_person_position integer;
  v_status public.event_status;
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;

  if v_id is not null and not exists (select 1 from public.events where id = v_id) then
    v_id := null;
  end if;

  v_slug := coalesce(nullif(p_event->>'slug', ''), public.slugify(p_event->>'title'));

  -- Idempotent import: reuse an existing row with the same slug.
  if v_id is null then
    select id into v_id from public.events where slug = v_slug;
  end if;

  v_base := v_slug;
  while exists (
    select 1 from public.events
    where slug = v_slug and (v_id is null or id <> v_id)
  ) loop
    v_slug := v_base || '-' || v_i;
    v_i := v_i + 1;
  end loop;

  v_status := coalesce(nullif(p_event->>'status', ''), 'draft')::public.event_status;

  if v_id is null then
    insert into public.events (
      slug, title, category, date_label, event_date, featured, status, sort_order,
      cover_image_url, seo_title, seo_description, og_image_url, published_at
    )
    values (
      v_slug,
      p_event->>'title',
      coalesce(nullif(p_event->>'category', ''), 'School'),
      coalesce(p_event->>'date_label', ''),
      nullif(p_event->>'event_date', '')::date,
      coalesce((p_event->>'featured')::boolean, false),
      v_status,
      coalesce((p_event->>'sort_order')::integer, 0),
      nullif(p_event->>'cover_image_url', ''),
      nullif(p_event->>'seo_title', ''),
      nullif(p_event->>'seo_description', ''),
      nullif(p_event->>'og_image_url', ''),
      case when v_status = 'published' then now() else null end
    )
    returning id into v_id;
  else
    update public.events
    set slug = v_slug,
        title = p_event->>'title',
        category = coalesce(nullif(p_event->>'category', ''), 'School'),
        date_label = coalesce(p_event->>'date_label', ''),
        event_date = nullif(p_event->>'event_date', '')::date,
        featured = coalesce((p_event->>'featured')::boolean, false),
        status = v_status,
        sort_order = coalesce((p_event->>'sort_order')::integer, 0),
        cover_image_url = nullif(p_event->>'cover_image_url', ''),
        seo_title = nullif(p_event->>'seo_title', ''),
        seo_description = nullif(p_event->>'seo_description', ''),
        og_image_url = nullif(p_event->>'og_image_url', ''),
        published_at = case when v_status = 'published' then coalesce(published_at, now()) else null end,
        updated_at = now()
    where id = v_id;

    delete from public.event_elements where event_id = v_id;
  end if;

  for v_el in
    select value from jsonb_array_elements(coalesce(p_event->'elements', '[]'::jsonb))
  loop
    insert into public.event_elements (event_id, position, type, data)
    values (
      v_id,
      v_position,
      (v_el->>'type')::public.element_type,
      coalesce(v_el->'data', '{}'::jsonb) - 'students' - 'organizers' - 'people'
    )
    returning id into v_el_id;

    if (v_el->>'type') in ('students', 'organizers') then
      v_kind := case
        when v_el->>'type' = 'organizers' then 'organizer'::public.people_kind
        else 'participant'::public.people_kind
      end;
      v_people := coalesce(v_el->'people', v_el->'students', v_el->'organizers', '[]'::jsonb);
      v_person_position := 0;

      for v_person in select value from jsonb_array_elements(v_people) loop
        v_student_id := nullif(v_person->>'student_id', '')::uuid;

        if v_student_id is null and coalesce(v_person->>'name', '') <> '' then
          select id into v_student_id
          from public.students
          where lower(name) = lower(v_person->>'name')
            and deleted_at is null
          limit 1;
        end if;

        if v_student_id is null and coalesce(v_person->>'name', '') = '' then
          continue;
        end if;

        insert into public.event_people (
          element_id, student_id, name_snapshot, kind, role, achievement, position
        )
        values (
          v_el_id,
          v_student_id,
          coalesce(
            nullif(v_person->>'name', ''),
            (select name from public.students where id = v_student_id),
            ''
          ),
          v_kind,
          coalesce(v_person->>'role', ''),
          coalesce(v_person->>'achievement', ''),
          v_person_position
        );

        v_person_position := v_person_position + 1;
      end loop;
    end if;

    v_position := v_position + 1;
  end loop;

  return v_id;
end;
$$;

create or replace function public.save_student(p_student jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid := nullif(p_student->>'id', '')::uuid;
  v_slug text;
  v_base text;
  v_i integer := 2;
  v_type public.student_type := coalesce(nullif(p_student->>'type', ''), 'student')::public.student_type;
  v_class public.student_class := nullif(p_student->>'class_level', '')::public.student_class;
  v_achievements text[];
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;

  if v_id is not null and not exists (select 1 from public.students where id = v_id) then
    v_id := null;
  end if;

  if v_type = 'teacher' then
    v_class := null;
  end if;

  v_slug := coalesce(nullif(p_student->>'slug', ''), public.slugify(p_student->>'name'));

  -- Idempotent import: reuse an existing row with the same slug.
  if v_id is null then
    select id into v_id from public.students where slug = v_slug;
  end if;

  v_base := v_slug;
  while exists (
    select 1 from public.students
    where slug = v_slug and (v_id is null or id <> v_id)
  ) loop
    v_slug := v_base || '-' || v_i;
    v_i := v_i + 1;
  end loop;

  v_achievements := coalesce(
    array(select jsonb_array_elements_text(coalesce(p_student->'achievements', '[]'::jsonb))),
    '{}'::text[]
  );

  if v_id is null then
    insert into public.students (
      slug, name, role, quote, image_url, star, type, class_level,
      achievements, is_top, top_role, sort_order
    )
    values (
      v_slug,
      p_student->>'name',
      coalesce(p_student->>'role', ''),
      coalesce(p_student->>'quote', ''),
      coalesce(p_student->>'image_url', ''),
      coalesce((p_student->>'star')::boolean, false),
      v_type,
      v_class,
      v_achievements,
      coalesce((p_student->>'is_top')::boolean, false),
      coalesce(p_student->>'top_role', ''),
      coalesce((p_student->>'sort_order')::integer, 0)
    )
    returning id into v_id;
  else
    update public.students
    set slug = v_slug,
        name = p_student->>'name',
        role = coalesce(p_student->>'role', ''),
        quote = coalesce(p_student->>'quote', ''),
        image_url = coalesce(p_student->>'image_url', ''),
        star = coalesce((p_student->>'star')::boolean, false),
        type = v_type,
        class_level = v_class,
        achievements = v_achievements,
        is_top = coalesce((p_student->>'is_top')::boolean, false),
        top_role = coalesce(p_student->>'top_role', ''),
        sort_order = coalesce((p_student->>'sort_order')::integer, 0),
        updated_at = now()
    where id = v_id;
  end if;

  return v_id;
end;
$$;

create or replace function public.delete_event(p_id uuid, p_soft boolean default true)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;

  if p_soft then
    update public.events set deleted_at = now(), updated_at = now() where id = p_id;
  else
    delete from public.events where id = p_id;
  end if;
end;
$$;

create or replace function public.restore_event(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;
  update public.events set deleted_at = null, updated_at = now() where id = p_id;
end;
$$;

create or replace function public.delete_student(p_id uuid, p_soft boolean default true)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;

  if p_soft then
    update public.students set deleted_at = now(), updated_at = now() where id = p_id;
  else
    delete from public.students where id = p_id;
  end if;
end;
$$;

create or replace function public.restore_student(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;
  update public.students set deleted_at = null, updated_at = now() where id = p_id;
end;
$$;

create or replace function public.reorder_events(p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_i integer;
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;

  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  for v_i in 1..array_length(p_ids, 1) loop
    update public.events
    set sort_order = v_i, updated_at = now()
    where id = p_ids[v_i];
  end loop;
end;
$$;

create or replace function public.save_cse(p_head_student_id uuid, p_positions jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_position jsonb;
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;

  for v_position in select value from jsonb_array_elements(coalesce(p_positions, '[]'::jsonb)) loop
    insert into public.cse_positions (stage, role, student_id)
    values (
      v_position->>'stage',
      v_position->>'role',
      nullif(v_position->>'student_id', '')::uuid
    )
    on conflict (stage, role) do update
    set student_id = excluded.student_id,
        updated_at = now();
  end loop;

  insert into public.site_settings (key, value)
  values ('cse_head', jsonb_build_object('student_id', p_head_student_id))
  on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
end;
$$;

create or replace function public.save_settings(p_settings jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_setting record;
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;

  for v_setting in select * from jsonb_each(coalesce(p_settings, '{}'::jsonb)) loop
    insert into public.site_settings (key, value)
    values (v_setting.key, v_setting.value)
    on conflict (key) do update
    set value = excluded.value,
        updated_at = now();
  end loop;
end;
$$;

create or replace function public.duplicate_event(p_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old public.events%rowtype;
  v_new_id uuid;
  v_slug text;
  v_base text;
  v_i integer := 2;
  v_el record;
  v_new_el_id uuid;
  v_sort integer;
begin
  if auth.role() <> 'service_role' and not public.is_editor() then
    raise exception 'not authorized';
  end if;

  select * into v_old from public.events where id = p_id;
  if not found then
    raise exception 'event not found';
  end if;

  v_base := v_old.slug || '-copy';
  v_slug := v_base;
  while exists (select 1 from public.events where slug = v_slug) loop
    v_slug := v_base || '-' || v_i;
    v_i := v_i + 1;
  end loop;

  select coalesce(max(sort_order), 0) + 1 into v_sort from public.events;

  insert into public.events (
    slug, title, category, date_label, event_date, featured, status, sort_order,
    cover_image_url, seo_title, seo_description, og_image_url
  )
  values (
    v_slug,
    v_old.title || ' (Copy)',
    v_old.category,
    v_old.date_label,
    v_old.event_date,
    false,
    'draft',
    v_sort,
    v_old.cover_image_url,
    v_old.seo_title,
    v_old.seo_description,
    v_old.og_image_url
  )
  returning id into v_new_id;

  for v_el in
    select * from public.event_elements where event_id = p_id order by position
  loop
    insert into public.event_elements (event_id, position, type, data)
    values (v_new_id, v_el.position, v_el.type, v_el.data)
    returning id into v_new_el_id;

    insert into public.event_people (
      element_id, student_id, name_snapshot, kind, role, achievement, position
    )
    select v_new_el_id, student_id, name_snapshot, kind, role, achievement, position
    from public.event_people
    where element_id = v_el.id
    order by position;
  end loop;

  return v_new_id;
end;
$$;

grant execute on function public.save_event(jsonb) to authenticated, service_role;
grant execute on function public.save_student(jsonb) to authenticated, service_role;
grant execute on function public.delete_event(uuid, boolean) to authenticated, service_role;
grant execute on function public.restore_event(uuid) to authenticated, service_role;
grant execute on function public.delete_student(uuid, boolean) to authenticated, service_role;
grant execute on function public.restore_student(uuid) to authenticated, service_role;
grant execute on function public.reorder_events(uuid[]) to authenticated, service_role;
grant execute on function public.save_cse(uuid, jsonb) to authenticated, service_role;
grant execute on function public.save_settings(jsonb) to authenticated, service_role;
grant execute on function public.duplicate_event(uuid) to authenticated, service_role;
grant execute on function public.is_editor() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
