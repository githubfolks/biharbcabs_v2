/**
 * Secrets stored inside crm_settings. They are never returned by the settings API: a set secret is
 * shown as SECRET_MASK and an unset one as ''. Saving a setting with the mask (or without the field)
 * keeps the stored secret, so editing other fields in a form never wipes or leaks it.
 */

export const SECRET_MASK = '********';

export const SECRET_SETTING_FIELDS: Record<string, readonly string[]> = {
  meta_whatsapp_config: ['access_token', 'webhook_verify_token'],
  locationiq_config: ['api_key'],
};

export function maskSettingValue(key: string, value: any): any {
  const fields = SECRET_SETTING_FIELDS[key];
  if (!fields || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const masked = { ...value };
  for (const field of fields) {
    if (field in masked) masked[field] = masked[field] ? SECRET_MASK : '';
  }
  return masked;
}

export function maskSettings(all: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(all)) out[key] = maskSettingValue(key, value);
  return out;
}

/** For a save: keep each stored secret the caller did not actually replace. */
export function keepUnchangedSecrets(key: string, incoming: any, stored: any): any {
  const fields = SECRET_SETTING_FIELDS[key];
  if (!fields || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const merged = { ...incoming };
  for (const field of fields) {
    if (merged[field] === undefined || merged[field] === SECRET_MASK) {
      if (stored && typeof stored === 'object' && field in stored) merged[field] = stored[field];
      else delete merged[field];
    }
  }
  return merged;
}
