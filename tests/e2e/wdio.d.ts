declare namespace WebdriverIO {
  interface Browser {
    getExtensionPath(): Promise<string>;
    installAddOn(extensionBase64: string, temporary: boolean): Promise<void>;
    addCommand<T>(name: string, func: (...args: unknown[]) => T): void;
  }
}
