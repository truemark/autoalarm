/**
 * This Class provides utility methods for parsing SQS events and
 * providing strict type and pattern matching for event records.
 */
import {SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';
import {
  ServiceEventMap,
  ValidEventSource,
  ValidEventName,
  ValidEventPatterns,
} from '../../types/index.mjs';

/**
 * EventParse class is used to parse SQS events and match them against a service event map.
 * It provides methods to extract tags, IDs, and determine if the resource is created or destroyed.
 * @template EventMap - The EventMap Generic is used to grab the literal values from the ServiceEventMap interface
 * as it is instantiated. This allows for strict type checking and pattern matching for all the event types and patterns
 * while still providing strong and flexible typing for the individual ServiceEventMaps.
 */
export class EventParse<EventMap extends ServiceEventMap> {
  private readonly log = logging.getLogger('EventParse');
  private readonly eventMap: ServiceEventMap;

  constructor(map: EventMap) {
    this.eventMap = map as ServiceEventMap;
  }

  private findTagsAndId(
    sqsRecord: SQSRecord,
    source: ValidEventSource<EventMap>,
    eventName: ValidEventName<typeof source>,
    eventPatterns: ValidEventPatterns<
      EventMap,
      typeof source,
      typeof eventName
    >,
  ): {
    tags: {tagKey: string; tagValue?: string}[] | undefined;
    id: string;
  } {
    // Extract the body from the SQS record
    const recordBody = JSON.parse(sqsRecord.body);

    const tags =
      eventPatterns.hasTags && eventPatterns.tagsKey !== null
        ? recordBody
        : undefined;
    const id = recordBody[eventPatterns.idKeyName];

    // return the full pattern match
    return {
      tags: tags,
      id: id,
    };
  }

  /**
   * Matches an SQS event record against a service event mapping for supported AutoAlarm Services.
   * @return A promise that resolves to an object containing the service name, whether the resource is destroyed or created,
   * changed tags, and the ID type, ID (ARN or resource ID), or undefined if no match is found.
   */
  async matchEvent(sqsRecord: SQSRecord): Promise<
    | {
        source: ValidEventSource<EventMap>;
        isDestroyed: boolean;
        isCreated: boolean;
        tags: {tagKey: string; tagValue?: string}[] | undefined;
        isARN: boolean;
        id: string;
      }
    | undefined
  > {
    //break out the body from the sqs record in json.
    const body = JSON.parse(sqsRecord.body);

    this.log
      .info()
      .str('Function', 'matchEvent')
      .obj('event and map', {eventMap: this.eventMap, event: body})
      .msg('Matching event against service event map');

    // Early check to make sure that the event body contains the correct source and eventName properties before proceeding
    if (
      !Object.keys(this.eventMap).includes(body.source) ||
      !Object.keys(this.eventMap).includes(body.eventName)
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

    const source = body.source satisfies ValidEventSource<EventMap>;

    const eventName = body.eventName satisfies ValidEventName<typeof source>;

    const eventPatterns = this.eventMap[source].eventName[
      eventName
    ] satisfies ValidEventPatterns<EventMap, typeof source, typeof eventName>;

    const {tags, id} = this.findTagsAndId(
      sqsRecord,
      source,
      eventName,
      eventPatterns,
    );

    // Return service name to match module, if the resource is destroyed, tags, and specify the id type
    return {
      source: source,
      isDestroyed: eventPatterns.isDestroyed,
      isCreated: eventPatterns.isCreated,
      tags: tags,
      isARN: eventPatterns.isARN,
      id: id,
    };
  }
}
