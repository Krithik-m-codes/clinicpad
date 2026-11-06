# ClinicPad — Go-to-Market and Pricing

**Version:** 0.1
**Date:** 2026-11-06
**Status:** working assumptions — validate with real invoices before fundraising or paid ads
**Companion docs:** `MARKET_RESEARCH.md`, `PRODUCT_SPEC.md`, `ROADMAP.md`

---

## 1. Strategy in one page

**Who we sell to:** the owner of a 1–5 doctor outpatient clinic in Tier 2/3 India, plus the doctor who actually writes the prescriptions. Later: polyclinics, small chains, and international solo practices.

**What we sell:** the clinic app that uses the doctor's **own prescription pad** and keeps working when the internet doesn't. The pad is the demo. Appointments, billing, WhatsApp, and owner analytics are the retention.

**Why now:** Indian clinic software is either cheap but generic (MedPrax, Medplix, MyClinicDesk), or broad but expensive and layout-forcing (HealthPlix, Eka, Practo Ray). No one owns "bring your own pad" as a category. WhatsApp is the default communication channel, and Tier 2/3 clinics are digitizing but still lose hours to paper registers.

**Wedge:** Template Studio — upload a Word/PDF pad, get an identical prescription in under 10 minutes.

**Motion:** product-led trial with concierge onboarding, amplified by doctor referrals and local resellers (IT vendors, medical reps, accountants). India first; international after Phase 5.

**Price posture:** undercut broad EMRs by 3–10×, beat cheap suites on template fidelity and owner visibility. Never compete on having the most features.

---

## 2. Segments and buying triggers

| Segment | Size | Trigger | What they buy | Willingness to pay |
|---|---|---|---|---|
| Solo doctor, own clinic | 1 doctor | Opening a clinic, tired of paper, wants WhatsApp Rx | Solo | ₹400–₹800/mo |
| Small clinic, 2–5 doctors | 2–5 doctors, 1–2 branches | Front-desk chaos, revenue leakage, owner wants reports | Clinic | ₹1,200–₹2,500/mo |
| Polyclinic / mini-chain | 5–25 doctors, 2–10 branches | Consolidation, brand consistency, doctor-wise P&L | Chain | ₹4,000–₹15,000/mo |
| International solo/allied | 1–3 clinicians | Affordable PMS, simple setup, telehealth | Starter/Practice | $19–$99/mo |
| Reseller / IT vendor | Sells to 10–100 clinics | Recurring revenue, own brand | White-label | Revenue share |

**Buying unit:** owner pays; doctor vetoes on layout and speed; receptionist vetoes on complexity. All three must say yes. Demos must therefore show the pad first, the queue second, and the owner dashboard third.

---

## 3. Packaging

### 3.1 India (INR, ex-GST)

| | **Free** | **Solo** | **Clinic** | **Chain** |
|---|---|---|---|---|
| Price (annual, per month effective) | ₹0 | **₹499** | **₹1,499** | **₹4,999** |
| Price (monthly) | ₹0 | ₹599 | ₹1,699 | ₹5,499 |
| Annual upfront | — | ₹5,988 | ₹17,988 | ₹59,988 |
| Doctors | 1 | 1 | up to 5 | up to 25 |
| Branches | 1 | 1 | 2 | 10 |
| Prescriptions | 100/mo | unlimited | unlimited | unlimited |
| Built-in templates | 1 | all | all | all |
| Own DOCX/PDF pad | — | 3 active | unlimited | unlimited |
| Document conversions | 5/mo | 100/mo | 500/mo | 2,000/mo |
| WhatsApp shares | 20/mo | pass-through | pass-through | pass-through |
| Appointments + queue | — | — | ✓ | ✓ |
| Billing + GST invoices | — | — | ✓ | ✓ |
| Owner analytics | basic | basic | ✓ | ✓ + consolidated |
| Staff roles | — | — | ✓ | ✓ + SSO |
| Audit log | 30 days | 1 year | 3 years | 7 years |
| Support | community | WhatsApp (48h) | WhatsApp (24h) + onboarding call | dedicated success |
| Branding | "Powered by ClinicPad" | own | own | own + white-label domain |
| API / webhooks | — | — | — | ✓ |

**Design rules for the gate table**

- The free tier must be genuinely useful but visibly limits the *business*, not the *doctor's* ability to treat a patient. 100 Rx/month ≈ 3–5 patients/day; enough to build the habit, not enough to run a busy clinic.
- Never watermark or degrade the clinical PDF in a way that could embarrass a doctor in front of a patient. Free-tier branding goes in the footer, small and tasteful.
- DOCX upload is the paid hook. Free users can see a locked preview of their own pad ("Your pad is ready — upgrade to print it").
- WhatsApp message costs are pass-through at Meta's price with zero markup. This is a trust feature; do not turn it into a margin centre.

### 3.2 International (USD, ex-tax)

| | **Starter** | **Practice** | **Clinic** | **Enterprise** |
|---|---|---|---|---|
| Price (annual, per month) | $19 | $49 | $99 | from $149 |
| Price (monthly) | $23 | $59 | $119 | custom |
| Clinicians | 1 | up to 5 | up to 15 | custom |
| Locations | 1 | 2 | 5 | custom |
| Templates | 3 | unlimited | unlimited | unlimited |
| Billing / payments | basic | ✓ | ✓ | ✓ |
| Analytics | basic | ✓ | ✓ | ✓ |
| SSO / audit export | — | — | ✓ | ✓ |
| Support | email | email + chat | priority | dedicated |

Launch markets after Phase 5: UAE, Singapore, UK, then US/Canada. Price against Cliniko ($45–$95), SimplePractice ($29–$99), and Jane (from ~$54), not against Indian SaaS.

### 3.3 Add-ons and services (India)

| Add-on | Price | Notes |
|---|---|---|
| Done-for-you pad setup | **₹999** one-time | Free on annual Clinic/Chain; includes 2 revisions |
| Custom template design | ₹1,499 | Designer-made DOCX/HTML pad |
| Data migration (patients + history) | ₹1,999 | From Excel/CSV or another software export |
| Extra doctor (Clinic) | ₹249/mo | Beyond 5 |
| Extra branch | ₹399/mo | Beyond included |
| On-site training | ₹1,499/session | Local partner-delivered |
| WhatsApp credit pack | at cost | Prepaid; no markup; unused credits roll over 90 days |
| Priority template SLA | ₹499/mo | 24-hour template changes |

**Why services matter:** early on, services are not a distraction — they are customer development and cash. But track the ratio. If services exceed 25% of revenue after 100 clinics, productize or hand to partners.

---

## 4. Pricing rationale

**Anchors (verify before quoting):**

- MedPrax: ~₹333–₹833/mo.
- Medplix / MyClinicDesk: ~₹499/mo.
- OPD Suite: ~₹999–₹5,999/mo.
- HealthPlix: ~₹12k–₹18k/year effective.
- Eka Care: ~₹17k–₹25k/year solo; ~₹1L/year for 5 doctors.
- Practo Ray: quote-based, usually higher.

**Our logic**

- **₹499 annual / ₹599 monthly** sits at the top of the "cheap suite" band but below broad EMRs. It is an impulse purchase for a doctor who has just seen their own pad rendered perfectly.
- **₹1,499 Clinic** is priced for the owner, not the doctor: one recovered no-show or one prevented revenue leak pays for the month.
- **₹4,999 Chain** is still 10–20× below enterprise EMR contracts and includes consolidation, which is the actual job.
- **Annual-first pricing** (2 months free) improves cash and retention. Monthly exists to reduce friction, not to be the default.
- **Free tier** is a distribution channel, not a charity. Cap prescriptions, not patients; never delete data on downgrade.

**Do not do**

- Per-message WhatsApp markup.
- Setup fees that feel like a bait-and-switch. Show the ₹999 clearly and waive it generously.
- Permanent "lifetime" discounts.
- Feature-gating basic safety (allergies, consent, audit) — those are always included.

---

## 5. Discounts and commercial policy

| Case | Discount | Approval |
|---|---|---|
| Annual prepay | 2 months free (built into price) | automatic |
| First 50 design partners | 50% for 12 months, in exchange for case study + feedback | founder |
| Medical students / residents | 40% on Solo | self-serve code |
| NGOs / charitable clinics | 50% | founder |
| Reseller | 20–35% margin depending on volume and support burden | founder |
| Multi-year | 10% additional per prepaid year | founder |

**Policy:** no discount without a reason recorded in CRM. No refunds after 14 days except statutory requirements; pro-rate annual plans on documented service failure. Pause, don't cancel, for locum/seasonal clinics (up to 3 months/year).

---

## 6. Funnel and channels

```
Awareness → Trial → Activation → Habit → Paid → Referral → Reseller
   ↑            ↑          ↑           ↑        ↑
 YouTube     Landing    10-min pad   Daily Rx  Day-7/12
 WhatsApp    Demo bot   setup        Queue     nudges
 Partners    Webinar    First PDF    Reports   Annual offer
```

### 6.1 Channels, ranked for the first 12 months

| # | Channel | Play | Cost | Why it works |
|---|---|---|---|---|
| 1 | **Doctor referrals** | In-app "refer a colleague", ₹500 credit both sides | Low | Doctors trust doctors; highest conversion |
| 2 | **Concierge onboarding** | Founder/VA digitises the pad on a WhatsApp video call | Time | Converts the wedge objection directly; produces recordings |
| 3 | **WhatsApp communities** | Local doctor groups, specialty groups; share a 60-sec pad demo | Low | Where Indian doctors actually are |
| 4 | **YouTube / Shorts (Hindi + English)** | "Apna prescription pad digital kaise karein", template teardowns, clinic ops tips | Medium | Compounding SEO; demo *is* the content |
| 5 | **Local IT vendors / resellers** | Margin + white-label; they already sell PCs, printers, billing software | Medium | Distribution and installation muscle |
| 6 | **Medical reps / distributors** | Co-marketing with pharma distributors (compliant, no inducements) | Medium | Reach Tier 2/3 clinics |
| 7 | **Accountant / CA networks** | GST-ready invoices, day-end reports | Low | Owners listen to their CA |
| 8 | **Specialty associations** | Webinars for paediatrics, derma, ortho | Medium | Template packs by specialty |
| 9 | **SEO** | "prescription format in Word", "clinic software with own letterhead", "GST invoice format for clinic" | Medium | High-intent, low competition long tail |
| 10 | **Paid ads** | Meta/Google only after Gate B, with CAC < ₹2,000 | High | Do not burn cash before retention is proven |

### 6.2 The 60-second demo (use everywhere)

1. Show a doctor's actual pad (with permission), rendered in ClinicPad.
2. Add a medicine; show the PDF update instantly.
3. Tap WhatsApp; show the patient receiving it.
4. Switch to the owner dashboard; show today's collections.
5. Say: "Your pad. Your patients. Your money. Ten minutes to set up."

### 6.3 Landing page sections

- Hero: "Your own prescription pad. Digitised in 10 minutes."
- Before/after pad slider.
- 3-step setup video.
- Specialty template gallery.
- Pricing with annual toggle.
- "Works offline" proof.
- Doctor testimonials + clinic logos (once permitted).
- WhatsApp CTA and "Book a 10-minute setup".

---

## 7. Onboarding playbook

**Self-serve target:** sign-up → clinic profile → upload pad → preview → first real prescription in **under 10 minutes**.

| Minute | Step | Friction removers |
|---|---|---|
| 0–1 | Phone OTP / Google sign-in | No credit card; no email verification wall |
| 1–3 | Clinic + doctor profile | GST/registration optional; can skip and return |
| 3–6 | Upload pad (DOCX/PDF/photo) | Drag-drop, WhatsApp upload, sample pads, "we'll do it for you" |
| 6–8 | Auto-map + preview | Show their own name and a sample patient immediately |
| 8–10 | First prescription + print/WhatsApp | Pre-filled demo patient; one-click "use sample" |
| Day 1 | Nudge: add 5 patients | Import from phone contacts/CSV |
| Day 3 | Nudge: try queue or billing | Contextual, not a feature tour |
| Day 7 | Trial check-in (WhatsApp) | Human, one question: "What's slowing you down?" |
| Day 12 | Paid conversion offer | Annual discount + setup fee waived |

**Concierge path (first 50 clinics):** collect pad on WhatsApp, digitise within 24 hours, 15-minute video call to verify, import 20 patients, watch them write the first prescription. Record the call (with consent) for training and marketing.

**Failure signals:** no pad uploaded in 24h; no prescription in 72h; 3 support messages in week 1. Trigger a human call, not an email.

---

## 8. Sales motion and objection handling

**Self-serve** for Solo. **Assisted** for Clinic/Chain (demo + onboarding call + annual quote). **Partner-led** for Chain and international.

| Objection | What they mean | Response |
|---|---|---|
| "My pad is unique, software will change it." | Fear of losing identity | "Send it. We'll digitise it free and show you the exact PDF before you pay." |
| "I'm too busy to learn software." | Time risk | "Ten minutes, on WhatsApp, we do the setup. You only type the medicine." |
| "HealthPlix/Eka is free/cheap." | Price anchor | "They're good EMRs. Do they print your pad exactly? Can you work offline? Do you get owner reports?" |
| "Internet is unreliable." | Operational risk | "Desktop app works offline and syncs when you're back." (Only say this once Phase 4 ships.) |
| "My receptionist won't use it." | Change management | "We'll train her in 15 minutes and stay on WhatsApp for week one." |
| "Is my patient data safe?" | Trust | Explain India data residency, encryption, access controls, audit, export/delete rights. Never claim certifications not held. |
| "Can I get it cheaper?" | Habit | Offer annual, not a permanent discount. Trade discount for a case study or referral. |

**Sales assets to build:** one-page PDF, 60-sec Hindi demo, 3 specialty case studies, ROI calculator (minutes saved × patients × fee), security one-pager, template gallery.

---

## 9. Unit economics (planning model)

### 9.1 India

| Input | Assumption | Note |
|---|---|---|
| Blended ARPU | ₹700/mo | Mix of Solo/Clinic/Chain + add-ons |
| Gross margin | 82% | Infra, WhatsApp pass-through, payment fees, support |
| Monthly logo churn | 2.5% | Target after Phase 3; early cohorts will be worse |
| CAC (blended) | ₹2,500 | Referrals + content + partner commissions |
| CAC payback | ~4.4 months | (2,500 / (700 × 0.82)) |
| LTV | ~₹23,000 | (700 × 0.82) / 0.025 |
| LTV/CAC | ~9× | Healthy if churn holds |
| Support cost | ₹80–₹150/clinic/mo | Falls with self-serve and partner tier |

**Break-even:** with ~₹6L/mo operating cost (2 people + infra + tools), need ~1,050 paying clinics at ₹700 ARPU / 82% GM. This is why Chain and reseller leverage matter after Gate C.

### 9.2 International

| Input | Assumption |
|---|---|
| ARPU | $39/mo |
| Gross margin | 85% |
| Monthly churn | 2.0% |
| CAC | $120 |
| LTV | ~$1,650 |
| LTV/CAC | ~13× |

International CAC is higher in absolute terms but payback is similar (~3.6 months). Do not enter until India retention is proven; support across time zones is a hidden cost.

### 9.3 Cost per clinic (order of magnitude, first 100)

| Item | ₹/clinic/mo |
|---|---|
| Postgres + storage (Supabase) | 20–40 |
| Document rendering (Gotenberg workers) | 10–25 |
| WhatsApp | pass-through (₹0 margin) |
| Email/SMS | 5–10 |
| Monitoring/error tracking | 3–5 |
| Payment gateway | ~2% of revenue |
| **Total infra** | **~₹40–₹80** |

At ₹700 ARPU, infra is ~10% of revenue. Support is the real cost driver, not servers.

---

## 10. First 90 days after Phase 2 launch

| Week | Focus | Target |
|---|---|---|
| 1–2 | Recruit 20 design partners from network and WhatsApp groups; concierge pad setup | 20 activated, 10 real prescriptions/day |
| 3–4 | Publish 10 specialty templates, landing page, 60-sec demo, pricing page | 100 trials |
| 5–6 | Convert trials; launch referral credit; sign 2 local IT resellers | 10 paying, ₹5k MRR (Gate A) |
| 7–8 | Case studies (3 specialties), YouTube demo series, CA webinar | 25 paying, 40% activation |
| 9–10 | Price test (₹499 vs ₹599), annual push, first chain pilot | 35 paying, churn < 5% |
| 11–12 | Gate A review; decide Phase 3 scope; fix top 3 activation leaks | 50 trials/wk, 15% trial→paid |

**Weekly operating cadence:** Monday metrics review (activation, prescriptions, WhatsApp share, MRR, churn, support tickets); Wednesday 3 customer calls; Friday ship one onboarding improvement.

---

## 11. Metrics that decide the business

| Stage | Metric | Target |
|---|---|---|
| Acquisition | Trial starts/week | 50 by week 12 |
| Activation | Sign-up → first real prescription < 24h | > 50% |
| Activation | Pad setup < 10 min self-serve | > 60% |
| Habit | Prescriptions/active doctor/week | > 40 |
| Habit | WhatsApp share rate | > 40% |
| Monetization | Trial → paid | > 12% |
| Monetization | Free → paid | > 8% |
| Retention | 90-day logo retention | > 85% |
| Retention | Net revenue retention | > 105% |
| Efficiency | CAC payback | < 6 months |
| Support | Tickets/clinic/month | < 1.5 |
| Trust | Prescription render failure | < 0.5% |

**Kill criteria for the wedge:** if after 100 activated clinics fewer than 25% upload their own pad and fewer than 10% cite it as the reason for buying, the wedge is wrong. Pivot to the strongest adjacent job (billing/queue) before scaling spend.

---

## 12. Launch checklist (Gate A)

- [ ] Pricing page live with annual/monthly toggle and GST-inclusive display.
- [ ] Razorpay subscriptions + webhooks tested (success, failure, refund, cancellation).
- [ ] 14-day trial with read-only expiry; data retained.
- [ ] Invoices meet GST requirements (GSTIN, HSN/SAC, place of supply).
- [ ] Terms, privacy policy, DPDP consent copy, refund policy published.
- [ ] WhatsApp opt-in and opt-out flows tested.
- [ ] Onboarding emails/WhatsApp sequence (day 0/1/3/7/12).
- [ ] Support SLA and WhatsApp number staffed.
- [ ] Status page and incident contact.
- [ ] 3 case studies and 10 template gallery entries.
- [ ] Analytics events for activation and conversion verified end-to-end.
- [ ] Refund/cancellation path tested by a real user.

---

## 13. Open commercial questions

1. Is ₹499 too low to signal quality, or right for volume? Test ₹599 vs ₹799 with the same landing page.
2. Should the free tier include DOCX upload with a print watermark? (Current: no upload, locked preview only.)
3. Is ₹999 setup a revenue line or friction? (Current: free on annual Clinic, paid on monthly/Solo.)
4. Direct Meta Cloud API vs BSP for the first 100 clinics? (Lean BSP for onboarding speed, revisit at 500.)
5. Reseller margin: 20% vs 35%? Depends on who handles support.
6. Do we sell to doctors or to owners first? (Current: doctor-led demo, owner-led close.)
7. International launch order: UAE → Singapore → UK → US? (Depends on inbound and payment rails.)
8. Annual-only after 12 months? (Improves cash, may hurt conversion in Tier 3.)
