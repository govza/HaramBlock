import { createI18n } from '@wxt-dev/i18n';

const i18n = createI18n();
export const t = i18n.t.bind(i18n);
