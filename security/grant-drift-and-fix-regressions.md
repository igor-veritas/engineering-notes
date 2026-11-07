# A fix that checked only its target, and grants that drifted back

These are lessons from security reviews of a Supabase project of mine that has not launched: findings were proven from the deployed grants, policies and function bodies, with no exploit run against data. I checked each finding against the live database. The one test write I did run, on my own row, is described in the [column-grants note](column-grants-vs-rls.md). This note covers process only: three ways a security fix looked finished and wasn't.

## 1. A fix that checked only its target

A table linked two parties, and direct inserts let one party fabricate a link. I revoked `INSERT` and marked it closed. The table also had an `UPDATE` grant I had not looked at, so either side could rewrite the identifiers on an existing link and take over a relationship that already existed. That is worse than fabricating a new one. My regression matrix classified it as "fix left a new critical problem".

```sql
-- synthetic example
revoke insert on public.example_links from public, anon, authenticated;
-- update on the identifier columns was still granted
```

The fix added an immutability trigger on the link columns and routed changes through audited functions. I used a trigger and not a column grant because the changes legitimately go through privileged functions, and a trigger also blocks those paths. My mistake was verifying the fix against the finding it targeted and not against the whole table. A regression test for the original bug would never have caught this. A fix now includes reading every privilege on the table, not only the one the finding names.

## 2. A revoke that came back

I revoked anonymous access on a function that returned dashboard stats, and I recorded it as fixed. The next review, eleven days later, I found anonymous execution present again. Nothing had re-checked the grant after I applied the fix, and my notes still said it was closed. The same review found privileged functions broadly executable by `anon` and `authenticated`, including a set that had an explicit revocation migration.

Causes I found:

- Postgres grants `EXECUTE` on every new function to `PUBLIC` by default, and Supabase's default privileges can add grants to `anon`, `authenticated` and `service_role`. `REVOKE ... FROM PUBLIC` does not remove a grant made directly to a role. The structural fix is to change the defaults for each role that creates functions, for example `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;` and the same for `anon`, `authenticated` and `service_role`. That only affects functions created afterward, so existing functions still need explicit revokes and grants, and on a hosted platform you cannot change the defaults of roles you do not control.
- Dropping and recreating a function resets its privileges to the defaults, while `CREATE OR REPLACE` keeps them, so a migration that rewrites a function can quietly undo a revoke.
- A migration I wrote to convert two functions never ran, and the old path stayed live. Only a live check, not the migration history, would show that.

The check compares live grants against an intended baseline, using the catalog and not the migration history. `has_function_privilege` resolves `PUBLIC` and role inheritance, so it reports effective access:

```sql
-- synthetic example: security-definer functions in public that anon or authenticated can run
select p.oid::regprocedure as fn, r.rolname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'), ('authenticated')) as r(rolname)
where n.nspname = 'public'
  and p.prosecdef
  and has_function_privilege(r.rolname, p.oid, 'EXECUTE');
```

Any row not in the baseline is drift. The query covers only `SECURITY DEFINER` functions in `public`, so functions that run as the caller, and any other schema the API exposes, need their own check. Extension functions in `public` also show up and belong in the baseline. A `SECURITY DEFINER` function should also pin its `search_path`, which this query does not test (check `proconfig`). A definer function owned by a role that bypasses RLS skips RLS entirely, so the grant and the null guard are the only protection it has. The fix names the roles explicitly:

```sql
revoke execute on function public.example_fn(uuid) from public, anon, authenticated;
grant execute on function public.example_fn(uuid) to service_role;
```

Revoking `EXECUTE` on a function that an RLS policy calls will break that policy for the roles involved, so run the policy tests after a revoke.

What this case taught me is not to count a ticket as closed until a catalog query or an end-to-end test shows it. The review re-checked every earlier finding that way, and some had regressed.

## 3. A null that makes the check pass

The dashboard function's authorization skipped the case where `auth.uid()` is null, which is what `anon` gets. I then found the same shape in seven more functions:

```sql
-- fails open: with a null auth.uid() the condition is null, so the branch is skipped
if owner_id != auth.uid() then
  raise exception 'forbidden';
end if;
```

Comparing anything to null gives null, and `if` treats null as false. Fail closed instead:

```sql
if auth.uid() is null or owner_id is distinct from auth.uid() then
  raise exception 'forbidden';
end if;
```

The fix is mechanical, so it is now a check I apply to every ownership test: handle a null `auth.uid()` first. The review also showed that the guard and the grant are separate layers. I had treated the grants as making those functions unreachable, and that was wrong, so each layer gets its own test.

## The checks that came out of it

- Read every privilege on a table before calling a fix to it done, not just the one the finding names.
- Compare live effective grants to a written baseline, using `has_function_privilege` and not the migration history.
- Handle a null `auth.uid()` first in every ownership test, and test the guard and the grant as separate layers.
- Give new functions explicit grants and read the live ACL afterward.
