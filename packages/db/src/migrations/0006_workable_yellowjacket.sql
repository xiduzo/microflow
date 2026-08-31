CREATE TABLE "flow_bookmark" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "flow" ADD COLUMN "published_ydoc" "bytea";--> statement-breakpoint
ALTER TABLE "flow" ADD COLUMN "published_at" timestamp;--> statement-breakpoint
ALTER TABLE "flow" ADD COLUMN "forked_from_id" text;--> statement-breakpoint
ALTER TABLE "flow_bookmark" ADD CONSTRAINT "flow_bookmark_flow_id_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_bookmark" ADD CONSTRAINT "flow_bookmark_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_bookmark_userId_idx" ON "flow_bookmark" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "flow_bookmark_flowId_idx" ON "flow_bookmark" USING btree ("flow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_bookmark_flowId_userId_idx" ON "flow_bookmark" USING btree ("flow_id","user_id");--> statement-breakpoint
CREATE INDEX "flow_publishedAt_idx" ON "flow" USING btree ("published_at");