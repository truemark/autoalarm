import {Logger} from '@nr1e/logging';
import {MetricAlarmConfig, TagV2} from '../../types/index.mjs';

export class ModUtil {
  protected logger: Logger;
  // Add more here for fetching tags or other common utilities

  constructor(logger: Logger) {
    this.logger = logger;
  }

  log = (
    level: 'error' | 'trace' | 'debug' | 'info' = 'info',
    func: string,
    msg: string,
    obj?: object,
  ): void => {
    this.logger[level]().str('Function', func).obj('Data', obj).msg(msg);
  };

  /**
   * Parses an array of AWS tags and returns only those relevant to autoalarm.
   * @param tags - An array of AWS tags to be filtered. Typed the AWS way.
   * @returns An array of TagV2 objects that are relevant to autoalarm without undefined values.
   */
  public static parseTags(
    tags: Array<{Key?: string | undefined; Value?: string | undefined}>,
  ): TagV2[] {
    return tags.reduce<TagV2[]>((acc, tag) => {
      if (tag.Key?.includes('autoalarm:')) {
        acc.push(tag as TagV2);
      }
      return acc;
    }, []);
  }

  /**
   * Fetches all tag keys for a MetricAlarmsConfig[] object
   * Used to filter in api calls to get alarms, instances, tags, etc...
   * where aws api client calls allow for filtering by tag keys.
   *
   * Can accept one or more MetricAlarmConfig objects
   *
   * @param configs - An array of MetricAlarmConfig[] objects.
   *
   */
  public static getTagKeysForConfig(
    configs: Array<MetricAlarmConfig[]>,
  ): string[] {
    return Object.values(configs).flatMap((alarmConfigs) =>
      alarmConfigs.map((config) => `autoalarm:${config.tagKey}`),
    );
  }

  // Add more here for fetching tags or other common utilities
}
