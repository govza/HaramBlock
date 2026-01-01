import { join } from 'node:path';

const e2eDir = join(import.meta.dirname, '..');

export const config: WebdriverIO.Config = {
  runner: 'local',
  tsConfigPath: join(e2eDir, 'tsconfig.json'),
  specs: [join(e2eDir, 'features/**/*.feature')],
  exclude: [],
  maxInstances: 10,
  capabilities: [],
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: 'cucumber',
  reporters: ['spec'],
  cucumberOpts: {
    require: [join(e2eDir, 'step-definitions/**/*.ts')],
    backtrace: false,
    requireModule: [],
    dryRun: false,
    failFast: false,
    snippets: true,
    source: true,
    strict: false,
    tagExpression: '',
    timeout: 60000,
    ignoreUndefinedDefinitions: false,
  },
};
