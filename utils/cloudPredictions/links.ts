export const PRIVACY_POLICY_URL = 'https://haramblock.com/privacy-policy';

const ERASURE_CONTACT_EMAIL = 'admin@haramblock.com';

export const erasureRequestMailto = (subject: string, body: string): string =>
  `mailto:${ERASURE_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
