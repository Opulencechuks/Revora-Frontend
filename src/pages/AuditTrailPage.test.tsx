import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuditTrailPage, MOCK_AUDIT_EVENTS, filterAuditEvents } from './AuditTrailPage';
import { EMPTY_FILTERS, storageKeyForUser } from '../components/AuditTrailFilters/savedFilters';
import { routes } from '../App';
import { WalletConnectionProvider } from '../components/WalletConnection/WalletConnectionContext';

function renderAuditPage(initialUrl = '/admin/audit') {
  const router = createMemoryRouter(
    [{ path: '/admin/audit', element: <AuditTrailPage /> }],
    { initialEntries: [initialUrl] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, router };
}

describe('AuditTrailPage', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/admin/audit');
  });

  it('renders the heading, filter controls, pinned sidebar, and mock events', () => {
    renderAuditPage();

    expect(screen.getByRole('heading', { level: 1, name: /audit trail/i })).toBeInTheDocument();
    const filterBar = screen.getByRole('region', { name: /audit trail filters/i });
    expect(within(filterBar).getByLabelText(/^search$/i)).toBeInTheDocument();
    expect(within(filterBar).getByLabelText(/^action$/i)).toBeInTheDocument();
    expect(within(filterBar).getByLabelText(/^actor$/i)).toBeInTheDocument();
    expect(screen.getByTestId('pinned-empty')).toBeInTheDocument();
    expect(screen.getByText('AUD-0001')).toBeInTheDocument();
    expect(screen.getByText(`${MOCK_AUDIT_EVENTS.length} rows`)).toBeInTheDocument();
  });

  it('hydrates filter state from URL search params and filters events', () => {
    renderAuditPage('/admin/audit?action=payout&actor=maria.chen');

    const filterBar = screen.getByRole('region', { name: /audit trail filters/i });
    expect(within(filterBar).getByLabelText(/^action$/i)).toHaveValue('payout');
    expect(within(filterBar).getByLabelText(/^actor$/i)).toHaveValue('maria.chen');
    expect(screen.getByText('AUD-0001')).toBeInTheDocument();
    expect(screen.queryByText('AUD-0002')).not.toBeInTheDocument();
    expect(screen.getByText('1 row')).toBeInTheDocument();
  });

  it('syncs filter changes to URL search params and clears filters', async () => {
    const user = userEvent.setup();
    const { router } = renderAuditPage();
    const filterBar = screen.getByRole('region', { name: /audit trail filters/i });

    await user.selectOptions(within(filterBar).getByLabelText(/^action$/i), 'compliance.hold');
    expect(router.state.location.search).toBe('?action=compliance.hold');
    expect(screen.getByText('AUD-0003')).toBeInTheDocument();
    expect(screen.queryByText('AUD-0001')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(router.state.location.search).toBe('');
    expect(screen.getByText(`${MOCK_AUDIT_EVENTS.length} rows`)).toBeInTheDocument();
  });

  it('saves, pins, persists, applies, unpins, and deletes saved filters', async () => {
    const user = userEvent.setup();
    const { router } = renderAuditPage();
    const filterBar = screen.getByRole('region', { name: /audit trail filters/i });

    await user.selectOptions(within(filterBar).getByLabelText(/^action$/i), 'payout');
    await user.click(screen.getByRole('button', { name: /save filter/i }));

    const dialog = screen.getByRole('dialog', { name: /save filter/i });
    await user.type(within(dialog).getByLabelText(/name/i), 'Payouts only');
    await user.type(within(dialog).getByLabelText(/description/i), 'All payout events');
    await user.click(within(dialog).getByRole('button', { name: /save and pin/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply saved search: payouts only/i })).toBeInTheDocument();

    // Verify per-user persistence in localStorage
    const stored = JSON.parse(localStorage.getItem(storageKeyForUser()) || '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Payouts only');
    expect(stored[0].pinned).toBe(true);

    // Clear filters then re-apply via pinned sidebar
    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(router.state.location.search).toBe('');

    await user.click(screen.getByRole('button', { name: /apply saved search: payouts only/i }));
    expect(router.state.location.search).toBe('?action=payout');

    // Delete saved filter
    await user.click(screen.getByRole('button', { name: /delete saved search payouts only/i }));
    expect(screen.getByTestId('pinned-empty')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKeyForUser()) || '[]')).toHaveLength(0);
  });

  it('opens an event drawer with EventDiffViewer and AuditNoteEditor', async () => {
    const user = userEvent.setup();
    renderAuditPage();

    await user.click(screen.getByText('AUD-0001'));

    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText(/AUD-0001 · payout/i)).toBeInTheDocument();
    expect(within(drawer).getByText('Disbursed Amount')).toBeInTheDocument();
    expect(within(drawer).getByText('48,250.00')).toBeInTheDocument();

    const noteTextarea = within(drawer).getByLabelText(/^audit note$/i);
    expect(noteTextarea).toHaveValue('Verified batch settlement against Stellar ledger.');

    await user.clear(noteTextarea);
    await user.type(noteTextarea, 'Updated auditor verification note.');
    expect(noteTextarea).toHaveValue('Updated auditor verification note.');
  });

  it('restores the event drawer from a deep-link permalink', () => {
    window.history.replaceState(null, '', '/admin/audit?event=AUD-0002');
    renderAuditPage('/admin/audit?event=AUD-0002');

    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText(/AUD-0002 · offering.updated/i)).toBeInTheDocument();
    expect(within(drawer).getByText('Revenue share %')).toBeInTheDocument();
  });

  it('opens ExportDialog and confirms export submission', async () => {
    const user = userEvent.setup();
    renderAuditPage();

    await user.click(screen.getByRole('button', { name: /^export$/i }));
    const dialog = screen.getByRole('dialog', { name: /export audit trail/i });
    await user.selectOptions(within(dialog).getByLabelText(/format/i), 'json');
    await user.click(within(dialog).getByRole('button', { name: /export json/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/export prepared: json/i);
  });

  it('copies the shareable URL to clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderAuditPage('/admin/audit?q=payout');

    await user.click(screen.getByRole('button', { name: /copy shareable filter url/i }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(screen.getByText(/copied url/i)).toBeInTheDocument();
  });

  it('is routed at /admin/audit and linked from Home admin section', () => {
    const homeRouter = createMemoryRouter(routes, { initialEntries: ['/'] });
    render(
      <WalletConnectionProvider>
        <RouterProvider router={homeRouter} />
      </WalletConnectionProvider>,
    );
    const link = screen.getByRole('link', { name: /audit trail/i });
    expect(link).toHaveAttribute('href', '/admin/audit');
  });

  it('filters events by query and date range', () => {
    const byQuery = filterAuditEvents(MOCK_AUDIT_EVENTS, {
      ...EMPTY_FILTERS,
      query: 'NovaGrid',
    });
    expect(byQuery.map((e) => e.id)).toEqual(['AUD-0005']);

    const byDate = filterAuditEvents(MOCK_AUDIT_EVENTS, {
      ...EMPTY_FILTERS,
      dateFrom: '2026-03-16',
      dateTo: '2026-03-17',
    });
    expect(byDate.map((e) => e.id)).toEqual(['AUD-0002', 'AUD-0003']);
  });
});
