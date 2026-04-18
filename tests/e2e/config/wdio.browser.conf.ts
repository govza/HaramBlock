import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config as baseConfig } from './wdio.conf.js';
import { getExtensionPath } from '../utils/extension-path.js';

const DEBUG_CI_MODE = process.argv.includes('--debug');
export const IS_CI = Boolean(process.env.CI) || DEBUG_CI_MODE;
const IS_FIREFOX = Boolean(process.env.IS_FIREFOX);

const outputDir = resolve(import.meta.dirname, '../../../.output');

// Chrome: use unpacked extension with --load-extension (avoids "Too many properties to enumerate" error)
const chromeExtensionPath = resolve(outputDir, 'chrome-mv3');
const firefoxUnpackedExtensionPath = resolve(outputDir, 'firefox-mv3');

// Firefox: use file path for installAddOn (avoids base64 "Too many properties" error)
let firefoxExtensionPath: string | undefined;
if (IS_FIREFOX) {
  try {
    const unpackedStats = await stat(firefoxUnpackedExtensionPath);
    if (unpackedStats.isDirectory()) {
      firefoxExtensionPath = firefoxUnpackedExtensionPath;
    }
  } catch {
    // Fall back to packaged artifact below.
  }

  if (!firefoxExtensionPath) {
    const files = await readdir(outputDir);
    const firefoxZip = files
      .filter(file => file.startsWith('haram-block-') && file.endsWith('-firefox.zip'))
      .sort((a, b) => {
        const versionA = a.match(/haram-block-(\d+\.\d+\.\d+)/)?.[1] || '0.0.0';
        const versionB = b.match(/haram-block-(\d+\.\d+\.\d+)/)?.[1] || '0.0.0';
        return versionA.localeCompare(versionB, undefined, { numeric: true });
      })
      .at(-1);
    if (!firefoxZip) {
      throw new Error(`No firefox build found in ${outputDir}`);
    }
    firefoxExtensionPath = resolve(outputDir, firefoxZip);
  }
}

const ciChromeArgs = [
  ...(!DEBUG_CI_MODE ? ['--headless=new'] : []),
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
    args: [
      '--disable-dev-shm-usage',
      '--log-level=3',
      '--silent',
      `--load-extension=${chromeExtensionPath}`,
      ...(IS_CI ? ciChromeArgs : []),
    ],
    prefs: { 'extensions.ui.developer_mode': true },
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
      if (!firefoxExtensionPath) {
        throw new Error('Firefox extension path not set');
      }
      // Use raw WebDriver protocol with 'path' parameter (avoids base64 "Too many properties" error)
      await browser.call(async () => {
        const { sessionId } = browser;
        const url = `${(browser.options as { protocol: string; hostname: string; port: number }).protocol}://${(browser.options as { hostname: string }).hostname}:${(browser.options as { port: number }).port}/session/${sessionId}/moz/addon/install`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: firefoxExtensionPath, temporary: true }),
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to install addon: ${error}`);
        }
      });
    }

    browser.addCommand('getExtensionPath', () => getExtensionPath(browser));
  },
};
