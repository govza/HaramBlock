describe('Options Page', () => {
  it('should load the options page', async () => {
    const extensionPath = await browser.getExtensionPath();
    await browser.url(`${extensionPath}/options.html`);

    const optionsPage = $('body');
    await expect(optionsPage).toBeExisting();
  });
});
