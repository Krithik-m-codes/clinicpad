-- Records which renderer version drew an output (data is frozen at finalize; presentation is not).
ALTER TABLE "prescription_outputs" ADD COLUMN "renderer_version" text;