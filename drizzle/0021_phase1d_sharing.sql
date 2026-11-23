CREATE TABLE "patient_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"version" text NOT NULL,
	"granted" boolean NOT NULL,
	"method" text NOT NULL,
	"captured_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_consents_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_consents_purpose_check" CHECK (purpose in ('sharing')),
	CONSTRAINT "patient_consents_method_check" CHECK (method in ('verbal', 'written')),
	CONSTRAINT "patient_consents_version_check" CHECK (version ~ '^[a-z]+-v[0-9]{1,3}$')
);
--> statement-breakpoint
CREATE TABLE "prescription_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"share_link_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient_masked" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rx_shares_channel_check" CHECK (channel in ('whatsapp', 'email')),
	CONSTRAINT "rx_shares_provider_check" CHECK (provider in ('wa_link', 'resend', 'fake')),
	CONSTRAINT "rx_shares_status_check" CHECK (status in ('prepared', 'sent', 'failed')),
	CONSTRAINT "rx_shares_recipient_check" CHECK (char_length(recipient_masked) between 1 and 64),
	CONSTRAINT "rx_shares_error_check" CHECK (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "rx_shares_message_id_check" CHECK (provider_message_id is null or char_length(provider_message_id) <= 200)
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"channel" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_opens" integer NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"last_opened_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "share_links_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "share_links_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "share_links_channel_check" CHECK (channel in ('whatsapp', 'email')),
	CONSTRAINT "share_links_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "share_links_opens_check" CHECK (max_opens between 1 and 50 and open_count between 0 and max_opens),
	CONSTRAINT "share_links_expiry_check" CHECK (expires_at > created_at and expires_at <= created_at + interval '31 days'),
	CONSTRAINT "share_links_revocation_check" CHECK ((revoked_at is null) = (revoke_reason is null) and (revoke_reason is null or revoke_reason in ('user', 'consent_withdrawn', 'patient_archived', 'send_failed')))
);
--> statement-breakpoint
ALTER TABLE "prescription_outputs" DROP CONSTRAINT "rx_outputs_kind_check";--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "sharing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD COLUMN "share_link_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_shares" ADD CONSTRAINT "prescription_shares_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_shares" ADD CONSTRAINT "rx_shares_prescription_fk" FOREIGN KEY ("tenant_id","prescription_id") REFERENCES "public"."prescriptions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_shares" ADD CONSTRAINT "rx_shares_link_fk" FOREIGN KEY ("tenant_id","share_link_id") REFERENCES "public"."share_links"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_prescription_fk" FOREIGN KEY ("tenant_id","prescription_id") REFERENCES "public"."prescriptions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_consent_fk" FOREIGN KEY ("tenant_id","consent_id") REFERENCES "public"."patient_consents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_consents_patient_idx" ON "patient_consents" USING btree ("tenant_id","patient_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "rx_shares_prescription_idx" ON "prescription_shares" USING btree ("tenant_id","prescription_id","created_at");--> statement-breakpoint
CREATE INDEX "rx_shares_link_idx" ON "prescription_shares" USING btree ("tenant_id","share_link_id");--> statement-breakpoint
CREATE INDEX "share_links_prescription_idx" ON "share_links" USING btree ("tenant_id","prescription_id","created_at");--> statement-breakpoint
CREATE INDEX "share_links_creator_idx" ON "share_links" USING btree ("tenant_id","created_by","created_at");--> statement-breakpoint
CREATE INDEX "share_links_consent_idx" ON "share_links" USING btree ("tenant_id","consent_id");--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_share_link_fk" FOREIGN KEY ("tenant_id","share_link_id") REFERENCES "public"."share_links"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rx_outputs_share_link_idx" ON "prescription_outputs" USING btree ("tenant_id","share_link_id");--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_share_link_check" CHECK ((kind = 'shared_pdf') = (share_link_id is not null));--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_kind_check" CHECK (kind in ('pdf_download', 'browser_print', 'shared_pdf'));