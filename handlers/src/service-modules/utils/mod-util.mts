import {Logger} from '@nr1e/logging';

export class ModUtil {
  protected logger: Logger;
  // Add more here for fetching tags or other common utilities

  constructor(logger: Logger) {
    this.logger = logger;
  }

  log(
    level: 'error' | 'trace' | 'debug' | 'info' = 'info',
    func: string,
    msg: string,
    obj?: object,
  ): void {
    this.logger[level]().str('Function', func).obj('Data', obj).msg(msg);
  }
  // Add more here for fetching tags or other common utilities
}
