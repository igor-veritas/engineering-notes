# RLS filters rows, not columns: a profile flag any user could flip

In a Supabase project of mine that has not launched, every table in the `public` schema had `GRANT ALL` to `anon` and `authenticated`. Row-Level Security was the only thing between a logged-in user and a write to any column on any row they could touch. On `profiles`, that meant any user could set their own `is_pro` flag.

## What RLS does and does not do

RLS decides which rows a role can see or change. It does not decide which columns. Postgres checks table and column privileges first, then evaluates the policies. A policy "you can update your own row" together with a table-level `UPDATE` grant means you can update every column on your own row.

My `profiles` table had that own-row update policy, a `display_name` column users should edit, and columns they should never touch, such as the `is_pro` entitlement flag and other server-managed state. The policy was correct. The grant made it insufficient.

## How I found it

I stopped asking "does this table have RLS" and asked what the roles can actually do:

```sql
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'profiles'
  and grantee in ('anon', 'authenticated');
```

That returned seven privileges for each role, including `UPDATE`, `DELETE` and `TRUNCATE`. The view `role_table_grants` shows only grants where the grantor or grantee is a role you currently hold, shows `PUBLIC` as its own grantee, and does not resolve role inheritance. It also omits `MAINTAIN`, which Postgres 17 added to `GRANT ALL`, so seven is the view's count and the table actually held eight. For effective privileges use `has_table_privilege` or `aclexplode(relacl)`. To see where grants come from, look at `pg_default_acl`: it holds default privileges, keyed by the creating role, schema and object type. This was most likely a platform default I had never tightened, and `pg_default_acl` is where I would confirm it. I did not trace it in my project.

## Proving it

I ran a real `UPDATE` as an authenticated user, using my own account on my own pre-launch project, set `is_pro` to true on my own row, confirmed it worked, and reverted it. I did not want to write "this should be exploitable" without testing it.

Then I checked every other table with the same grants. Most were safe only for a specific reason: no write policy at all, or every column on the table being user-owned, so that a row-ownership `WITH CHECK` was enough. A `WITH CHECK (id = auth.uid())` limits which rows you can write. It protects no columns. `profiles` was the real hole. A few other tables let a client skip invariants that my server functions enforce, because those functions were never the only path in.

Two more things in that grant list matter. `INSERT` is part of `GRANT ALL`, so a user could also insert a row with `is_pro = true`, or use `ON CONFLICT DO UPDATE`, if the insert and update policies both allowed it. And `TRUNCATE` is not subject to RLS at all: a role holding it can empty a table whatever the policies say. PostgREST, which serves the Supabase API, does not expose `TRUNCATE`, so that path needs a direct database connection. It is still a privilege nothing in the app needs to hold.

## What decides whether a table needs a column grant

The condition is that one row mixes columns from two trust levels. A table where every column is user-writable needs only correct RLS for this question, though it should still not carry `DELETE`, `TRUNCATE` or `TRIGGER` for these roles unless something uses them. A table where `is_pro` sits next to `display_name` needs a column-level grant.

The better design avoids the mix: keep entitlements in a separate table that users have no write grant on, or protect the column with a trigger. I used the column grant here because the table already existed and the change was small. The separate table is where I would put it in a new schema.

## The fix, and the part I got wrong twice

1. Read the effective privileges, not the ones I assumed.
2. Decide which columns are server-only and which users may edit.
3. Build the allowlist by grepping every client call site that writes to the table. My first two attempts guessed what seemed reasonable, and both were wrong. The call sites were the only reliable source.
4. Revoke the broad grant and grant by column. The order matters: `REVOKE UPDATE (is_pro)` does nothing while a table-level `UPDATE` grant exists, so the table-level grant has to go first: a table-level privilege covers every column, and a column-level revoke only removes column-level entries.
5. Verify live that the legitimate write still works and the forbidden one fails.

```sql
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
```

A column added later does not inherit a column-scoped `UPDATE` grant. Writes to it fail with `permission denied for table` (SQLSTATE 42501), so the failure is loud, and a test that writes each new editable column will catch it. Reads are different: the table-level `SELECT` grant covers new columns automatically, so a new sensitive column is readable until someone restricts it.

## A runnable version

[`column-grants-vs-rls.sql`](column-grants-vs-rls.sql) reproduces the whole thing on plain Postgres with a simulated `auth.uid()`. With the broad grant, an update to `is_pro` on your own row succeeds, and an update on someone else's row affects zero rows because RLS still works. After the column allowlist, the same statement fails with `permission denied for table profiles`. New tables will pick up the same default grants again unless the defaults are changed, which is the drift problem described in the [grant-drift note](grant-drift-and-fix-regressions.md).
