import * as v from 'valibot';

const singleValSchema = v.pipe(
  v.string(),
  v.regex(/^(p|tm|tc|ts|wm)[1-9][0-9]?$/),
);

// Define a schema for range patterns with proper parentheses

// Define rangePatternSchema for matching range patterns
const rangePatternSchema = v.pipe(
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

// Combine the schemas using v.union
const combinedSchema = v.union([singleValSchema, rangePatternSchema]);

function testValidation(
  schemaName: string,
  schema:
    | typeof combinedSchema
    | typeof rangePatternSchema
    | typeof singleValSchema,
  testCases: {input: string; shouldPass: boolean; description?: string}[],
): void {
  console.log(`\n=== Testing ${schemaName} ===`);

  let passCount = 0;
  let failCount = 0;

  testCases.forEach(({input, shouldPass, description}) => {
    try {
      const result = v.safeParse(schema, input);
      if (result.success) {
        if (shouldPass) {
          console.log(`✅ PASS: "${input}" is valid.`);
          passCount++;
        } else {
          console.log(`❌ FAIL: "${input}" passed but should have failed.`);
          failCount++;
        }
      } else {
        if (!shouldPass) {
          console.log(`✅ PASS: "${input}" is invalid as expected.\n↳ Message: ${result.issues[0]?.message}`);
          passCount++;
        } else {
          console.log(`❌ FAIL: "${input}" failed but should have passed.\n↳ Error: ${result.issues[0]?.message}`);
          failCount++;
        }
      }
    } catch (error) {
      if (shouldPass) {
        console.log(
          `❌ FAIL: "${input}" failed but should have passed. ${description || ''} `,
        );
        failCount++;
      } else {
        console.log(
          `✅ PASS: "${input}" is invalid as expected. ${description || ''}`,
        );
        passCount++;
      }
    }
  });

  console.log(`\nSummary: ${passCount} passed, ${failCount} failed`);
}

// ============= SINGLE VALUE FORMAT TESTS =============
const singleValTestCases = [
  // Percentile (p) tests
  {input: 'p1', shouldPass: true, description: 'Percentile - single digit'},
  {input: 'p5', shouldPass: true, description: 'Percentile - single digit'},
  {input: 'p50', shouldPass: true, description: 'Percentile - two digits'},
  {input: 'p90', shouldPass: true, description: 'Percentile - two digits'},
  {input: 'p95', shouldPass: true, description: 'Percentile - two digits'},
  {input: 'p99', shouldPass: true, description: 'Percentile - two digits'},

  // Trimmed Mean (tm) tests
  {input: 'tm1', shouldPass: true, description: 'Trimmed mean - single digit'},
  {input: 'tm5', shouldPass: true, description: 'Trimmed mean - single digit'},
  {input: 'tm50', shouldPass: true, description: 'Trimmed mean - two digits'},
  {input: 'tm90', shouldPass: true, description: 'Trimmed mean - two digits'},
  {input: 'tm95', shouldPass: true, description: 'Trimmed mean - two digits'},
  {input: 'tm99', shouldPass: true, description: 'Trimmed mean - two digits'},

  // Trimmed Count (tc) tests
  {input: 'tc1', shouldPass: true, description: 'Trimmed count - single digit'},
  {input: 'tc5', shouldPass: true, description: 'Trimmed count - single digit'},
  {input: 'tc50', shouldPass: true, description: 'Trimmed count - two digits'},
  {input: 'tc90', shouldPass: true, description: 'Trimmed count - two digits'},
  {input: 'tc95', shouldPass: true, description: 'Trimmed count - two digits'},
  {input: 'tc99', shouldPass: true, description: 'Trimmed count - two digits'},

  // Trimmed Sum (ts) tests
  {input: 'ts1', shouldPass: true, description: 'Trimmed sum - single digit'},
  {input: 'ts5', shouldPass: true, description: 'Trimmed sum - single digit'},
  {input: 'ts50', shouldPass: true, description: 'Trimmed sum - two digits'},
  {input: 'ts90', shouldPass: true, description: 'Trimmed sum - two digits'},
  {input: 'ts95', shouldPass: true, description: 'Trimmed sum - two digits'},
  {input: 'ts99', shouldPass: true, description: 'Trimmed sum - two digits'},

  // Winsorized Mean (wm) tests
  {
    input: 'wm1',
    shouldPass: true,
    description: 'Winsorized mean - single digit',
  },
  {
    input: 'wm5',
    shouldPass: true,
    description: 'Winsorized mean - single digit',
  },
  {
    input: 'wm50',
    shouldPass: true,
    description: 'Winsorized mean - two digits',
  },
  {
    input: 'wm90',
    shouldPass: true,
    description: 'Winsorized mean - two digits',
  },
  {
    input: 'wm95',
    shouldPass: true,
    description: 'Winsorized mean - two digits',
  },
  {
    input: 'wm98',
    shouldPass: true,
    description: 'Winsorized mean - two digits',
  },
  {
    input: 'wm99',
    shouldPass: true,
    description: 'Winsorized mean - two digits',
  },

  // Edge Cases - Numbers
  {
    input: 'p0',
    shouldPass: false,
    description: 'Invalid - zero not allowed as first digit',
  },
  {
    input: 'tm00',
    shouldPass: false,
    description: 'Invalid - leading zeros not allowed',
  },
  {
    input: 'tc100',
    shouldPass: false,
    description: 'Invalid - more than 2 digits',
  },
  {
    input: 'ts123',
    shouldPass: false,
    description: 'Invalid - more than 2 digits',
  },
  {
    input: 'wm001',
    shouldPass: false,
    description: 'Invalid - more than 2 digits with leading zero',
  },

  // Edge Cases - Case Sensitivity
  {input: 'P50', shouldPass: false, description: 'Invalid - uppercase prefix'},
  {input: 'TM90', shouldPass: false, description: 'Invalid - uppercase prefix'},
  {input: 'TC95', shouldPass: false, description: 'Invalid - uppercase prefix'},
  {input: 'TS99', shouldPass: false, description: 'Invalid - uppercase prefix'},
  {input: 'WM98', shouldPass: false, description: 'Invalid - uppercase prefix'},

  // Edge Cases - Invalid Prefixes
  {
    input: 'pr90',
    shouldPass: false,
    description: 'Invalid prefix - PR needs range format',
  },
  {
    input: 'iqm90',
    shouldPass: false,
    description: 'Invalid prefix - IQM not in single format',
  },
  {
    input: 'ab90',
    shouldPass: false,
    description: 'Invalid prefix - random letters',
  },
  {
    input: 'x99',
    shouldPass: false,
    description: 'Invalid prefix - single invalid letter',
  },

  // Edge Cases - Missing Parts
  {input: 'p', shouldPass: false, description: 'Invalid - missing digits'},
  {input: 'tm', shouldPass: false, description: 'Invalid - missing digits'},
  {input: 'tc', shouldPass: false, description: 'Invalid - missing digits'},
  {input: 'ts', shouldPass: false, description: 'Invalid - missing digits'},
  {input: 'wm', shouldPass: false, description: 'Invalid - missing digits'},

  // Edge Cases - Incorrect Format
  {
    input: '50p',
    shouldPass: false,
    description: 'Invalid - digits before prefix',
  },
  {
    input: '95tm',
    shouldPass: false,
    description: 'Invalid - digits before prefix',
  },
  {input: 'p-50', shouldPass: false, description: 'Invalid - negative number'},
  {
    input: 'tm50%',
    shouldPass: false,
    description: 'Invalid - percentage sign not allowed in single format',
  },
  {
    input: 'tc95.5',
    shouldPass: false,
    description: 'Invalid - decimal point not allowed in single format',
  },
];

// ============= RANGE PATTERN FORMAT TESTS =============
const rangePatternTestCases = [
  // ===== Trimmed Mean (TM) Range Tests =====
  // Percentage Ranges
  {
    input: 'TM(10%:90%)',
    shouldPass: true,
    description: 'TM - both bounds with percentages',
  },
  {
    input: 'TM(5%:95%)',
    shouldPass: true,
    description: 'TM - both bounds with percentages',
  },
  {
    input: 'TM(2%:98%)',
    shouldPass: true,
    description: 'TM - both bounds with percentages',
  },
  {
    input: 'TM(25%:75%)',
    shouldPass: true,
    description: 'TM - interquartile range',
  },
  {
    input: 'TM(0%:100%)',
    shouldPass: true,
    description: 'TM - full range with percentages',
  },

  // Single-Sided Ranges with Percentages
  {
    input: 'TM(:95%)',
    shouldPass: true,
    description: 'TM - only upper bound with percentage',
  },
  {
    input: 'TM(:90%)',
    shouldPass: true,
    description: 'TM - only upper bound with percentage',
  },
  {
    input: 'TM(:99%)',
    shouldPass: true,
    description: 'TM - only upper bound with percentage',
  },
  {
    input: 'TM(10%:)',
    shouldPass: true,
    description: 'TM - only lower bound with percentage',
  },
  {
    input: 'TM(25%:)',
    shouldPass: true,
    description: 'TM - only lower bound with percentage',
  },
  {
    input: 'TM(50%:)',
    shouldPass: true,
    description: 'TM - only lower bound with percentage',
  },

  // Decimal Percentages
  {
    input: 'TM(10.5%:90.5%)',
    shouldPass: true,
    description: 'TM - both bounds with decimal percentages',
  },
  {
    input: 'TM(:99.9%)',
    shouldPass: true,
    description: 'TM - upper bound with decimal percentage',
  },
  {
    input: 'TM(0.1%:)',
    shouldPass: true,
    description: 'TM - lower bound with decimal percentage',
  },

  // Absolute Values
  {
    input: 'TM(100:200)',
    shouldPass: true,
    description: 'TM - both bounds with absolute values',
  },
  {
    input: 'TM(150:1000)',
    shouldPass: true,
    description: 'TM - both bounds with absolute values',
  },
  {
    input: 'TM(0:500)',
    shouldPass: true,
    description: 'TM - both bounds with absolute values',
  },
  {
    input: 'TM(:200)',
    shouldPass: true,
    description: 'TM - only upper bound with absolute value',
  },
  {
    input: 'TM(100:)',
    shouldPass: true,
    description: 'TM - only lower bound with absolute value',
  },

  // Decimal Absolute Values
  {
    input: 'TM(0.5:10.5)',
    shouldPass: true,
    description: 'TM - both bounds with decimal absolute values',
  },
  {
    input: 'TM(:99.9)',
    shouldPass: true,
    description: 'TM - upper bound with decimal absolute value',
  },
  {
    input: 'TM(0.1:)',
    shouldPass: true,
    description: 'TM - lower bound with decimal absolute value',
  },

  // ===== Winsorized Mean (WM) Range Tests =====
  // Percentage Ranges
  {
    input: 'WM(10%:90%)',
    shouldPass: true,
    description: 'WM - both bounds with percentages',
  },
  {
    input: 'WM(5%:95%)',
    shouldPass: true,
    description: 'WM - both bounds with percentages',
  },
  {
    input: 'WM(2%:98%)',
    shouldPass: true,
    description: 'WM - both bounds with percentages',
  },
  {
    input: 'WM(25%:75%)',
    shouldPass: true,
    description: 'WM - interquartile range',
  },

  // Single-Sided Ranges with Percentages
  {
    input: 'WM(:98%)',
    shouldPass: true,
    description: 'WM - only upper bound with percentage',
  },
  {
    input: 'WM(:95%)',
    shouldPass: true,
    description: 'WM - only upper bound with percentage',
  },
  {
    input: 'WM(:90%)',
    shouldPass: true,
    description: 'WM - only upper bound with percentage',
  },
  {
    input: 'WM(80%:)',
    shouldPass: true,
    description: 'WM - only lower bound with percentage',
  },
  {
    input: 'WM(10%:)',
    shouldPass: true,
    description: 'WM - only lower bound with percentage',
  },
  {
    input: 'WM(2%:)',
    shouldPass: true,
    description: 'WM - only lower bound with percentage',
  },

  // Decimal Percentages
  {
    input: 'WM(10.5%:90.5%)',
    shouldPass: true,
    description: 'WM - both bounds with decimal percentages',
  },
  {
    input: 'WM(:99.9%)',
    shouldPass: true,
    description: 'WM - upper bound with decimal percentage',
  },
  {
    input: 'WM(0.1%:)',
    shouldPass: true,
    description: 'WM - lower bound with decimal percentage',
  },

  // Absolute Values
  {
    input: 'WM(100:200)',
    shouldPass: true,
    description: 'WM - both bounds with absolute values',
  },
  {
    input: 'WM(150:1000)',
    shouldPass: true,
    description: 'WM - both bounds with absolute values',
  },
  {
    input: 'WM(:200)',
    shouldPass: true,
    description: 'WM - only upper bound with absolute value',
  },
  {
    input: 'WM(100:)',
    shouldPass: true,
    description: 'WM - only lower bound with absolute value',
  },

  // ===== Percentile Rank (PR) Range Tests =====
  // Absolute Values
  {
    input: 'PR(:300)',
    shouldPass: true,
    description: 'PR - only upper bound with absolute value',
  },
  {
    input: 'PR(:100)',
    shouldPass: true,
    description: 'PR - only upper bound with absolute value',
  },
  {
    input: 'PR(100:)',
    shouldPass: true,
    description: 'PR - only lower bound with absolute value',
  },
  {
    input: 'PR(50:)',
    shouldPass: true,
    description: 'PR - only lower bound with absolute value',
  },
  {
    input: 'PR(100:200)',
    shouldPass: true,
    description: 'PR - both bounds with absolute values',
  },
  {
    input: 'PR(100:2000)',
    shouldPass: true,
    description: 'PR - both bounds with absolute values',
  },
  {
    input: 'PR(0:1000)',
    shouldPass: true,
    description: 'PR - both bounds with absolute values',
  },

  // Decimal Absolute Values
  {
    input: 'PR(0.5:10.5)',
    shouldPass: true,
    description: 'PR - both bounds with decimal absolute values',
  },
  {
    input: 'PR(:99.9)',
    shouldPass: true,
    description: 'PR - upper bound with decimal absolute value',
  },
  {
    input: 'PR(0.1:)',
    shouldPass: true,
    description: 'PR - lower bound with decimal absolute value',
  },

  // ===== Trimmed Count (TC) Range Tests =====
  // Percentage Ranges
  {
    input: 'TC(10%:90%)',
    shouldPass: true,
    description: 'TC - both bounds with percentages',
  },
  {
    input: 'TC(5%:95%)',
    shouldPass: true,
    description: 'TC - both bounds with percentages',
  },
  {
    input: 'TC(:95%)',
    shouldPass: true,
    description: 'TC - only upper bound with percentage',
  },
  {
    input: 'TC(10%:)',
    shouldPass: true,
    description: 'TC - only lower bound with percentage',
  },

  // Absolute Values
  {
    input: 'TC(80:500)',
    shouldPass: true,
    description: 'TC - both bounds with absolute values',
  },
  {
    input: 'TC(0:100)',
    shouldPass: true,
    description: 'TC - both bounds with absolute values',
  },
  {
    input: 'TC(:500)',
    shouldPass: true,
    description: 'TC - only upper bound with absolute value',
  },
  {
    input: 'TC(:0.5)',
    shouldPass: true,
    description: 'TC - only upper bound with decimal absolute value',
  },
  {
    input: 'TC(80:)',
    shouldPass: true,
    description: 'TC - only lower bound with absolute value',
  },

  // Decimal Values
  {
    input: 'TC(0.005:0.030)',
    shouldPass: true,
    description: 'TC - both bounds with small decimal values',
  },
  {
    input: 'TC(1.5:5.5)',
    shouldPass: true,
    description: 'TC - both bounds with decimal values',
  },
  {
    input: 'TC(:1.5)',
    shouldPass: true,
    description: 'TC - only upper bound with decimal value',
  },
  {
    input: 'TC(0.5:)',
    shouldPass: true,
    description: 'TC - only lower bound with decimal value',
  },

  // ===== Trimmed Sum (TS) Range Tests =====
  // Percentage Ranges
  {
    input: 'TS(10%:90%)',
    shouldPass: true,
    description: 'TS - both bounds with percentages',
  },
  {
    input: 'TS(5%:95%)',
    shouldPass: true,
    description: 'TS - both bounds with percentages',
  },
  {
    input: 'TS(:90%)',
    shouldPass: true,
    description: 'TS - only upper bound with percentage',
  },
  {
    input: 'TS(:95%)',
    shouldPass: true,
    description: 'TS - only upper bound with percentage',
  },
  {
    input: 'TS(80%:)',
    shouldPass: true,
    description: 'TS - only lower bound with percentage',
  },
  {
    input: 'TS(10%:)',
    shouldPass: true,
    description: 'TS - only lower bound with percentage',
  },

  // Absolute Values
  {
    input: 'TS(100:200)',
    shouldPass: true,
    description: 'TS - both bounds with absolute values',
  },
  {
    input: 'TS(0:1000)',
    shouldPass: true,
    description: 'TS - both bounds with absolute values',
  },
  {
    input: 'TS(:500)',
    shouldPass: true,
    description: 'TS - only upper bound with absolute value',
  },
  {
    input: 'TS(100:)',
    shouldPass: true,
    description: 'TS - only lower bound with absolute value',
  },

  // Decimal Values
  {
    input: 'TS(0.5:10.5)',
    shouldPass: true,
    description: 'TS - both bounds with decimal values',
  },
  {
    input: 'TS(:0.5)',
    shouldPass: true,
    description: 'TS - only upper bound with decimal value',
  },
  {
    input: 'TS(0.5:)',
    shouldPass: true,
    description: 'TS - only lower bound with decimal value',
  },

  // ===== Invalid Range Tests (All Prefixes) =====
  // Missing or Malformed Parentheses
  {
    input: 'TM10%:90%)',
    shouldPass: false,
    description: 'Invalid - missing open parenthesis',
  },
  {
    input: 'WM(10%:90%',
    shouldPass: false,
    description: 'Invalid - missing close parenthesis',
  },
  {
    input: 'PR(100:2000',
    shouldPass: false,
    description: 'Invalid - missing close parenthesis',
  },
  {
    input: 'TC80:500)',
    shouldPass: false,
    description: 'Invalid - missing open parenthesis',
  },
  {
    input: 'TS[10%:90%]',
    shouldPass: false,
    description: 'Invalid - wrong bracket type',
  },

  // Missing Colon
  {input: 'TM(10%)', shouldPass: false, description: 'Invalid - missing colon'},
  {input: 'WM(90%)', shouldPass: false, description: 'Invalid - missing colon'},
  {input: 'PR(100)', shouldPass: false, description: 'Invalid - missing colon'},
  {input: 'TC(500)', shouldPass: false, description: 'Invalid - missing colon'},
  {input: 'TS(80%)', shouldPass: false, description: 'Invalid - missing colon'},

  // Invalid Values
  {
    input: 'TM(abc:def)',
    shouldPass: false,
    description: 'Invalid - non-numeric values',
  },
  {
    input: 'WM(xyz:100)',
    shouldPass: false,
    description: 'Invalid - non-numeric lower bound',
  },
  {
    input: 'PR(100:xyz)',
    shouldPass: false,
    description: 'Invalid - non-numeric upper bound',
  },
  {
    input: 'TC(#:@)',
    shouldPass: false,
    description: 'Invalid - special characters',
  },
  {
    input: 'TS(test:value)',
    shouldPass: false,
    description: 'Invalid - text values',
  },

  // Invalid Format
  {
    input: 'TM(-10%:90%)',
    shouldPass: false,
    description: 'Invalid - negative percentage',
  },
  {
    input: 'WM(10%:-90%)',
    shouldPass: false,
    description: 'Invalid - negative percentage',
  },
  {
    input: 'PR(-100:200)',
    shouldPass: false,
    description: 'Invalid - negative absolute value',
  },
  {
    input: 'TC(100:-500)',
    shouldPass: false,
    description: 'Invalid - negative absolute value',
  },
  {
    input: 'TS(%:%)',
    shouldPass: false,
    description: 'Invalid - missing numbers before %',
  },
  {
    input: 'TM(10%,90%)',
    shouldPass: false,
    description: 'Invalid - comma instead of colon',
  },
  {
    input: 'WM(10%-90%)',
    shouldPass: false,
    description: 'Invalid - hyphen instead of colon',
  },

  // Case Sensitivity
  {
    input: 'tm(10%:90%)',
    shouldPass: false,
    description: 'Invalid - lowercase prefix with range',
  },
  {
    input: 'wm(5%:95%)',
    shouldPass: false,
    description: 'Invalid - lowercase prefix with range',
  },
  {
    input: 'pr(:300)',
    shouldPass: false,
    description: 'Invalid - lowercase prefix with range',
  },
  {
    input: 'tc(80:500)',
    shouldPass: false,
    description: 'Invalid - lowercase prefix with range',
  },
  {
    input: 'ts(80%:)',
    shouldPass: false,
    description: 'Invalid - lowercase prefix with range',
  },

  // Invalid Prefixes
  {
    input: 'XY(10%:90%)',
    shouldPass: false,
    description: 'Invalid - unknown prefix',
  },
  {
    input: 'AB(100:200)',
    shouldPass: false,
    description: 'Invalid - unknown prefix',
  },
  {
    input: 'P(95%:99%)',
    shouldPass: false,
    description: 'Invalid - P needs single value format',
  },
  {
    input: 'IQM(10%:90%)',
    shouldPass: false,
    description: 'Invalid - IQM not defined with range',
  },
];

// ============= COMBINED SCHEMA TESTS =============
// Test both valid and invalid cases from both schemas
const combinedTestCases = [
  // Valid Single Value Format Tests
  {
    input: 'p1',
    shouldPass: true,
    description: 'Valid percentile - single digit',
  },
  {
    input: 'p95',
    shouldPass: true,
    description: 'Valid percentile - two digits',
  },
  {
    input: 'p99',
    shouldPass: true,
    description: 'Valid percentile - two digits',
  },
  {
    input: 'tm50',
    shouldPass: true,
    description: 'Valid trimmed mean - two digits',
  },
  {
    input: 'tm90',
    shouldPass: true,
    description: 'Valid trimmed mean - two digits',
  },
  {
    input: 'tc95',
    shouldPass: true,
    description: 'Valid trimmed count - two digits',
  },
  {
    input: 'ts90',
    shouldPass: true,
    description: 'Valid trimmed sum - two digits',
  },
  {
    input: 'wm95',
    shouldPass: true,
    description: 'Valid winsorized mean - two digits',
  },
  {
    input: 'wm98',
    shouldPass: true,
    description: 'Valid winsorized mean - two digits',
  },

  // Valid Range Format Tests
  {
    input: 'TM(10%:90%)',
    shouldPass: true,
    description: 'Valid TM - percentage range',
  },
  {
    input: 'TM(:95%)',
    shouldPass: true,
    description: 'Valid TM - only upper bound with percentage',
  },
  {
    input: 'TM(150:1000)',
    shouldPass: true,
    description: 'Valid TM - absolute values range',
  },
  {
    input: 'WM(10%:90%)',
    shouldPass: true,
    description: 'Valid WM - percentage range',
  },
  {
    input: 'PR(100:2000)',
    shouldPass: true,
    description: 'Valid PR - absolute values range',
  },
  {
    input: 'TC(0.005:0.030)',
    shouldPass: true,
    description: 'Valid TC - decimal values range',
  },
  {
    input: 'TC(:0.5)',
    shouldPass: true,
    description: 'Valid TC - only upper bound with decimal value',
  },
  {
    input: 'TS(80%:)',
    shouldPass: true,
    description: 'Valid TS - only lower bound with percentage',
  },

  // Invalid Single Value Format Tests
  {
    input: 'p0',
    shouldPass: false,
    description: 'Invalid percentile - zero not allowed as first digit',
  },
  {
    input: 'tm100',
    shouldPass: false,
    description: 'Invalid trimmed mean - more than 2 digits',
  },
  {
    input: 'P95',
    shouldPass: false,
    description: 'Invalid percentile - uppercase not allowed',
  },
  {
    input: 'iqm90',
    shouldPass: false,
    description: 'Invalid prefix - not in single value format',
  },

  // Invalid Range Format Tests
  {
    input: 'TM(10%)',
    shouldPass: false,
    description: 'Invalid TM - missing colon',
  },
  {
    input: 'WM(abc:def)',
    shouldPass: false,
    description: 'Invalid WM - non-numeric values',
  },
  {
    input: 'PR(-100:200)',
    shouldPass: false,
    description: 'Invalid PR - negative values not allowed',
  },
  {
    input: 'XY(10%:90%)',
    shouldPass: false,
    description: 'Invalid - unknown prefix',
  },

  // Invalid Format for Both
  {input: 'xyz', shouldPass: false, description: 'Invalid - unknown prefix'},
  {
    input: 'p123',
    shouldPass: false,
    description: 'Invalid - too many digits for single value format',
  },
  {input: '123', shouldPass: false, description: 'Invalid - missing prefix'},
  {
    input: '(10%:90%)',
    shouldPass: false,
    description: 'Invalid - missing prefix for range format',
  },
  {
    input: 'PR90',
    shouldPass: false,
    description: 'Invalid - mixing formats incorrectly',
  },
];

// Run the tests
console.log('=== Starting Schema Validation Tests ===');
testValidation('Single Value Schema', singleValSchema, singleValTestCases);
testValidation(
  'Range Pattern Schema',
  rangePatternSchema,
  rangePatternTestCases,
);
testValidation('Combined Schema', combinedSchema, combinedTestCases);
console.log('=== Testing Complete ===');

//(:90%)
//(10%:)
//(10%:90%)
//10%:90%)
//(10:90%)
//(10%:90)
//(10%:)
//(:90%)
//(:99),
//(1000:),
//(1111:2222),
//(:0.1),
//(11.23:),
//(22.3:33)
