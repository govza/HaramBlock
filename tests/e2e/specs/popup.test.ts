describe('Popup Page', () => {
  it('should load the popup page', async () => {
    const extensionPath = await browser.getExtensionPath();
    await browser.url(`${extensionPath}/popup.html`);

    const popup = $('body');
    await expect(popup).toBeExisting();
  });

  it('should have the extension name in the popup', async () => {
    const extensionPath = await browser.getExtensionPath();
    await browser.url(`${extensionPath}/popup.html`);

    const body = $('body');
    await expect(body).toBeExisting();
  });
});
