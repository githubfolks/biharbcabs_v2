import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isWhatsAppSimulationAllowed, parseIncomingWebhookMessages } from '../lib/whatsapp';
import { DomainError, handleRouteError } from '../lib/route-errors';

describe('Code Review Hardening Regression Tests', () => {
  it('isWhatsAppSimulationAllowed requires explicit WHATSAPP_SIMULATION_MODE=true and blocks production', () => {
    const env = process.env as Record<string, string | undefined>;
    const origSim = env.WHATSAPP_SIMULATION_MODE;
    const origNodeEnv = env.NODE_ENV;
    try {
      delete env.WHATSAPP_SIMULATION_MODE;
      env.NODE_ENV = 'development';
      assert.strictEqual(isWhatsAppSimulationAllowed(), false);

      env.WHATSAPP_SIMULATION_MODE = 'true';
      env.NODE_ENV = 'development';
      assert.strictEqual(isWhatsAppSimulationAllowed(), true);

      env.WHATSAPP_SIMULATION_MODE = 'true';
      env.NODE_ENV = 'production';
      assert.strictEqual(isWhatsAppSimulationAllowed(), false);
    } finally {
      if (origSim === undefined) delete env.WHATSAPP_SIMULATION_MODE;
      else env.WHATSAPP_SIMULATION_MODE = origSim;
      if (origNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = origNodeEnv;
    }
  });

  it('parseIncomingWebhookMessages handles multiple messages and null interactive payloads safely', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '919999000001', profile: { name: 'Asha' } }],
                messages: [
                  { id: 'wamid.1', from: '919999000001', type: 'text', text: { body: 'Hi' } },
                  { id: 'wamid.2', from: '919999000001', type: 'interactive', interactive: null },
                  {
                    id: 'wamid.3',
                    from: '919999000002',
                    type: 'interactive',
                    interactive: { type: 'button_reply', button_reply: { id: 'btn_1', title: 'OK' } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const msgs = parseIncomingWebhookMessages(payload);
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[0].text, 'Hi');
    assert.strictEqual(msgs[0].customerName, 'Asha');
    assert.strictEqual(msgs[1].messageId, 'wamid.2');
    assert.strictEqual(msgs[1].buttonId, undefined);
    assert.strictEqual(msgs[2].buttonId, 'btn_1');
  });

  it('handleRouteError returns DomainError message/status and hides internal 500 error details', async () => {
    const domainRes = handleRouteError(new DomainError('Invalid booking state', 409), 'TestRoute');
    assert.strictEqual(domainRes.status, 409);
    const domainBody = await domainRes.json();
    assert.strictEqual(domainBody.error, 'Invalid booking state');

    const internalRes = handleRouteError(
      new Error('duplicate key value violates unique constraint "crm_drivers_phone_key"'),
      'TestRoute'
    );
    assert.strictEqual(internalRes.status, 500);
    const internalBody = await internalRes.json();
    assert.strictEqual(internalBody.error, 'Internal server error');
    assert.ok(!String(internalBody.error).includes('crm_drivers_phone_key'));
  });
});
