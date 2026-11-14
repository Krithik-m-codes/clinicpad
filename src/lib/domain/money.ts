export type Currency = "INR" | "USD" | "GBP" | "AED" | "SGD";

export type Money = {
  readonly amount: number;
  readonly currency: Currency;
};

export function money(amount: number, currency: Currency = "INR"): Money {
  if (!Number.isInteger(amount)) throw new Error("amount must be integer minor units");
  if (amount < 0) throw new Error("amount must be non-negative");
  return { amount, currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("currency mismatch");
  return money(a.amount + b.amount, a.currency);
}

export function formatMoney(value: Money, locale = "en-IN"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
  }).format(value.amount / 100);
}
