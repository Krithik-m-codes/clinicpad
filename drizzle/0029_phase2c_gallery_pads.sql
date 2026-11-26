-- Plan 2C gallery (generated, hand-edited): widen the two built-in template key CHECKs for the six gallery pads (ADR-0053).
-- Superset of the old lists, so every existing row stays valid; NOT VALID + VALIDATE keeps the lock short (0017/0018 convention).
ALTER TABLE "clinics" DROP CONSTRAINT "clinics_rx_template_check";--> statement-breakpoint
ALTER TABLE "prescription_outputs" DROP CONSTRAINT "rx_outputs_template_key_check";--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_rx_template_check" CHECK (rx_template in ('general', 'paediatric', 'derma', 'ortho', 'ent', 'gynae', 'dental', 'physio', 'ayush')) NOT VALID;--> statement-breakpoint
ALTER TABLE "clinics" VALIDATE CONSTRAINT "clinics_rx_template_check";--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_template_key_check" CHECK (template_key in ('general', 'paediatric', 'derma', 'ortho', 'ent', 'gynae', 'dental', 'physio', 'ayush', 'overlay')) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_outputs" VALIDATE CONSTRAINT "rx_outputs_template_key_check";