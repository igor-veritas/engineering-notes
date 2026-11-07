-- Reproduction: RLS limits rows, a column grant limits columns.
--
-- DO NOT RUN THIS ON SUPABASE OR ANY REAL DATABASE: it drops and creates objects and creates roles.
-- Run it on a throwaway Postgres, not on a shared cluster, because it creates
-- cluster-wide roles. For example:
--   docker run --rm -d --name pgtest -e POSTGRES_PASSWORD=x -p 127.0.0.1:5433:5432 postgres:17
--   PGPASSWORD=x psql -h 127.0.0.1 -p 5433 -U postgres -f column-grants-vs-rls.sql
--   docker rm -f pgtest
--
-- Do not run with ON_ERROR_STOP or in a single transaction: step 5 is meant to fail.
-- fake_auth.uid() is a stub that reads the setting app.uid, standing in for the JWT subject.
-- anon gets the same broad grant but is not exercised here; the policies only apply to authenticated.
-- Verified on Postgres 17. On 17 and later, GRANT ALL also includes MAINTAIN, which information_schema does not list;
-- has_table_privilege(role, table, 'MAINTAIN') or aclexplode(relacl) shows it.
-- The script runs as the superuser; 'set role authenticated' is what makes RLS and the grants apply (superusers, BYPASSRLS roles and,
-- unless FORCE ROW LEVEL SECURITY is set, table owners bypass RLS). The roles anon and authenticated are left behind afterward.
-- This runs on plain Postgres. I have not run it against a hosted Supabase project.
--
-- Expected behavior: step 1 sets alice's is_pro to true. Step 2 changes nothing for bob (UPDATE 0).
-- Step 3 lists 7 privileges per role (8 are held on PG17, see above). Step 5 fails with: permission denied for table profiles.

drop table if exists public.profiles;
drop schema if exists fake_auth cascade;
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema fake_auth;
create function fake_auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('app.uid', true), '')::uuid $$;

create table public.profiles (
  id uuid primary key,
  display_name text,
  is_pro boolean not null default false
);
alter table public.profiles enable row level security;
create policy own_row_select on public.profiles for select to authenticated using (id = fake_auth.uid());
create policy own_row_update on public.profiles for update to authenticated
  using (id = fake_auth.uid()) with check (id = fake_auth.uid());

grant usage on schema public, fake_auth to anon, authenticated;
grant all on public.profiles to anon, authenticated;   -- the broad grant
insert into public.profiles values
  ('00000000-0000-0000-0000-000000000001', 'alice', false),
  ('00000000-0000-0000-0000-000000000002', 'bob', false);

\echo '--- 1. broad grant: alice updates her own is_pro'
set role authenticated;
set app.uid = '00000000-0000-0000-0000-000000000001';
update public.profiles set is_pro = true where id = fake_auth.uid();
select display_name, is_pro from public.profiles;

\echo '--- 2. RLS still blocks bob''s row'
update public.profiles set is_pro = true where id = '00000000-0000-0000-0000-000000000002';
reset role;
select display_name, is_pro from public.profiles order by 1;
update public.profiles set is_pro = false;

\echo '--- 3. audit: what can the roles do on this table?'
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'profiles' and grantee in ('anon', 'authenticated')
order by 1, 2;

\echo '--- 4. fix: column allowlist'
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
set role authenticated;
set app.uid = '00000000-0000-0000-0000-000000000001';
update public.profiles set display_name = 'alice2' where id = fake_auth.uid();
select display_name, is_pro from public.profiles;

\echo '--- 5. the same attack after the fix (expected to fail)'
update public.profiles set is_pro = true where id = fake_auth.uid();
reset role;
reset app.uid;

\echo '--- 5b. anon after the fix (expected to fail)'
set role anon;
update public.profiles set is_pro = true;
reset role;

\echo '--- 6. column privileges after the fix'
select grantee, column_name, privilege_type from information_schema.column_privileges
where table_schema = 'public' and table_name = 'profiles'
  and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE'
order by 1, 2;
