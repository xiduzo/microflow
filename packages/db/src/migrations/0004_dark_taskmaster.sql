CREATE TABLE "flow_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_invite" ADD CONSTRAINT "flow_invite_flow_id_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_invite" ADD CONSTRAINT "flow_invite_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_invite_flowId_email_idx" ON "flow_invite" USING btree ("flow_id","email");--> statement-breakpoint
CREATE INDEX "flow_invite_email_idx" ON "flow_invite" USING btree ("email");