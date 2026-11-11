-- Coordinators choose which department columns appear on the waiting-room TV.
alter table public.display_settings add column if not exists visible_departments text[] not null
  default array['CM','VH','TT','ND','HCTC']::text[];

do $$ begin
  if not exists (select 1 from pg_constraint where conname='display_settings_visible_departments_check') then
    alter table public.display_settings add constraint display_settings_visible_departments_check
      check (visible_departments <@ array['CM','VH','TT','ND','HCTC']::text[]
        and array_position(visible_departments,null) is null);
  end if;
end $$;

notify pgrst,'reload schema';
