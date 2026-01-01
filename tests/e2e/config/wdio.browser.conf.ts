import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config as baseConfig } from './wdio.conf.js';
import { getChromeExtensionPath, getFirefoxExtensionPath } from '../utils/extension-path.js';

const IS_CI = Boolean(process.env.CI);
const IS_FIREFOX = Boolean(process.env.IS_FIREFOX);

const outputDir = join(import.meta.dirname, '../../../.output');
const files = await readdir(outputDir);

// Pattern: haram-block-{version}-chrome.zip or haram-block-{version}-firefox.zip
const browserSuffix = IS_FIREFOX ? 'firefox.zip' : 'chrome.zip';
const extensionFiles = files
  .filter(file => file.startsWith('haram-block-') && file.endsWith(`-${browserSuffix}`))
  .sort((a, b) => {
    // Extract version and compare semantically
    const versionA = a.match(/haram-block-(\d+\.\d+\.\d+)/)?.[1] || '0.0.0';
    const versionB = b.match(/haram-block-(\d+\.\d+\.\d+)/)?.[1] || '0.0.0';
    return versionA.localeCompare(versionB, undefined, { numeric: true });
  });

const latestExtension = extensionFiles.at(-1);

if (!latestExtension) {
  throw new Error(`No ${browserSuffix} extension found in ${outputDir}`);
}

const extPath = join(outputDir, latestExtension);
const bundledExtension = (await readFile(extPath)).toString('base64');

const ciChromeArgs = [
  '--headless=new',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--enable-unsafe-swiftshader',
  '--disable-gpu',
  '--disable-gpu-compositing',
];

const chromeCapabilities = {
  browserName: 'chrome',
  browserVersion: 'stable',
  acceptInsecureCerts: true,
  'goog:chromeOptions': {
    args: ['--disable-dev-shm-usage', '--log-level=3', '--silent', ...(IS_CI ? ciChromeArgs : [])],
    prefs: { 'extensions.ui.developer_mode': true },
    extensions: [bundledExtension],
  },
};

const ciFirefoxPrefs = {
  // Disable GPU/hardware acceleration
  'layers.acceleration.disabled': true,
  'gfx.webrender.all': false,
  'gfx.canvas.accelerated': false,
  // Disable hardware video decoding
  'media.hardware-video-decoding.enabled': false,
  // Use software WebGL (like SwiftShader for Chrome)
  'webgl.disabled': false,
  'webgl.force-enabled': true,
  'webgl.software': true,
};

const firefoxCapabilities = {
  browserName: 'firefox',
  acceptInsecureCerts: true,
  'moz:firefoxOptions': {
    args: [...(IS_CI ? ['-headless'] : [])],
    prefs: IS_CI ? ciFirefoxPrefs : {},
  },
};

export const config: WebdriverIO.Config = {
  ...baseConfig,
  capabilities: IS_FIREFOX ? [firefoxCapabilities] : [chromeCapabilities],

  maxInstances: 1,
  logLevel: 'error',
  cucumberOpts: {
    ...baseConfig.cucumberOpts,
  },
  before: async ({ browserName }: WebdriverIO.Capabilities, _specs, browser: WebdriverIO.Browser) => {
    if (browserName === 'firefox') {
      await browser.installAddOn(bundledExtension, true);

      browser.addCommand('getExtensionPath', () => getFirefoxExtensionPath(browser));
    } else if (browserName === 'chrome') {
      browser.addCommand('getExtensionPath', () => getChromeExtensionPath(browser));
    }
  },
};
