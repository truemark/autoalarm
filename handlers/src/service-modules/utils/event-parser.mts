/**
 * EventParse class is used to parse SQS events and match them against a service event map.
 * It provides methods to extract tags, IDs, and determine if the resource is created or destroyed.
 * @template EventMap - The EventMap Generic is used to grab the literal values from the ServiceEventMap interface
 * as it is instantiated. This allows for strict type checking and pattern matching for all the event types and patterns
 * while still providing strong and flexible typing for the individual ServiceEventMaps.
 */
import {SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {
  ServiceEventMap,
  ValidEventSource,
  ValidEventName,
  ValidEventPatterns,
  EventParseResult,
} from '../../types/index.mjs';

export class EventParse<EventMap extends ServiceEventMap> {
  private readonly log = logging.getLogger('EventParse');
  private readonly eventMap: EventMap;

  constructor(map: EventMap) {
    this.eventMap = map;
  }

  /**
   * Last hope fallback for grabbing an ARN or ResourceID if we at least know
   * the source and if the event pattern contains an ARN/resourceID.
   * @private
   */
  private idStringSearch(
    sqsRecord: SQSRecord,
    isArn: boolean,
    source: ValidEventSource<EventMap>,
  ): string | undefined {
    // early return if no arnPattern or resrcIdPattern is defined for the source and event pattern
    if (!isArn && this.eventMap[source].resrcIdPattern === null)
      return undefined;

    const patternMatch: number[] = [];

    // Grab the pattern based on whether the event is an ARN or a resource ID pattern
    const idPattern = isArn
      ? this.eventMap[source].arnPattern
      : this.eventMap[source].resrcIdPattern;

    // Some services change casing as a security measure. Make everything lower before searching.
    const normalizedBody = sqsRecord.body.toLowerCase();

    // Push the index of the start and end patterns to the patternMatch array
    patternMatch.push(normalizedBody.indexOf(idPattern![0]));
    patternMatch.push(normalizedBody.indexOf(idPattern![1], patternMatch[0]));

    // If the patternMatch array has both start and end indices and neither index returns -1, return the substring
    return patternMatch.every((index) => index !== -1)
      ? normalizedBody.substring(patternMatch[0], patternMatch[1])
      : undefined;
  }

  /**
   * Finds the ID (ARN or resource ID) from the SQS record based on the event source and event name.
   * @private
   */
  private findId(
    sqsRecord: SQSRecord,
    source: ValidEventSource<EventMap>,
    eventName: ValidEventName<typeof source>,
    eventPatterns: ValidEventPatterns<
      EventMap,
      typeof source,
      typeof eventName
    >,
  ): string | undefined {
    // Extract the body from the SQS record in json for easy parsing
    const recordBody = JSON.parse(sqsRecord.body);

    let id: string | undefined = undefined;

    // Grab the correct id prefix based on whether the event is an ARN or a resource ID
    const idPrefix = eventPatterns.isARN
      ? this.eventMap[source].arnPattern
      : this.eventMap[source].resrcIdPattern;

    // first check object key for valid id (arn or resource ID)
    recordBody.detail[eventPatterns.idKeyName] &&
    recordBody.detail[eventPatterns.idKeyName]
      .toLowerCase()
      .replace(/"/g, '')
      .startsWith(idPrefix)
      ? (id = recordBody.detail[eventPatterns.idKeyName])
      : undefined;

    // Try fallback string search for an ARN or resource ID in the SQS record body
    !id
      ? (id = this.idStringSearch(sqsRecord, eventPatterns.isARN, source))
      : undefined;

    // If all fails, log details and return undefined
    if (!id) {
      this.log
        .error()
        .str('Function', 'findTagsAndId')
        .str('source', source)
        .unknown('arnPattern', this.eventMap[source].arnPattern)
        .unknown('resrcIdPattern', this.eventMap[source].resrcIdPattern)
        .str('eventName', eventName)
        .obj('eventPattern', eventPatterns)
        .obj('sqsRecord', JSON.parse(sqsRecord.body))
        .msg(
          `No valid ID found for source: ${source}, eventName: ${eventName}. Neither JSON parsing or leaner 
          string serach succeeded. Please check logs..`,
        );
      return undefined;
    }

    return id;
  }

  /**
   * Finds the changed tags from the SQS record based on the event source and event name/pattern.
   * @private
   */
  private findChangedTags(
    sqsRecord: SQSRecord,
    source: ValidEventSource<EventMap>,
    eventName: ValidEventName<typeof source>,
    eventPatterns: ValidEventPatterns<
      EventMap,
      typeof source,
      typeof eventName
    >,
  ): Record<string, string> | undefined {
    // Early return if we know that we don't have tags for this event
    if (!eventPatterns.hasTags || eventPatterns.tagsKey === null)
      return undefined;

    // Extract the body from the SQS record in json for easy parsing
    const recordBody = JSON.parse(sqsRecord.body);

    // Grab all changed tags if they are present in the event pattern
    let tags = recordBody.detail[eventPatterns.tagsKey];

    // Filter out any non-autoalarm tags if present
    tags = tags.filter((t: Record<string, string>) => {
      return Object.keys(t).every((k) => k.startsWith('autoalarm:'));
    });

    if (!tags) {
      this.log
        .error()
        .str('Function', 'findChangedTags')
        .str('source', source)
        .str('eventName', eventName)
        .obj('eventPatterns', eventPatterns)
        .obj('sqsRecord', JSON.parse(sqsRecord.body))
        .msg(
          `No autoalarm tags found for source: ${source}, eventName: ${eventName} while event is configured to contain tags. 
          Please check logs.`,
        );
      return undefined;
    }

    return tags;
  }

  /**
   * Matches an SQS event record against a service event mapping for supported AutoAlarm Services.
   * @return A promise that resolves to an object containing the service name
   * @see {link EventParseResult} for the structure of the returned object.
   * whether the resource is destroyed or created,
   * changed tags, and the ID type, ID (ARN or resource ID), or undefined if no match is found.
   */
  async matchEvent(
    sqsRecord: SQSRecord,
  ): Promise<EventParseResult | undefined> {
    //break out the body from the sqs record in json.
    const body = JSON.parse(sqsRecord.body);

    this.log
      .info()
      .str('Function', 'matchEvent')
      .obj('event and map', {eventMap: this.eventMap, event: body})
      .msg('Matching event against service event map');

    /**
     * Early check to make sure that the event body contains the correct source
     * and eventName properties before proceeding.
     */
    if (
      !Object.keys(this.eventMap).includes(body.detail.source) ||
      !Object.keys(this.eventMap).includes(body.detail.eventName)
    ) {
      this.log
        .warn()
        .str('Function', 'matchEvent')
        .obj('event and map', {eventMap: this.eventMap, event: body})
        .msg(
          'Event body does not contain valid source or eventName properties',
        );
      return undefined;
    }

    const source = body.detail.source satisfies ValidEventSource<EventMap>;

    const eventName = body.detail.eventName satisfies ValidEventName<
      typeof source
    >;

    const eventPatterns = this.eventMap[source].eventName[
      eventName
    ] satisfies ValidEventPatterns<EventMap, typeof source, typeof eventName>;

    const tags = eventPatterns.hasTags
      ? this.findChangedTags(sqsRecord, source, eventName, eventPatterns)
      : undefined;

    const id = this.findId(sqsRecord, source, eventName, eventPatterns);

    // if we're supposed to have tag but we don't find any we need to return undefined. Logging in findChangedTags.
    if (eventPatterns.hasTags && !tags) return undefined;

    // if we don't have an id, we can't return a valid object. Logging in findId.
    if (!id) return undefined;

    return {
      source: source,
      isDestroyed: eventPatterns.isDestroyed,
      isCreated: eventPatterns.isCreated,
      eventName: eventName,
      tags: tags,
      isARN: eventPatterns.isARN,
      id: id,
    };
  }
}
