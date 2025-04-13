import * as v from "valibot";

export const singleValSchema = v.pipe(
  v.string(),
  v.regex(/^(p|tm|tc|ts|wm)[1-9][0-9]?$/),
);



// Define rangePatternSchema for matching range patterns
export const rangePatternSchema = v.pipe(
  v.string(),
  v.check((value) => {
    // Match prefix + range format: TM(10%:90%), PR(:300), etc.
    if (!/^(TM|WM|PR|TC|TS)\([^)]*:[^)]*\)$/.test(value)) {
      return false;
    }

    // Extract just the range part between parentheses
    const rangeContent = value.substring(
      value.indexOf('(') + 1,
      value.lastIndexOf(')'),
    );

    // Split by colon
    const parts = rangeContent.split(':');
    if (parts.length !== 2) {
      return false;
    }

    const [start, end] = parts;

    // Check if each part is empty or a valid number (with optional % sign)
    const isValidPart = (part: string) => {
      if (part === '') return true;
      if (/%$/.test(part)) {
        return /^\d+(\.\d+)?%$/.test(part);
      }
      return /^\d+(\.\d+)?$/.test(part);
    };

    return isValidPart(start) && isValidPart(end);
  }, 'Must be a valid range pattern with proper prefix, parentheses, a colon, and optional values with percentage signs'),
);
