import { defineConfig, WxtViteConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss()],
  } as WxtViteConfig),
  modules: ["@wxt-dev/module-react", "@wxt-dev/i18n/module"],
  manifest: {
    default_locale: "en",
    permissions: ['storage', 'tabs', 'activeTab', 'scripting'],
  },
});
