import {SSM} from '@aws-sdk/client-ssm';
import {boolean} from 'valibot';

// TODO: use proper typing for ARN
// TODO: use proper typing for event
// TODO: use proper typing for DynamoDB
// TODO: use proper typing for Tags

/**
 * import configs but consider importing all configs into the main function and then a passing them to the module functions.
  */

// const configs = require('./configs.mts'); // do not use this logic for reference only




/**
   * Get SSM secret ARN from event and map to RDS instance/cluster
   */
function handleRDSMappingFromSSM(tagKey: string, arn: string): string {
  return ''; // this is the rds ARN
  }


  /**
   * List all existing alarms for RDS resources
   * Here we can use a call to Dynamodb to get the list of all alarms if they exist so we can avoid making unnecessary API calls
   * this would be used just in deleting prometheus alarms.
   *
   * Use a separate function to update the dynamo db with the alarms added or removed in prometheus
   *
   * Ideally these to functions should go into alarm-configs/utils and should be agnostic enough to be used in other modules
   * to cut down on api calls to list alarms
   *
   * I think there should be two tables:
   * 1. prometheus
   * 2. Cloudwatch
   *
   * @TODO: put this into alarm-configs/utils and the export to main handler and get everything in the table
   *
   */


function dynamoListResourceEntries(arn: string): void {

  }

/**
 * Function to update DynamoDB entries for RDS instance/cluster
 * @param arn of the resource
 * @param alarmsUpdated is a record formated as {alarmName: isPut} where isPut is a boolean indicating if the alarm was added or removed
 * @param dynamoEntries is a record of the alarms in the dynamo db formatted as {resourceArn: [alarmName1, alarmName2, ...]}
 */
 function dynamoUpdateEntries(arn: string, alarmsUpdated: Record<string, boolean >[], dynamoEntries: Record<string, string[]> ): void {
for (const alarm, isPut of alarmsUpdated ) {
  if (isPut) {
    // put the alarm in the dynamo db
  } else {
    // delete the alarm from the dynamo db
  }
}

/**
 * Function to update Prometheus alarms for RDS instance/cluster
 * This should be a call to prometheus tools and our functionality there.
 * Will need to be careful to not break the existing prometheus functionality in EC2 modules.
 *
 * Update dynamo with the alarms added
 */
async function handleRDSUpdatePrometheusAlarms(tag: string): Promise<void> {
  /**
  *historically, we pulled all tags from a resource but what we should really be doing is pulling the only tag changed from
   *the event and then updating the alarms for that tag's related values.
   * @important but if autoalarm-prometheus:enabled  is set we should grab all tags
*/
  // map the tag to config object

  // update dynamo with the alarms added
  await dynamoUpdateEntries();

/**
   * Delete alarms for a specific RDS instance/cluster
 *
 * Two functions one for total clean up and one for partial alarm clean up to be used in updating alarms
 *
 * This should be a call to prometheus tools and our functionality there.
 * Will need to be careful to not break the existing prometheus functionality in EC2 modules.
 * though for any changes we make, we should make them extensible enough to be used in other modules.
 * the curren implementation is very EC2 specific.
 *
 * update dynamo with the alarms removed
 * @param isDeleteEvent is a boolean that tells this function if this is a delete event and if so to move to delete all alarms
   */
function handleRDSPromCleanup(isDeleteEvent: boolean): void {
  if (isDeleteEvent) {
    // delete all alarms
  }
  // after deleteing alarms clean up dyanmo db or update it
  await dynamoUpdateEntries();
}

function handleRDSPromAlarmDelete(alarms: string[]): void {
// delete some alarms

  // update dynamo with the alarms removed
  await dynamoUpdateEntries();
}





/**
 * This function should be the only function called from outside of this module and the entry point for this module
 * pass event
 * parse arn from ssm secret and follow logic to update to delete alarms
 */

export async function rdsPromAlarmManager(
  event: any,
  tags: Record<string, string>,

): Promise<void> {
  // get the secret ARN from the event
  const secretArn = event.secretArn;
  const tagValue = event.tagValue;


  // handle the mapping of the secret ARN to the RDS instance/cluster
  await handleRDSMappingFromSSM(tagValue, secretArn);

  //Define whether this is a delete event or autoalarm-prometheus:enabled = false then delete alarms
   const isDeleteEvent = event.eventType === 'delete' ? true : false;
  const alarmsDisabled = event.autoalarmPrometheusEnabled === false ? true : false;

  if (isDeleteEvent) await handleRDSPromCleanup(isDeleteEvent);
  if (alarmsDisabled) await handleRDSPromCleanup(isDeleteEvent);


  await
}
