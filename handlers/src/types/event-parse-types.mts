/**
 * @interface ServiceEventMap
 * Defines the structure for service event maps.
 * This interface maps service names to their respective event names and configurations.
 * @property {string} source - The eventsource name, which is a string. Usually formatted as 'aws.serviceName'.
 * @property {string} name - The event name, which is a string representing the specific event type. e.g., 'Create', 'Delete', etc.
 */
export interface ServiceEventMap {
  [source: string]: {
    arnPattern: [string, string] | null,
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
