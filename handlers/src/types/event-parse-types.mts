import {TagsObject} from './module-types.mjs';
import {SQSRecord} from 'aws-lambda';

/**
 * @interface ServiceEventMap
 * Defines the structure for service event maps.
 * This interface maps service names to their respective event names and configurations.
 * @property {string} source - The eventsource name, which is a string. Usually formatted as 'aws.serviceName'.
 * @property {Array<string>} arnPattern - An array of two strings that represent the start and end patterns for an ARN.
 * Two value that are used with `indexOf()` to extract the ARN from the event message. usually the prefix of an arn
 * before the account and region and the last value is a closing double quote.
 * @property {Array<string>} resrcIdPattern - An array of two strings that represent the start and end patterns for a resource ID.
 * similar in format to arnPattern, but used for resource IDs that are not ARNs.
 * @Property {key} eventName - the literal key for the event name, which is a string.
 * @property {string} name - The event name, which is a string representing the specific event type. e.g., 'Create', 'Delete', etc.
 * @property {boolean} hasTags - Indicates if the event has tags associated with it in the event payload.
 * @property {string | null} tagsKey - The key in the event payload that contains the tags, or null if not applicable.
 * @property {string} idKeyName - The key in the event payload that contains the resource ID or ARN.
 * @property {boolean} isARN - Indicates if the event is an ARN event (true) or a resource ID event (false).
 * @property {boolean} isDestroyed - Indicates if the event represents a resource being destroyed (true) or not (false).
 * @property {boolean} isCreated - Indicates if the event represents a resource being created (true) or not (false).
 *
 */
export interface ServiceEventMap {
  [source: string]: {
    arnPattern: [string, string] | null;
    resrcIdPattern: [string, string] | null;
    eventName: {
      [name: string]: {
        hasTags: boolean;
        tagsKey: string | null;
        idKeyName: string;
        isARN: boolean;
        isDestroyed: boolean;
        isCreated: boolean;
      };
    };
  };
}

/**
 * Interface for the return object from the EventParse class.
 * Used to type the return value and then also as the input arg for service modules
 *
 */
export interface EventParseResult  {
  source: string | undefined;
  isDestroyed: boolean;
  isCreated: boolean;
  eventName: string;
  hasTags: boolean;
  tags: TagsObject | undefined;
  isARN: boolean;
  id: string;
};

/**
 * Represents an object that contains an eventParseResultMapped to the SQSRecord
 */
export interface RecordMatchPairs {
  record: SQSRecord;
  eventParseResult: EventParseResult;
}[]

export type RecordMatchPairsArray = RecordMatchPairs[];

/**
 * Defines the structure for service event maps. Passed as a generic type to
 * ensure type safety.
 * @template M - The service event map type. This should always be the
 * `ServiceEventMap` interface after instantiation to grab the key value
 * literals vs 'string' or other primitive types.
 */
export type ValidEventSource<M extends ServiceEventMap> =
  M[keyof ServiceEventMap] & string;

/**
 * Enforces valid event names from a given service event map.
 * @template S - The specific service event source from the service event map.
 */
export type ValidEventName<S extends ServiceEventMap['source'] & string> =
  ServiceEventMap[S]['eventName'] & string;

/**
 * Enforces valid event patterns for a given service and event name.
 * @template M - The service event map type. References the `ServiceEventMap` interface after instantiation.
 * Should be a ServiceEventMap interface to grab the key value literals vs 'string' or other primitive types.
 * @template S - The specific service event source from the service event map.
 * @template E - The specific event name from the service event source.
 */
export type ValidEventPatterns<
  M extends ServiceEventMap,
  S extends ServiceEventMap['source'] & string,
  E extends M[S]['eventName'] & string,
> = E extends {[name: string]: infer P} ? P : never;


