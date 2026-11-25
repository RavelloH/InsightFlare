import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";

// ISO 3166-1 alpha-2 country/territory codes. Observed and previously selected
// codes are also included verbatim, including provider-specific codes.
const COUNTRY_CODES =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  );
type Observed = {
  readonly value: string | number | boolean | null;
  readonly occurrences?: number;
};
export interface CountryFilterOption {
  readonly value: string;
  readonly label: string;
  readonly occurrences?: number;
}

export function countryFilterLabel(code: string, locale: Locale): string {
  return resolveCountryLabel(code, locale, code).label;
}

function normalizedSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLocaleLowerCase();
}

/** Search is a presentation concern; never substitute a localized name for a code. */
export function countryFilterOptions(
  locale: Locale,
  observed: readonly Observed[],
  selected: readonly string[],
  query: string,
): CountryFilterOption[] {
  const counts = new Map<string, number | undefined>();
  for (const item of observed) {
    if (typeof item.value === "string" && item.value.trim())
      counts.set(item.value, item.occurrences);
  }
  const codes = new Set([
    ...COUNTRY_CODES,
    ...counts.keys(),
    ...selected.filter(Boolean),
  ]);
  const needle = normalizedSearch(query);
  const collator = new Intl.Collator(locale === "zh-tw" ? "zh-TW" : locale, {
    sensitivity: "base",
  });
  return [...codes]
    .map((value) => ({
      value,
      label: countryFilterLabel(value, locale),
      occurrences: counts.get(value),
    }))
    .filter((option) => {
      if (!needle) return true;
      return [
        option.value,
        option.label,
        countryFilterLabel(option.value, "en"),
        ...(option.value === "GB" ? ["UK"] : []),
      ].some((label) => normalizedSearch(label).includes(needle));
    })
    .sort((a, b) => {
      const exact =
        Number(normalizedSearch(b.value) === needle) -
        Number(normalizedSearch(a.value) === needle);
      return (
        exact ||
        (b.occurrences ?? -1) - (a.occurrences ?? -1) ||
        collator.compare(a.label, b.label) ||
        a.value.localeCompare(b.value)
      );
    });
}
export function countryFilterSelection(
  options: readonly CountryFilterOption[],
  query: string,
): CountryFilterOption | undefined {
  const needle = normalizedSearch(query);
  if (!needle) return undefined;
  const exactCode = options.find(
    (option) => normalizedSearch(option.value) === needle,
  );
  if (exactCode) return exactCode;
  const exactNames = options.filter((option) =>
    [option.label, countryFilterLabel(option.value, "en")].some(
      (label) => normalizedSearch(label) === needle,
    ),
  );
  if (exactNames.length === 1) return exactNames[0];
  if (options.length === 1) return options[0];
  return undefined;
}
