/**
 * WhatsApp template definitions: the body text and quick-reply buttons BiharCabs submits to Meta for
 * approval (crm-design/whatsapp_templates.md is generated from the same content), and how each button
 * maps back to a bot action. Pure data; no server imports.
 *
 * {{n}} placeholders are filled, in order, from the params passed to notify(). Button actions use
 * {ref}, replaced with the booking (or driver) id recorded when the template was sent; a tap on the
 * button becomes that bot action (e.g. accept_ride_123), exactly as if the interactive button was tapped.
 */

export interface TemplateButton {
  /** Button label as approved by Meta (max 25 characters). Taps are matched on this label. */
  label: string;
  /** Bot action, with {ref} for the id recorded at send time. */
  action: string;
}

export interface TemplateDef {
  category: 'UTILITY';
  body: string;
  /** What each {{n}} holds, in order (for the Meta submission and for checking callers). */
  params: string[];
  buttons?: TemplateButton[];
}

export const TEMPLATE_DEFS = {
  driver_ride_alert: {
    category: 'UTILITY',
    body: 'New BiharCabs ride {{1}}: {{2}}, pickup {{3}}, cab {{4}}. Collect cash at drop: {{5}}. Your earnings: {{6}}. The first driver to accept gets the ride.',
    params: ['booking code', 'route', 'pickup date and time', 'cab type', 'cash to collect', 'driver earnings'],
    buttons: [
      { label: 'Accept', action: 'accept_ride_{ref}' },
      { label: 'Decline', action: 'decline_ride_{ref}' },
    ],
  },
  driver_trip_assigned: {
    category: 'UTILITY',
    body: 'BiharCabs has assigned you ride {{1}}: pickup at {{2}} on {{3}}. Customer: {{4}}. Collect cash at drop: {{5}}. At pickup, tap Start Trip and enter the customer\'s OTP.',
    params: ['booking code', 'pickup address', 'pickup date and time', 'customer name and phone', 'cash to collect'],
    buttons: [{ label: 'Start Trip', action: 'start_trip_{ref}' }],
  },
  driver_wakeup: {
    category: 'UTILITY',
    body: 'Reminder: BiharCabs pickup {{1}} on {{2}} at {{3}}. Please confirm you will be on time.',
    params: ['booking code', 'pickup date and time', 'pickup address'],
    buttons: [{ label: 'I am ready', action: 'wakeup_ready_{ref}' }],
  },
  driver_dues_reminder: {
    category: 'UTILITY',
    body: 'Your BiharCabs dues are {{1}}, above your credit limit of {{2}}. {{3}} Tap below to pay.',
    params: ['amount due', 'credit limit', 'what happens to rides until paid'],
    buttons: [{ label: 'Pay dues', action: 'pay_dues_{ref}' }],
  },
  driver_account_notice: {
    category: 'UTILITY',
    body: 'BiharCabs account update: {{1}}',
    params: ['notice (documents expiring or expired, account status)'],
  },
  driver_payout_sent: {
    category: 'UTILITY',
    body: 'BiharCabs paid you {{1}} by {{2}} (reference {{3}}). Amount still owed to you: {{4}}.',
    params: ['amount paid', 'payment method', 'reference', 'amount still owed'],
  },
  customer_driver_assigned: {
    category: 'UTILITY',
    body: 'Your BiharCabs booking {{1}} is confirmed. Driver: {{2}}, phone {{3}}, cab {{4}}. Pickup at {{5}} on {{6}}. Pay the driver {{7}} at drop. Your trip OTP is {{8}}: share it with the driver only when you are in the cab.',
    params: ['booking code', 'driver name', 'driver phone', 'cab type', 'pickup address', 'pickup date and time', 'cash payable to driver', 'trip OTP'],
  },
  customer_trip_otp: {
    category: 'UTILITY',
    body: 'Your trip OTP for BiharCabs booking {{1}} is {{2}}. Share it with the driver only when you are in the cab.',
    params: ['booking code', 'trip OTP'],
  },
  customer_trip_started: {
    category: 'UTILITY',
    body: 'Your BiharCabs trip {{1}} has started. Have a safe journey.',
    params: ['booking code'],
  },
  customer_trip_completed: {
    category: 'UTILITY',
    body: 'Thank you for riding with BiharCabs. Trip {{1}} is complete. Total: {{2}}. Invoice: {{3}}. How was your driver?',
    params: ['booking code', 'total amount', 'invoice number'],
    buttons: [
      { label: '5 stars', action: 'rate_trip_{ref}_5' },
      { label: '4 stars', action: 'rate_trip_{ref}_4' },
      { label: '3 stars or less', action: 'rate_trip_{ref}_low' },
    ],
  },
  customer_payment_link: {
    category: 'UTILITY',
    body: 'Pay the {{1}} advance to confirm BiharCabs booking {{2}}: {{3}} . The link is valid for {{4}} minutes. Balance payable to the driver at drop: {{5}}.',
    params: ['advance amount', 'booking code', 'payment link', 'minutes valid', 'balance payable to driver'],
  },
  customer_booking_update: {
    category: 'UTILITY',
    body: 'BiharCabs booking {{1}}: {{2}}',
    params: ['booking code', 'update (advance received, not confirmed, confirmed without advance)'],
  },
  admin_alert: {
    category: 'UTILITY',
    body: 'BiharCabs operations alert: {{1}}',
    params: ['alert'],
  },
} as const satisfies Record<string, TemplateDef>;

export type TemplateKey = keyof typeof TEMPLATE_DEFS;
