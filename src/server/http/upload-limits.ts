import { createRateLimiter } from "./rate-limit";

/** Template uploads per signed-in user and clinic: 30 an hour, per process (production also limits at the edge). */
export const TEMPLATE_UPLOAD_WINDOW_MS = 60 * 60 * 1000;
export const templateUploadLimiter = createRateLimiter({ windowMs: TEMPLATE_UPLOAD_WINDOW_MS, max: 30 });
