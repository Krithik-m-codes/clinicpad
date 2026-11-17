/** The version key stored with every grant. A reworded text gets a new key; old grants keep theirs. */
export const SHARING_CONSENT_VERSION = "sharing-v1";
export const CONSENT_METHODS = ["verbal", "written"] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/*
 * NEEDS LEGAL REVIEW (English) and NATIVE-SPEAKER REVIEW (Hindi) before any clinic turns sharing on (Plan 1D, human
 * decision). Sharing is off per clinic until then (clinics.sharing_enabled).
 */
export const CONSENT_TEXT: Record<typeof SHARING_CONSENT_VERSION, { en: string; hi: string }> = {
  "sharing-v1": {
    en: "I agree that the clinic may send my prescription to me, or to a person I name, through WhatsApp or email, as a link that stops working after a few days. I understand that these services are run by other companies, and that I can withdraw this agreement at the clinic at any time.",
    hi: "मैं सहमत हूँ कि क्लिनिक मेरा पर्चा मुझे, या मेरे बताए व्यक्ति को, व्हाट्सऐप या ईमेल से एक ऐसे लिंक के रूप में भेज सकता है जो कुछ दिनों बाद काम करना बंद कर देता है। मैं समझता/समझती हूँ कि ये सेवाएँ दूसरी कंपनियाँ चलाती हैं, और मैं क्लिनिक में कभी भी यह सहमति वापस ले सकता/सकती हूँ।",
  },
};
