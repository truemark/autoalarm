import {string, check, union, pipe, regex} from 'valibot';

// Validate single percentage, lowercase values with extended statistics.
export const singleValSchema = pipe(
  string(),
  regex(/^(p|tm|tc|ts|wm)[1-9][0-9]?$/),
);

// Prefix validation schema
export const prefixSchema = check(
  (value: string) => {
    const prefix = value.substring(0, 2);
    return /^(TM|WM|PR|TC|TS)$/.test(prefix);
  },
  (value) =>
    `Invalid prefix: "${JSON.stringify(value)}" - Must be one of TM, WM, PR, TC, or TS`,
);

// Overall format validation schema
export const formatSchema = check(
  (value: string) => {
    return /^(TM|WM|PR|TC|TS)\([^)]*:[^)]*\)$/.test(value);
  },
  (value) =>
    `Invalid format: "${JSON.stringify(value)}" - Must follow pattern PREFIX(start:end) with parentheses and colon`,
);

// Range parts validation schema
export const rangePartsSchema = check(
  (value: string) => {
    const rangeContent = value.substring(
      value.indexOf('(') + 1,
      value.lastIndexOf(')'),
    );

    const parts = rangeContent.split(':');
    return parts.length === 2;
  },
  (value) =>
    `Invalid range format in "${JSON.stringify(value)}" - Must contain exactly one colon separator with values enclosed in paranthesis.`,
);

// Range values validation schema
export const rangeValuesSchema = check(
  (value: string) => {
    const rangeContent = value.substring(
      value.indexOf('(') + 1,
      value.lastIndexOf(')'),
    );

    const parts = rangeContent.split(':');
    const [start, end] = parts;

    /**
     * Helper function to validate each part of the range
     *
     * @param {string} part - The range value to validate (either start or end)
     * @returns {boolean} - Whether the part is valid
     */
    const isValidPart = (part: string): boolean => {
      // Empty parts are valid (e.g., TM(:90%) or TM(10%:))
      if (part === '') return true;

      // Check if the part ends with a % sign (percentage format)
      if (/%$/.test(part)) {
        // Validate percentage values (must be between 0% and 99.9%)
        return /^([0-9]{1,2}(\.[0-9])?|99\.9)%$/.test(part);
      }

      // For non-percentage values, validate as positive numbers
      return /^\d+(\.\d+)?$/.test(part);
    };

    return isValidPart(start) && isValidPart(end);
  },
  (value) =>
    `Invalid range values in "${JSON.stringify(value)}" - Values must be valid numbers or percentages`,
);

// Value type matching validation schema
export const valueTypeSchema = check(
  (value: string) => {
    const rangeContent = value.substring(
      value.indexOf('(') + 1,
      value.lastIndexOf(')'),
    );

    const parts = rangeContent.split(':');
    const [start, end] = parts;

    // Check for mixed value types (one percentage, one absolute)
    //TODO: Need to validate that values aren't 0/0.0 both here and in the pattern below.
    return !(
      (/%$/.test(start) && !/%$/.test(end) && end !== '') ||
      (/%$/.test(end) && !/%$/.test(start) && start !== '')
    );
  },
  (value) =>
    `Mismatched range values in "${JSON.stringify(value)}" - Cannot mix percentage and absolute values`,
);

// Compose all schemas together into the final range pattern schema
export const rangePatternSchema = pipe(
  string(),
  prefixSchema,
  formatSchema,
  rangePartsSchema,
  rangeValuesSchema,
  valueTypeSchema,
);

export const validExtendedStatSchema = union([
  singleValSchema,
  rangePatternSchema,
]);
