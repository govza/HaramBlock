import { defineConfig, WxtViteConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import toUtf8 from "./scripts/vite-plugin-to-utf8";

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [toUtf8(), tailwindcss()],
  } as WxtViteConfig),
  modules: ["@wxt-dev/module-react", "@wxt-dev/i18n/module"],
  manifest: {
    default_locale: "en",
    permissions: ['storage', 'tabs', 'activeTab', 'scripting'],
  },
});
