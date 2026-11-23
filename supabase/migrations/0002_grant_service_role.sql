-- Hello Po: let the server role use the logging tables.
-- Newer Supabase projects no longer grant table privileges to API roles automatically.
-- Only service_role (the secret key, used by the agent) gets access; the public
-- anon/authenticated roles get none, and RLS stays enabled as a second barrier.

grant select, insert, update, delete on table public.calls to service_role;
grant select, insert, update, delete on table public.turns to service_role;
