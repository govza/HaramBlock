import { BeforeAll } from '@wdio/cucumber-framework';

const setPolicyProcess = async (): Promise<void> => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);

  const policyButton = await $('[data-testid="policy-toggle"]').getElement();
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    const current = await policyButton.getAttribute('data-policy');
    if (current === 'process') break;
    // eslint-disable-next-line no-await-in-loop
    await browser.execute((el: HTMLElement) => el.click(), policyButton);
    // eslint-disable-next-line no-await-in-loop
    await browser.pause(300);
  }
};

BeforeAll(async () => {
  const IS_CI = Boolean(process.env.IS_CI);
  if (!IS_CI) return;

  try {
    await setPolicyProcess();
    await browser.pause(10_000);
  } catch (err) {
    // Best-effort warmup; don't fail the run if warmup fails.
    console.warn('Warmup skipped/failed:', (err as Error)?.message ?? err);
  }
});
