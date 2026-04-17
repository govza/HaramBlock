export const isMobile = (): boolean => {
  const caps = browser.capabilities as Record<string, unknown>;
  return caps.platformName === 'android';
};
