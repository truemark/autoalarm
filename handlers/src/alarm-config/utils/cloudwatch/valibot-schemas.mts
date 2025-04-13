import * as v from 'valibot';

export const singleValSchema = v.pipe(
  v.string(),
  v.regex(/^(p|tm|tc|ts|wm)[1-9][0-9]?$/),
);

/**
 * A valibot schema for validating CloudWatch extended statistics range patterns.
 *
 * This schema validates strings that represent CloudWatch extended statistics with range patterns,
 * such as TM(10%:90%), PR(:300), TC(0.005:0.030), etc.
 *
 * The schema enforces:
 * 1. Proper prefix format (TM, WM, PR, TC, or TS)
 * 2. Proper range syntax with parentheses and a colon separator
 * 3. Valid range values (either empty, numeric, or percentage-based)
 * 4. Percentage values limited to 0-99.9%
 *
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html} - AWS CloudWatch Extended Statistics Documentation
 *
 * @example
 * // Valid patterns
 * "TM(10%:90%)" - Trimmed mean using values between 10th and 90th percentiles
 * "PR(:300)" - Percentile rank of value 300 (percentage of data points ≤ 300)
 * "TC(0.005:0.030)" - Trimmed count of values between 0.005 and 0.030
 * "TS(80%:)" - Trimmed sum of values above the 80th percentile
 * "WM(:95%)" - Winsorized mean treating values above 95th percentile as equal to 95th percentile
 *
 * // Invalid patterns
 * "XX(10%:90%)" - Invalid prefix (must be TM, WM, PR, TC, or TS)
 * "TM[10%:90%]" - Invalid parentheses (must use round parentheses)
 * "TM(10%)" - Missing colon separator
 * "TM(101%:)" - Percentage value exceeds 99.9%
 * "PR(abc:def)" - Invalid range values (must be numeric or percentage)
 */
/**
 * A schema for validating CloudWatch extended statistics range patterns.
 *
 * This schema validates strings that represent CloudWatch extended statistics with range patterns,
 * such as TM(10%:90%), PR(:300), TC(0.005:0.030), etc.
 *
 * The schema enforces:
 * 1. Proper prefix format (TM, WM, PR, TC, or TS)
 * 2. Proper range syntax with parentheses and a colon separator
 * 3. Valid range values (either empty, numeric, or percentage-based)
 * 4. Percentage values limited to 0-99.9%
 * 5. Consistent value types (cannot mix percentages and absolute values)
 *
 * @see {@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html} - AWS CloudWatch Extended Statistics Documentation
 */
export const rangePatternSchema = v.pipe(
  v.string(),

  /**
   * Step 1: Validate the prefix
   *
   * This check ensures the string starts with one of the allowed prefixes:
   * - TM (Trimmed Mean)
   * - WM (Winsorized Mean)
   * - PR (Percentile Rank)
   * - TC (Trimmed Count)
   * - TS (Trimmed Sum)
   */
  v.check(
    (value) => {
      const prefix = value.substring(0, 2);
      if (!/^(TM|WM|PR|TC|TS)$/.test(prefix)) {
        return false;
      }
      return true;
    },
    (value) =>
      `Invalid prefix: "${JSON.stringify(value)}" - Must be one of TM, WM, PR, TC, or TS`,
  ),

  /**
   * Step 2: Validate the overall format with parentheses and colon
   *
   * This check ensures the string follows the basic pattern PREFIX(start:end), with:
   * - A valid prefix (already checked in Step 1)
   * - An opening parenthesis
   * - Any characters (except closing parenthesis) before a colon
   * - Any characters (except closing parenthesis) after the colon
   * - A closing parenthesis
   */
  v.check(
    (value) => {
      if (!/^(TM|WM|PR|TC|TS)\([^)]*:[^)]*\)$/.test(value)) {
        return false;
      }
      return true;
    },
    (value) =>
      `Invalid format: "${JSON.stringify(value)}" - Must follow pattern PREFIX(start:end) with parentheses and colon`,
  ),

  /**
   * Step 3: Validate the range parts
   *
   * This check extracts the content inside the parentheses and ensures it contains
   * exactly two parts separated by a single colon.
   */
  v.check(
    (value) => {
      const rangeContent = value.substring(
        value.indexOf('(') + 1,
        value.lastIndexOf(')'),
      );

      const parts = rangeContent.split(':');
      if (parts.length !== 2) {
        return false;
      }
      return true;
    },
    (value) =>
      `Invalid range format in "${JSON.stringify(value)}" - Must contain exactly one colon separator`,
  ),

  /**
   * Step 4: Validate the range values
   *
   * This check ensures each part of the range (start and end) is valid according to these rules:
   * - Empty values are allowed (e.g., TM(:90%) or TM(10%:))
   * - Percentage values must:
   *   - End with a % sign
   *   - Be between 0% and 99.9%
   *   - Follow the format of 1-2 digits with an optional decimal place, or exactly 99.9%
   * - Non-percentage values must be positive numbers (integer or decimal)
   */
  v.check(
    (value) => {
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
          const isValid = /^([0-9]{1,2}(\.[0-9])?|99\.9)%$/.test(part);
          if (!isValid) {
            return false;
          }
          return isValid;
        }

        // For non-percentage values, validate as positive numbers
        const isValid = /^\d+(\.\d+)?$/.test(part);
        if (!isValid) {
          return false;
        }
        return isValid;
      };

      const startValid = isValidPart(start);
      const endValid = isValidPart(end);

      if (!startValid || !endValid) {
        return false;
      }

      return true;
    },
    (value) =>
      `Invalid range values in "${JSON.stringify(value)}" - Values must be valid numbers or percentages`,
  ),

  /**
   * Step 5: Check for mismatched value types
   *
   * This check ensures that if both start and end values are provided, they must be
   * of the same type - either both percentages or both absolute values. It prevents
   * mixing of percentage values with absolute values in the same range.
   */
  v.check(
    (value) => {
      const rangeContent = value.substring(
        value.indexOf('(') + 1,
        value.lastIndexOf(')'),
      );

      const parts = rangeContent.split(':');
      const [start, end] = parts;

      // Check for mixed value types (one percentage, one absolute)
      if (
        (/%$/.test(start) && !/%$/.test(end) && end !== '') ||
        (/%$/.test(end) && !/%$/.test(start) && start !== '')
      ) {
        return false;
      }

      return true;
    },
    (value) =>
      `Mismatched range values in "${JSON.stringify(value)}" - Cannot mix percentage and absolute values`,
  ),
);
