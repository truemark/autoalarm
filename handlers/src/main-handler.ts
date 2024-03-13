import {initialize} from '@nr1e/logging';

export async function handler(event: unknown): Promise<void> {
  const log = await initialize({
    svc: 'AutoAlarm',
    name: 'main-handler',
    level: 'trace',
  });
  log.trace().unknown('event', event).msg('Received event');
}
