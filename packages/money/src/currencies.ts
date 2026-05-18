/**
 * ISO 4217 active currencies — code → minor unit scale.
 *
 * Used to:
 *  - validate currency on API input,
 *  - convert minor units to display strings,
 *  - seed the `currencies` table in Postgres (see packages/db migration 0002).
 *
 * Only the currencies in active use as of ~2025. If a missing currency is needed,
 * add it here AND in the seed migration in the same commit.
 */
export interface IsoCurrency {
  /** ISO 4217 alpha-3, uppercase */
  readonly code: string;
  /** ISO 4217 numeric-3, zero-padded string */
  readonly numeric: string;
  /** Number of digits to the right of the decimal: 0 (JPY), 2 (USD), 3 (BHD), 4 (CLF) */
  readonly minorUnits: number;
  /** Display name */
  readonly name: string;
}

export const ISO_4217: ReadonlyArray<IsoCurrency> = [
  { code: 'AED', numeric: '784', minorUnits: 2, name: 'UAE Dirham' },
  { code: 'AUD', numeric: '036', minorUnits: 2, name: 'Australian Dollar' },
  { code: 'BHD', numeric: '048', minorUnits: 3, name: 'Bahraini Dinar' },
  { code: 'BRL', numeric: '986', minorUnits: 2, name: 'Brazilian Real' },
  { code: 'CAD', numeric: '124', minorUnits: 2, name: 'Canadian Dollar' },
  { code: 'CHF', numeric: '756', minorUnits: 2, name: 'Swiss Franc' },
  { code: 'CLF', numeric: '990', minorUnits: 4, name: 'Unidad de Fomento (CL)' },
  { code: 'CLP', numeric: '152', minorUnits: 0, name: 'Chilean Peso' },
  { code: 'CNY', numeric: '156', minorUnits: 2, name: 'Yuan Renminbi' },
  { code: 'DKK', numeric: '208', minorUnits: 2, name: 'Danish Krone' },
  { code: 'EUR', numeric: '978', minorUnits: 2, name: 'Euro' },
  { code: 'GBP', numeric: '826', minorUnits: 2, name: 'Pound Sterling' },
  { code: 'HKD', numeric: '344', minorUnits: 2, name: 'Hong Kong Dollar' },
  { code: 'IDR', numeric: '360', minorUnits: 2, name: 'Indonesian Rupiah' },
  { code: 'INR', numeric: '356', minorUnits: 2, name: 'Indian Rupee' },
  { code: 'JOD', numeric: '400', minorUnits: 3, name: 'Jordanian Dinar' },
  { code: 'JPY', numeric: '392', minorUnits: 0, name: 'Japanese Yen' },
  { code: 'KRW', numeric: '410', minorUnits: 0, name: 'South Korean Won' },
  { code: 'KWD', numeric: '414', minorUnits: 3, name: 'Kuwaiti Dinar' },
  { code: 'MXN', numeric: '484', minorUnits: 2, name: 'Mexican Peso' },
  { code: 'MYR', numeric: '458', minorUnits: 2, name: 'Malaysian Ringgit' },
  { code: 'NOK', numeric: '578', minorUnits: 2, name: 'Norwegian Krone' },
  { code: 'NZD', numeric: '554', minorUnits: 2, name: 'New Zealand Dollar' },
  { code: 'OMR', numeric: '512', minorUnits: 3, name: 'Omani Rial' },
  { code: 'PHP', numeric: '608', minorUnits: 2, name: 'Philippine Peso' },
  { code: 'PLN', numeric: '985', minorUnits: 2, name: 'Polish Zloty' },
  { code: 'QAR', numeric: '634', minorUnits: 2, name: 'Qatari Riyal' },
  { code: 'RUB', numeric: '643', minorUnits: 2, name: 'Russian Ruble' },
  { code: 'SAR', numeric: '682', minorUnits: 2, name: 'Saudi Riyal' },
  { code: 'SEK', numeric: '752', minorUnits: 2, name: 'Swedish Krona' },
  { code: 'SGD', numeric: '702', minorUnits: 2, name: 'Singapore Dollar' },
  { code: 'THB', numeric: '764', minorUnits: 2, name: 'Thai Baht' },
  { code: 'TRY', numeric: '949', minorUnits: 2, name: 'Turkish Lira' },
  { code: 'TWD', numeric: '901', minorUnits: 2, name: 'New Taiwan Dollar' },
  { code: 'USD', numeric: '840', minorUnits: 2, name: 'US Dollar' },
  { code: 'VND', numeric: '704', minorUnits: 0, name: 'Vietnamese Dong' },
  { code: 'ZAR', numeric: '710', minorUnits: 2, name: 'South African Rand' },
];

const BY_CODE: ReadonlyMap<string, IsoCurrency> = new Map(ISO_4217.map((c) => [c.code, c]));

export type CurrencyCode = (typeof ISO_4217)[number]['code'];

export function getCurrency(code: string): IsoCurrency | undefined {
  return BY_CODE.get(code.toUpperCase());
}

export function isSupportedCurrency(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}
