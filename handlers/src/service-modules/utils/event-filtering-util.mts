/**
 * Finds the event source from the event record and match against ServiceEventMap.
 * @param event record body to parse through
 */
function findEventSource(event: SQSRecord):
  | {
  service: `${keyof typeof ServiceEventMap}`;
  event: SQSRecord;
}
  | undefined {
  const record = JSON.parse(event.body);
  const source = record.source ? record.source : undefined;

  if (!source || !Object.keys(ServiceEventMap).includes(source))
    return undefined;

  return {service: source, event: event};
}

/**
 * Finds the event name from the event record.
 * @param service
 * @param event
 */
function findEventName(
  service: ValidEventSource,
  event: SQSRecord,
): ValidEventName<typeof service> | undefined {
  const record = JSON.parse(event.body);
  const eventName = record.eventName ? record.eventName : undefined;

  if (
    !eventName ||
    !Object.keys(ServiceEventMap[service].eventName).includes(eventName)
  )
    return undefined;

  return eventName;
}

/**
 * Finds the tags from the event record.
 * @param event record body to parse through
 * @param service service from ServiceEventMap to match against event body
 * @param eventName event name from ServiceEventMap to match against event body
 * @param eventPatterns
 */
function findTagsAndId(
  event: SQSRecord,
  service: ValidEventSource,
  eventName: ValidEventName<typeof service>,
  eventPatterns: ValidEventPatterns<typeof service, typeof eventName>,
): {
  tags: {tagKey: string; tagValue?: string}[] | undefined;
  isARN: boolean;
  id: string;
} {
  const record = JSON.parse(event.body);

  // Get tags and ID from the event record
  // TODO: might need to search here instead of do direct match once this logic is extended to other modules
  const tags = eventPatterns.hasTags
    ? record[eventPatterns.tagsKey]
    : undefined;
  const id = record[eventPatterns.idKeyName];

  // return the full pattern match
  return {
    tags: tags,
    isARN: eventPatterns.isARN,
    id: id,
  };
}

/**
 * Core event filtering function to match an event against the ServiceEventMap.
 */
function matchEvent(event: SQSRecord):
  | {
  service: ValidEventSource;
  isDestroyed: boolean;
  isCreated: boolean;
  tags: {tagKey: string; tagValue?: string}[] | undefined;
  isARN: boolean;
  id: string;
}
  | undefined {
  // Get source from the event and match against ServiceEventMap
  const service = findEventSource(event);
  if (!service) return undefined;

  // Get event name from the event and match against ServiceEventMap
  const eventName = findEventName(service.service, service.event);
  if (!eventName) return undefined;

  // get the event patterns from the ServiceEventMap and match our event to a valid service
  const eventPatterns = ServiceEventMap[service.service].eventName[eventName];
  if (!eventPatterns) return undefined;

  // Get tags and ID from the event record that matches a valid service and event pattern
  const {tags, isARN, id} = findTagsAndId(
    service.event,
    service.service,
    eventName,
    eventPatterns,
  );

  // Return service name to match module, if the resource is destoryed, tags, and specify the id type
  return {
    service: service.service,
    isDestroyed: eventPatterns.isDestroyed,
    isCreated: eventPatterns.isCreated,
    tags: tags,
    isARN: isARN,
    id: id,
  };
}
