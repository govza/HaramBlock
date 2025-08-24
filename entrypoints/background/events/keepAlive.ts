/**
 * Prevent the background service worker from going idle by pinging the runtime API every 20 seconds.
 * This is due to the expensive load time of the tfjs model.
 * @returns
 */
const keepAlive = () => setInterval(() => void browser.runtime.getPlatformInfo(), 20e3);
browser.runtime.onStartup.addListener(keepAlive);
keepAlive();
