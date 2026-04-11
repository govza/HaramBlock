import { mkdir } from 'node:fs/promises';
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
  async afterStep(step, scenario, result) {
    if (!result.passed) {
      const screenshotsDir = join(e2eDir, 'screenshots');
      await mkdir(screenshotsDir, { recursive: true });
      const browserName = browser.capabilities.browserName ?? 'unknown';
      const timestamp = new Date()
        .toISOString()
        .replace('T', '_')
        .replace(/:/g, '-')
        .replace('.', '-')
        .replace('Z', '');
      const stepName = (step.text ?? 'unknown-step').replace(/\s+/g, '-').slice(0, 50);
      const scenarioName = (scenario.name ?? 'unknown-scenario').replace(/\s+/g, '-').slice(0, 50);
      await browser.saveScreenshot(join(screenshotsDir, `${timestamp}_${browserName}_${scenarioName}_${stepName}.png`));
    }
  },
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
    timeout: 120000,
    ignoreUndefinedDefinitions: false,
  },
};
