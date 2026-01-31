/**
 * Prevent the background service worker from going idle by pinging the runtime API every 20 seconds.
 * This avoids the expensive reload time of the ONNX model.
 */
const keepAlive = () => setInterval(() => void browser.runtime.getPlatformInfo(), 20e3);
browser.runtime.onStartup.addListener(keepAlive);
keepAlive();
