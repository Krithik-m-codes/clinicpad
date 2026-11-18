/**
 * The EICAR anti-virus test file, assembled at run time from fragments. A contiguous copy (or a plain base64 of it) in
 * the repository makes Windows Defender quarantine the file. It is harmless by design.
 */
const PARTS = ["X5O!P%@AP[4", "\\PZX54(P^)7CC)7}", "$EICAR-STANDARD-", "ANTIVIRUS-TEST-FILE!", "$H+H*"];

export const EICAR: Buffer = Buffer.from(PARTS.join(""), "ascii");
