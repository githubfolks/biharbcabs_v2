export const DRIVER_DOC_TYPES = [
  { code: 'AADHAAR_FRONT', label: 'Aadhaar Card (Front)' },
  { code: 'AADHAAR_BACK', label: 'Aadhaar Card (Back)' },
  { code: 'PAN', label: 'PAN Card' },
  { code: 'DRIVING_LICENSE', label: 'Driving License (DL)' },
  { code: 'VEHICLE_RC', label: 'Vehicle RC Book' },
  { code: 'INSURANCE', label: 'Vehicle Insurance' },
  { code: 'FITNESS', label: 'Fitness Certificate' },
  { code: 'PERMIT', label: 'Commercial Permit' },
  { code: 'PUC', label: 'PUC Certificate' },
  { code: 'DRIVER_PHOTO', label: 'Driver Photo / Selfie' },
] as const;

export type DriverDocType = (typeof DRIVER_DOC_TYPES)[number]['code'];

export const VALID_DOC_TYPE_CODES = new Set<string>(DRIVER_DOC_TYPES.map((d) => d.code));
