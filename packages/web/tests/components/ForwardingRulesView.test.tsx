import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ForwardingRule } from '@freemail/shared';
import { describe, expect, it, vi } from 'vitest';
import { ForwardingRulesView } from '../../src/components/ForwardingRulesView.js';
import { callsTo, json, pathOf, renderWithApp } from '../helpers.js';

const RULE: ForwardingRule = {
  id: 'r1',
  name: 'Vendor invoices',
  enabled: true,
  senderDomains: ['billing.example.com'],
  senderAddresses: [],
  recipientDomains: [],
  recipientAddresses: [],
  forwardTo: ['alex@example.com', 'sam@example.com'],
  ignoreDmarcVerification: false,
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
};

type Handler = (body: unknown) => Response;

/** A fetch mock serving `/me`, the rule list, and per-method handlers for the rule routes. */
function api(rules: readonly ForwardingRule[], handlers: Record<string, Handler> = {}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = pathOf(url);
    const method = init?.method ?? 'GET';
    if (path === '/me') {
      return json(200, { subject: 'owner' });
    }
    if (path === '/forwarding-rules' && method === 'GET') {
      return json(200, { rules });
    }
    const handler = handlers[`${method} ${path}`];
    if (handler) {
      return handler(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

function bodyOf(call: Parameters<typeof fetch>): unknown {
  return JSON.parse(String(call[1]?.body));
}

describe('ForwardingRulesView', () => {
  it('shows an empty state with a way to create the first rule', async () => {
    renderWithApp(<ForwardingRulesView />, api([]));

    expect(await screen.findByText('No forwarding rules yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a rule' })).toBeInTheDocument();
  });

  it('lists each rule with its conditions, targets and flags', async () => {
    renderWithApp(
      <ForwardingRulesView />,
      api([
        RULE,
        {
          ...RULE,
          id: 'r2',
          name: 'Front desk',
          enabled: false,
          senderDomains: [],
          recipientAddresses: ['front@corp.example'],
          forwardTo: ['ops@example.org'],
          ignoreDmarcVerification: true,
        },
      ]),
    );

    const vendor = await screen.findByRole('listitem', { name: 'Vendor invoices' });
    expect(vendor).toHaveTextContent('From:billing.example.com');
    expect(vendor).toHaveTextContent('Forwards to:alex@example.com, sam@example.com');
    expect(within(vendor).queryByText('Paused')).not.toBeInTheDocument();

    const desk = screen.getByRole('listitem', { name: 'Front desk' });
    expect(desk).toHaveTextContent('To or Cc:front@corp.example');
    expect(desk).not.toHaveTextContent('From:');
    expect(within(desk).getByText('Paused')).toBeInTheDocument();
    expect(within(desk).getByText('Unverified senders')).toBeInTheDocument();
    expect(within(desk).getByRole('button', { name: 'Resume Front desk' })).toBeInTheDocument();
  });

  it('creates a rule from the editor, splitting domains from addresses', async () => {
    const fetchMock = api([], {
      'POST /forwarding-rules': (body) => json(201, { ...(body as object), id: 'new', createdAt: 't', updatedAt: 't' }),
    });
    renderWithApp(<ForwardingRulesView />, fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'New forwarding rule' });
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Vendor invoices' },
    });
    fireEvent.change(within(dialog).getByLabelText('From (domains or addresses)'), {
      target: { value: 'Billing.Example.com\nops@vendor.example' },
    });
    fireEvent.change(within(dialog).getByLabelText('Forward to'), {
      target: { value: 'alex@example.com, sam@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));

    const row = await screen.findByRole('listitem', { name: 'Vendor invoices' });
    expect(row).toHaveTextContent('From:billing.example.com, ops@vendor.example');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const posts = callsTo(fetchMock, '/forwarding-rules', 'POST');
    expect(posts).toHaveLength(1);
    // Sent normalized, exactly as the server's own check would leave it.
    expect(bodyOf(posts[0]!)).toEqual({
      name: 'Vendor invoices',
      enabled: true,
      senderDomains: ['billing.example.com'],
      senderAddresses: ['ops@vendor.example'],
      recipientDomains: [],
      recipientAddresses: [],
      forwardTo: ['alex@example.com', 'sam@example.com'],
      ignoreDmarcVerification: false,
    });
  });

  it('checks the rule before sending, and keeps the editor open on a problem', async () => {
    const fetchMock = api([]);
    renderWithApp(<ForwardingRulesView />, fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Half done' } });
    fireEvent.change(within(dialog).getByLabelText('Forward to'), {
      target: { value: 'ops@example.org' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Add at least one sender or recipient to match.');
    expect(callsTo(fetchMock, '/forwarding-rules', 'POST')).toHaveLength(0);
  });

  it('shows the server’s refusal in the editor', async () => {
    renderWithApp(
      <ForwardingRulesView />,
      api([], {
        'POST /forwarding-rules': () =>
          json(400, {
            error: 'invalid_request',
            message: "Can't forward to loop@corp.example: it would come straight back here.",
          }),
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Loop' } });
    fireEvent.change(within(dialog).getByLabelText('From (domains or addresses)'), {
      target: { value: 'example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Forward to'), {
      target: { value: 'loop@corp.example' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/come straight back here/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('edits a rule, starting from its stored fields', async () => {
    const fetchMock = api([RULE], {
      'PUT /forwarding-rules/r1': (body) => json(200, { ...RULE, ...(body as object) }),
    });
    renderWithApp(<ForwardingRulesView />, fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Vendor invoices' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit forwarding rule' });
    expect(within(dialog).getByLabelText('From (domains or addresses)')).toHaveValue('billing.example.com');
    expect(within(dialog).getByLabelText('Forward to')).toHaveValue('alex@example.com\nsam@example.com');
    fireEvent.change(within(dialog).getByLabelText('Forward to'), {
      target: { value: 'alex@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    const row = await screen.findByRole('listitem', { name: 'Vendor invoices' });
    await waitFor(() => expect(row).toHaveTextContent('Forwards to:alex@example.com'));
    expect(row).not.toHaveTextContent('sam@example.com');
    const puts = callsTo(fetchMock, '/forwarding-rules/r1', 'PUT');
    expect(bodyOf(puts[0]!)).toMatchObject({ forwardTo: ['alex@example.com'], enabled: true });
  });

  it('turns DMARC off only when asked, with a warning', async () => {
    const fetchMock = api([RULE], {
      'PUT /forwarding-rules/r1': (body) => json(200, { ...RULE, ...(body as object) }),
    });
    renderWithApp(<ForwardingRulesView />, fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Vendor invoices' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/claiming to be from anyone/)).not.toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'Forward even if the sender isn’t verified (skip DMARC)',
      }),
    );
    expect(within(dialog).getByText(/claiming to be from anyone/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await screen.findByText('Unverified senders');
    const puts = callsTo(fetchMock, '/forwarding-rules/r1', 'PUT');
    expect(bodyOf(puts[0]!)).toMatchObject({ ignoreDmarcVerification: true });
  });

  it('pauses and resumes a rule in place, sending its other fields unchanged', async () => {
    const fetchMock = api([RULE], {
      'PUT /forwarding-rules/r1': (body) => json(200, { ...RULE, ...(body as object) }),
    });
    renderWithApp(<ForwardingRulesView />, fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'Pause Vendor invoices' }));
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    const puts = callsTo(fetchMock, '/forwarding-rules/r1', 'PUT');
    expect(bodyOf(puts[0]!)).toEqual({
      name: RULE.name,
      enabled: false,
      senderDomains: RULE.senderDomains,
      senderAddresses: [],
      recipientDomains: [],
      recipientAddresses: [],
      forwardTo: RULE.forwardTo,
      ignoreDmarcVerification: false,
    });
    expect(screen.getByRole('button', { name: 'Resume Vendor invoices' })).toBeInTheDocument();
  });

  it('deletes a rule only after confirming', async () => {
    const fetchMock = api([RULE], {
      'DELETE /forwarding-rules/r1': () => new Response(null, { status: 204 }),
    });
    renderWithApp(<ForwardingRulesView />, fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Vendor invoices' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(callsTo(fetchMock, '/forwarding-rules/r1', 'DELETE')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Vendor invoices' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete Vendor invoices?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete rule' }));

    expect(await screen.findByText('No forwarding rules yet.')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/forwarding-rules/r1', 'DELETE')).toHaveLength(1);
  });

  it('says so when the rules can’t be loaded — never “no rules yet” — and retries', async () => {
    let failing = true;
    renderWithApp(
      <ForwardingRulesView />,
      vi.fn<typeof fetch>(async (url) => {
        if (pathOf(url) === '/me') {
          return json(200, { subject: 'owner' });
        }
        return failing ? json(500, { error: 'invalid_request', message: 'Internal error.' }) : json(200, { rules: [] });
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Internal error.');
    expect(screen.queryByText('No forwarding rules yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New rule' })).toBeDisabled();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No forwarding rules yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New rule' })).toBeEnabled();
  });
});
