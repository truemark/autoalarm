/**
 * Abstract base class for all service processors
 * Defines the interface and common functionality that all service-specific processors must implement
 *
 * This class serves as the foundation for the processor-based architecture, enabling:
 * 1. Service-specific optimizations (like EC2 batch processing)
 * 2. Clear separation of responsibilities per service
 * 3. Consistent error handling and failure reporting
 * 4. Extensibility for new AWS services by adding new processor implementations
 *
 * In Lambda environments, processors are initialized once and maintained across warm invocations,
 * optimizing performance while maintaining clean state boundaries.
 */
import {ServiceType, SQSFailureResponse} from "./types.mjs";
import {SQSRecord} from "aws-lambda";
import * as logging from '@nr1e/logging';
import {eventSearch} from "./processor-factory.mjs";

// TODO: Add config parsing, alarm creation, tag fetching, and other common functionality to this abstract class
export abstract class ServiceProcessor {
  protected log: logging.Logger;

  /**
   * Creates a new ServiceProcessor
   * @param serviceType The AWS service type this processor handles
   */
  //Todo: Will likely need to add tags and other info needed from describe api calls
  protected constructor(protected serviceType: ServiceType['key']) {
    this.log = logging.getLogger(`${this.serviceType}-Processor`);
  }


  /**
   * Check if this processor can handle the given record
   * @param record SQS record to check
   * @returns true if this processor can handle the record
   */
  //TODO: Ensure any class extended from this one includes handling for records without an ARN when implementing this function
  abstract canProcess(record: SQSRecord): boolean;

  /**
   * Process a batch of records for this service type
   * @param records Array of SQS records to process
   * @returns SQS failure response containing any failed records
   */
  abstract process(records: SQSRecord[]): Promise<SQSFailureResponse>;

  /**
   * Helper method to get a stringified version of a record for searching
   * @param record SQS record to stringify
   * @returns Stringified version of the record
   */
  protected getStringifiedRecord(record: SQSRecord): string {
    // For consistency with eventSearch, we use JSON.stringify(record.body)
    return JSON.stringify(record.body);
  }

  /**
   * Helper method to search for patterns in records
   * @param record SQS record to search
   * @param pattern Pattern to search for
   * @param endDelimiter Delimiter that marks the end of the pattern
   * @returns Matched string or empty string if not found
   */
  protected searchRecord(
    record: SQSRecord,
    pattern: string,
    endDelimiter: string = '"',
  ): string {
    const stringified = this.getStringifiedRecord(record);

    if (eventSearch(stringified, pattern, endDelimiter)) {
      return eventSearch(stringified, pattern, endDelimiter)!;
    } else {
      this.log
        .error()
        .str('function', 'searchRecord')
        .str('pattern', pattern)
        .str('record', stringified)
        .msg('Error searching for pattern in record');
      throw new Error(
        "Error searching for pattern in record. Event Search didn't return a value",
      );
    }
  }
}
