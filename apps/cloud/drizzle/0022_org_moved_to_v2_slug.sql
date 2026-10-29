-- `org_moved_to_v2` gains the v2 organization's slug (v2 writes it with
-- `moved`; the v1 dashboard redirects to `/org/<slug>` on v2) and a third
-- state, `rolled_back` (v2 gave the organization back; v1 serves it as if
-- there were no row). The constraint swap is safe online: the table holds at
-- most one row per organization that started a move.
ALTER TABLE "org_moved_to_v2" DROP CONSTRAINT "org_moved_to_v2_state_check";--> statement-breakpoint
ALTER TABLE "org_moved_to_v2" ADD COLUMN "v2_org_slug" text;--> statement-breakpoint
ALTER TABLE "org_moved_to_v2" ADD CONSTRAINT "org_moved_to_v2_state_check" CHECK ("org_moved_to_v2"."state" in ('moving', 'moved', 'rolled_back'));--> statement-breakpoint
-- v2 writes this table as `v1_import_writer`, with
--   INSERT INTO org_moved_to_v2 (org_id, state, v2_org_id, v2_org_slug) VALUES (...)
--   ON CONFLICT (org_id) DO UPDATE SET state = excluded.state,
--     v2_org_id = excluded.v2_org_id, v2_org_slug = excluded.v2_org_slug
-- which needs INSERT and UPDATE on the table and SELECT on the columns the
-- upsert names (the conflict target and the `excluded` reads). It gets nothing
-- else: no DELETE, no SELECT of `updated_at`, nothing on any other table, and
-- only USAGE on the schema, which PlanetScale does not give PUBLIC.
--
-- The grant runs only when the role already exists. When the role is created
-- after this migration has run, run these three statements once, after
-- `CREATE ROLE v1_import_writer ...`:
--   GRANT USAGE ON SCHEMA public TO v1_import_writer;
--   GRANT INSERT, UPDATE ON org_moved_to_v2 TO v1_import_writer;
--   GRANT SELECT (org_id, state, v2_org_id, v2_org_slug) ON org_moved_to_v2 TO v1_import_writer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v1_import_writer') THEN
    -- PlanetScale gives PUBLIC no USAGE on `public`, so the role needs its own.
    GRANT USAGE ON SCHEMA public TO v1_import_writer;
    GRANT INSERT, UPDATE ON org_moved_to_v2 TO v1_import_writer;
    GRANT SELECT (org_id, state, v2_org_id, v2_org_slug) ON org_moved_to_v2 TO v1_import_writer;
  END IF;
END $$;
