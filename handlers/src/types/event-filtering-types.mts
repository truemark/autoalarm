/**
 * @interface EventConfig
 * Defines the structure for event configurations used in service event maps.
 * @property {boolean} hasTags - Indicates if the event has tags associated with it.
 * @property {string | null} tagsKey - The key name used to identify the tags in the event, usually 'tags' or 'tagKeys'.
 * @property {string} idKeyName - The key name used to identify the resource in the event, which might be an ARN or a Resource ID.
 * @property {boolean} isARN - Indicates if the resource ID is an Amazon Resource Name (ARN).
 * @property {boolean} isDestroyed - Indicates if the event represents a resource that has been destroyed.
 * @property {boolean} isCreated - Indicates if the event represents a resource that has been created.
 *
 */
interface EventConfig {
  hasTags: boolean;
  tagsKey: string | null;
  idKeyName: string;
  isARN: boolean;
  isDestroyed: boolean;
  isCreated: boolean;
}

/**
 * @interface ServiceEventPatterns
 * Defines the structure for event patterns within a service event map.
 * This interface maps event names to their respective configurations.
 * @property {Record<string, EventConfig>} eventName - A record mapping event names to their configurations.
 * @important If you add a new key to this interface it will break the type safety of the filtering types below.
 * * @see {@link ValidEventPatterns} for the structure of the event patterns type.
 */
interface ServiceEventPatterns {
  eventName: Record<string, EventConfig>;
}

/**
 * @interface ServiceEventMap
 * Defines the structure for service event maps.
 * This interface maps service names to their respective event names and configurations.
 * @property {string} S - The eventsource name, which is a string. Usually formatted as 'aws.serviceName'.
 * @property {string} E - The event name, which is a string representing the specific event type. e.g., 'Create', 'Delete', etc.
 */
export interface ServiceEventMap {
  [S: string]: ServiceEventPatterns;
}

/**
 * Defines the structure for service event maps. Passed as a generic type to ensure type safety.
 * @template M - The service event map type. References the `ServiceEventMap` interface after instantiation.
 */
export type ValidEventSource<M> = keyof M;

/**
 * Extracts the valid event names from a given service event map.
 * @template M - The service event map type. References the `ServiceEventMap` interface after instantiation.
 * @template S - The specific service event source from the service event map.
 */
export type ValidEventName<M, S extends ValidEventSource<M>> = M[S] extends {
  eventName: infer E;
}
  ? keyof E
  : never;

/**
 * Extracts the valid event patterns for a given service and event name.
 * @template M - The service event map type. References the `ServiceEventMap` interface after instantiation.
 * Should be a ServiceEventMap interface to grab the key value literals vs 'string' or other primitive types.
 * @template S - The specific service event source from the service event map.
 * @template E - The specific event name from the service event source.
 */
export type ValidEventPatterns<
  M,
  S extends ValidEventSource<M>,
  E extends ValidEventName<M, S>,
> = M[S][keyof M[S]][E];
