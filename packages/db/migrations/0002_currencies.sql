-- 0002_currencies.sql
-- ISO 4217 active currencies — mirrors packages/money/src/currencies.ts.
-- Adding a currency: update the TS file AND insert here in the same commit.

create table ledger.currencies (
  code        char(3) primary key,
  numeric     char(3) not null unique,
  minor_units int not null check (minor_units >= 0 and minor_units <= 4),
  name        text not null
);

insert into ledger.currencies (code, numeric, minor_units, name) values
  ('AED', '784', 2, 'UAE Dirham'),
  ('AUD', '036', 2, 'Australian Dollar'),
  ('BHD', '048', 3, 'Bahraini Dinar'),
  ('BRL', '986', 2, 'Brazilian Real'),
  ('CAD', '124', 2, 'Canadian Dollar'),
  ('CHF', '756', 2, 'Swiss Franc'),
  ('CLF', '990', 4, 'Unidad de Fomento (CL)'),
  ('CLP', '152', 0, 'Chilean Peso'),
  ('CNY', '156', 2, 'Yuan Renminbi'),
  ('DKK', '208', 2, 'Danish Krone'),
  ('EUR', '978', 2, 'Euro'),
  ('GBP', '826', 2, 'Pound Sterling'),
  ('HKD', '344', 2, 'Hong Kong Dollar'),
  ('IDR', '360', 2, 'Indonesian Rupiah'),
  ('INR', '356', 2, 'Indian Rupee'),
  ('JOD', '400', 3, 'Jordanian Dinar'),
  ('JPY', '392', 0, 'Japanese Yen'),
  ('KRW', '410', 0, 'South Korean Won'),
  ('KWD', '414', 3, 'Kuwaiti Dinar'),
  ('MXN', '484', 2, 'Mexican Peso'),
  ('MYR', '458', 2, 'Malaysian Ringgit'),
  ('NOK', '578', 2, 'Norwegian Krone'),
  ('NZD', '554', 2, 'New Zealand Dollar'),
  ('OMR', '512', 3, 'Omani Rial'),
  ('PHP', '608', 2, 'Philippine Peso'),
  ('PLN', '985', 2, 'Polish Zloty'),
  ('QAR', '634', 2, 'Qatari Riyal'),
  ('RUB', '643', 2, 'Russian Ruble'),
  ('SAR', '682', 2, 'Saudi Riyal'),
  ('SEK', '752', 2, 'Swedish Krona'),
  ('SGD', '702', 2, 'Singapore Dollar'),
  ('THB', '764', 2, 'Thai Baht'),
  ('TRY', '949', 2, 'Turkish Lira'),
  ('TWD', '901', 2, 'New Taiwan Dollar'),
  ('USD', '840', 2, 'US Dollar'),
  ('VND', '704', 0, 'Vietnamese Dong'),
  ('ZAR', '710', 2, 'South African Rand');
