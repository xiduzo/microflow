-- Collapse any duplicate grants before the unique index can be created.
-- Keeps the more permissive role when a user was granted twice.
DELETE FROM "flow_collaborator" a USING "flow_collaborator" b
  WHERE a."flow_id" = b."flow_id"
    AND a."user_id" = b."user_id"
    AND a."id" <> b."id"
    AND (
      (a."role" = 'viewer' AND b."role" = 'editor')
      OR (a."role" = b."role" AND a.ctid < b.ctid)
    );
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_collaborator_flowId_userId_idx" ON "flow_collaborator" USING btree ("flow_id","user_id");
