import {string, check, pipe, regex, union} from 'valibot';
import {Statistic} from '@aws-sdk/client-cloudwatch';

/*****************************************************
 *                  STATISTICS SCHEMAS
 *****************************************************/

// Validate a Standard Statistic (e.g., "Average" "Maximum" "Minimum" "SampleCount" "Sum")
const standardStatSchema = pipe(
  string(),
  check(
    (value: string) => {
      // Check if the value is a valid standard statistic
      const validStandardStat = Object.values(Statistic).find(
        (stat) => stat === value,
      );

      // Fail the validation if no match is found
      return !!validStandardStat;
    },
    (value) =>
      `Invalid statistic "${JSON.stringify(value)}" - Must be one of ${Object.values(Statistic).join(', ')}`,
  ),
);

// Validate all <=3 char length extended stats (e.g., "p1" "tm22" "tc3" "ts4" "wm59", "IQM")
const singleValSchema = pipe(
  string(),
  regex(/^IQM$|(p|tm|tc|ts|wm)[1-9][0-9]?$/),
);

// Combined Range and Value-Type Validation
const rangePatternSchema = pipe(
  string(),
  check(
    (value: string) => {
      // Regexes
      const validRange = /^(TM|WM|PR|TC|TS)\([^)]*:[^)]*\)$/;
      const allZero = /^0(\.0+)?$/;
      const validPercent = /^([0-9]{1,2}(\.[0-9])?|99\.9)%$/;
      const validNumber = /^\d+(\.\d+)?$/;

      // Check if the value (e.g., "TM(0:0)") is a valid range and early failure if it is not
      if (!validRange.test(value)) return false;

      // Check if the value is a valid number or percentage
      if (validNumber.test(value) || validPercent.test(value)) return false;

      // Extract the extended Statistic expression from the value
      const rangeContent = value.substring(
        value.indexOf('(') + 1,
        value.lastIndexOf(')'),
      );

      // Split the range content into start and end parts and return false if parts > 3
      const parts = rangeContent.split(':');
      if (parts.length > 2) return false;

      // Extract the start and end parts of the range
      const [start, end] = rangeContent.split(':');

      // Check if the value is a valid number, percentage or ''
      const isValidExpression = [start, end].every(
        (part) =>
          part === '' || validNumber.test(part) || validPercent.test(part),
      );

      // Check that both start and end parts are not empty
      const isEmpty = [start, end].every((part) => part === '');

      // Check if both parts are not all zeroes.
      const isAllZero = [start, end].every((part) => allZero.test(part));

      // Checks for unbounded ranges (e.g., TM(22:) or TM(:33%)) - Valid
      const isUnbounded =
        (start === '' && !isEmpty) || (end === '' && !isEmpty);

      // Check if both parts are a mix of percentage and absolute values
      const isMixed =
        !isUnbounded && validPercent.test(start) !== validPercent.test(end);

      // check all conditions above and return true if valid regex.
      return isValidExpression && !(isEmpty || isAllZero || isMixed);
    },
    (value) =>
      `Invalid or mismatched range values in "${JSON.stringify(value)}": Must follow pattern PREFIX(start:end) with 
    parentheses and colon in addition to valid numbers or percentages, not both zero/empty, and not a mix of 
    absolute & percent.`,
  ),
);

// Union Schema to match all valid statistics (standardStatSchema | (singleValSchema | rangePatternSchema))
export const validStatSchema = union([
  // Standard Statistics
  standardStatSchema,
  // Extended Statistics
  union([singleValSchema, rangePatternSchema]),
]);

/*****************************************************
 *                  TBD SCHEMAS
 *****************************************************/
