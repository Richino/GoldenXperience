import type { MajorInstrument } from "@/types/forex";

/** ISO 3166-1 alpha-2 codes for every currency in the instrument catalog. */
const CURRENCY_FLAG_CODES: Record<string, string> = {
  EUR: "eu",
  USD: "us",
  GBP: "gb",
  JPY: "jp",
  CHF: "ch",
  AUD: "au",
  CAD: "ca",
  NZD: "nz",
  CNH: "cn",
  CZK: "cz",
  DKK: "dk",
  HKD: "hk",
  HUF: "hu",
  MXN: "mx",
  NOK: "no",
  PLN: "pl",
  SEK: "se",
  SGD: "sg",
  THB: "th",
  TRY: "tr",
  ZAR: "za",
};

export function flagCodeForCurrency(currency: string) {
  return CURRENCY_FLAG_CODES[currency.toUpperCase()];
}

export function flagImageUrl(currency: string, width = 40) {
  const code = flagCodeForCurrency(currency);
  if (!code) return null;
  return `https://flagcdn.com/w${width}/${code}.png`;
}

export function currenciesFromInstrument(instrument: MajorInstrument) {
  const [base, quote] = instrument.split("_");
  return { base: base!, quote: quote! };
}

export function currenciesFromPair(pair: string) {
  const [base, quote] = pair.split("/");
  return { base: base ?? "", quote: quote ?? "" };
}

export function pairInitials(base: string) {
  return base.slice(0, 2).toUpperCase();
}
