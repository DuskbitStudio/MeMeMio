CREATE TABLE "mcp_call_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_id" uuid,
	"budget_key" text NOT NULL,
	"tool" text NOT NULL,
	"query_text" text,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_call_logs_outcome_check" CHECK ("mcp_call_logs"."outcome" in ('ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "mcp_call_logs" ADD CONSTRAINT "mcp_call_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_call_logs" ADD CONSTRAINT "mcp_call_logs_token_id_access_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."access_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_call_logs_user_time_idx" ON "mcp_call_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mcp_call_logs_budget_time_idx" ON "mcp_call_logs" USING btree ("budget_key","created_at");