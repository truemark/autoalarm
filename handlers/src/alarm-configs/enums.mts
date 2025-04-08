//=============================================================================
// Alarm Config Enums
//=============================================================================

// Standard statistics enum (fixed values)

export enum StandardStatistic {
  SAMPLE_COUNT = 'SampleCount',
  AVERAGE = 'Average',
  SUM = 'Sum',
  MINIMUM = 'Minimum',
  MAXIMUM = 'Maximum',
  IQM = 'IQM',
}

// Extended statistics preambles enum (method prefixes)
export enum ExtStatPrefix {
  PERCENTILE = 'p',
  TRIMMED_MEAN = 'tm',
  WINSORIZED_MEAN = 'wm',
  TRIMMED_COUNT = 'tc',
  TRIMMED_SUM = 'ts',
  PERCENTILE_RANK = 'pr',
}
