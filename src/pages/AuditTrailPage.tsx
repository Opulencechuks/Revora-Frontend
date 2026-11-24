import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BookmarkPlus,
  Check,
  Download,
  Link2,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import LedgerTable, { type Column } from '../components/LedgerTable/LedgerTable';
import {
  type AuditFilterState,
  type SavedFilter,
  EMPTY_FILTERS,
  createSavedFilter,
  filtersFromSearchParams,
  filtersToSearchParams,
  hasActiveFilters,
  loadSavedFilters,
  movePinned,
  persistSavedFilters,
  removeSavedFilter,
  togglePinned,
} from '../components/AuditTrailFilters/savedFilters';
import { PinnedSearchSidebar } from '../components/AuditTrailFilters/PinnedSearchSidebar';
import { SaveFilterDialog } from '../components/AuditTrailFilters/SaveFilterDialog';
import {
  ExportDialog,
  type ExportFormat,
  type ExportScope,
} from '../components/AuditTrailFilters/ExportDialog';
import {
  EventDiffViewer,
  type EventDiff,
} from '../components/EventDiffViewer/EventDiffViewer';
import { AuditNoteEditor } from '../components/AuditNoteEditor';
import '../components/AuditTrailFilters/AuditTrailFilters.css';

export interface AuditEvent {
  id: string;
  timestamp: string;
  date: string;
  action: 'payout' | 'investment' | 'offering.updated' | 'kyc.approved' | 'compliance.hold' | 'login';
  actor: string;
  entity: string;
  summary: string;
  status: 'confirmed' | 'pending' | 'failed';
  diff: EventDiff;
  initialNote?: string;
}

const DRAWER_PARAM = 'event';

export const AUDIT_ACTIONS: Array<{ value: AuditEvent['action']; label: string }> = [
  { value: 'payout', label: 'Payout' },
  { value: 'investment', label: 'Investment' },
  { value: 'offering.updated', label: 'Offering updated' },
  { value: 'kyc.approved', label: 'KYC approved' },
  { value: 'compliance.hold', label: 'Compliance hold' },
  { value: 'login', label: 'Login' },
];

export const MOCK_AUDIT_EVENTS: AuditEvent[] = [
  {
    id: 'AUD-0001',
    timestamp: '2026-03-18 14:22:10 UTC',
    date: '2026-03-18',
    action: 'payout',
    actor: 'maria.chen',
    entity: 'Payout #PAY-882',
    summary: 'Disbursed Q1 revenue share to 42 investors',
    status: 'confirmed',
    diff: {
      eventType: 'payout.disbursed',
      fields: [
        { label: 'Status', before: 'pending', after: 'confirmed' },
        { label: 'Disbursed Amount', before: '0.00 USDC', after: '48,250.00 USDC' },
        { label: 'Transaction Hash', after: '9f8e7d6c5b4a3210fedcba' },
      ],
    },
    initialNote: 'Verified batch settlement against Stellar ledger.',
  },
  {
    id: 'AUD-0002',
    timestamp: '2026-03-17 09:45:03 UTC',
    date: '2026-03-17',
    action: 'offering.updated',
    actor: 'david.okonkwo',
    entity: 'Offering #OFF-104',
    summary: 'Updated revenue share cap and minimum ticket size',
    status: 'confirmed',
    diff: {
      eventType: 'offering.updated',
      fields: [
        { label: 'Revenue share %', before: '6.5%', after: '7.0%' },
        { label: 'Minimum ticket', before: '$1,000', after: '$500' },
        { label: 'Cap multiple', before: '2.0x', after: '2.25x' },
      ],
    },
  },
  {
    id: 'AUD-0003',
    timestamp: '2026-03-16 18:11:47 UTC',
    date: '2026-03-16',
    action: 'compliance.hold',
    actor: 'elena.rostova',
    entity: 'Investor #INV-309',
    summary: 'Placed temporary compliance hold pending source-of-funds review',
    status: 'pending',
    diff: {
      eventType: 'compliance.hold.created',
      fields: [
        { label: 'Hold status', before: 'none', after: 'active' },
        { label: 'Reason', after: 'Source-of-funds documentation requested' },
        { label: 'Tax ID', before: '__redacted__', after: '__redacted__' },
      ],
    },
  },
  {
    id: 'AUD-0004',
    timestamp: '2026-03-15 11:04:19 UTC',
    date: '2026-03-15',
    action: 'payout',
    actor: 'system',
    entity: 'Payout #PAY-879',
    summary: 'Automated payout attempt failed due to missing trustline',
    status: 'failed',
    diff: {
      eventType: 'payout.failed',
      fields: [
        { label: 'Status', before: 'pending', after: 'failed' },
        { label: 'Error code', after: 'op_no_trust' },
        { label: 'Retry count', before: 0, after: 1 },
      ],
    },
  },
  {
    id: 'AUD-0005',
    timestamp: '2026-03-14 16:30:00 UTC',
    date: '2026-03-14',
    action: 'kyc.approved',
    actor: 'maria.chen',
    entity: 'Issuer #ISS-019',
    summary: 'Approved KYB/KYC package for NovaGrid Energy',
    status: 'confirmed',
    diff: {
      eventType: 'kyc.approved',
      fields: [
        { label: 'KYC status', before: 'in_review', after: 'approved' },
        { label: 'Reviewed by', after: 'maria.chen' },
      ],
    },
  },
  {
    id: 'AUD-0006',
    timestamp: '2026-03-12 08:15:22 UTC',
    date: '2026-03-12',
    action: 'investment',
    actor: 'james.wilson',
    entity: 'Investment #INV-941',
    summary: 'Recorded 25,000 USDC subscription in Offering #OFF-104',
    status: 'confirmed',
    diff: {
      eventType: 'investment.settled',
      fields: [
        { label: 'Amount', after: '25,000.00 USDC' },
        { label: 'Status', before: 'pending', after: 'confirmed' },
      ],
    },
  },
  {
    id: 'AUD-0007',
    timestamp: '2026-03-10 21:02:55 UTC',
    date: '2026-03-10',
    action: 'login',
    actor: 'elena.rostova',
    entity: 'Session #SES-4410',
    summary: 'Admin sign-in verified with hardware 2FA key',
    status: 'confirmed',
    diff: {
      eventType: 'auth.login',
      fields: [
        { label: 'MFA method', after: 'WebAuthn' },
        { label: 'IP address', after: '198.51.100.42' },
      ],
    },
  },
  {
    id: 'AUD-0008',
    timestamp: '2026-03-08 13:49:11 UTC',
    date: '2026-03-08',
    action: 'offering.updated',
    actor: 'david.okonkwo',
    entity: 'Offering #OFF-101',
    summary: 'Closed offering window after reaching target raise',
    status: 'confirmed',
    diff: {
      eventType: 'offering.closed',
      fields: [
        { label: 'State', before: 'open', after: 'closed' },
        { label: 'Total raised', before: '490,000 USDC', after: '500,000 USDC' },
      ],
    },
  },
];

export function filterAuditEvents(
  events: AuditEvent[],
  filters: AuditFilterState,
): AuditEvent[] {
  const query = filters.query.trim().toLowerCase();
  const action = filters.action.trim().toLowerCase();
  const actor = filters.actor.trim().toLowerCase();
  const dateFrom = filters.dateFrom.trim();
  const dateTo = filters.dateTo.trim();

  return events.filter((event) => {
    if (action && event.action.toLowerCase() !== action) return false;
    if (actor && !event.actor.toLowerCase().includes(actor)) return false;
    if (dateFrom && event.date < dateFrom) return false;
    if (dateTo && event.date > dateTo) return false;
    if (query) {
      const haystack = `${event.id} ${event.actor} ${event.action} ${event.entity} ${event.summary}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

const columns: Column<AuditEvent>[] = [
  {
    key: 'id',
    label: 'Event ID',
    width: '110px',
    render: (row) => <span className="font-mono text-xs">{row.id}</span>,
  },
  {
    key: 'timestamp',
    label: 'Timestamp',
    width: '185px',
    render: (row) => <span className="text-xs">{row.timestamp}</span>,
  },
  {
    key: 'action',
    label: 'Action',
    width: '150px',
    render: (row) => (
      <span className="lt-type-badge">{row.action}</span>
    ),
  },
  {
    key: 'actor',
    label: 'Actor',
    width: '140px',
    render: (row) => <span className="font-mono text-xs">{row.actor}</span>,
  },
  {
    key: 'entity',
    label: 'Entity',
    width: '160px',
    render: (row) => row.entity,
  },
  {
    key: 'status',
    label: 'Status',
    width: '110px',
    render: (row) => (
      <span className={`lt-status lt-status--${row.status}`}>{row.status}</span>
    ),
  },
  {
    key: 'summary',
    label: 'Summary',
    render: (row) => <span className="text-sm">{row.summary}</span>,
  },
];

export const AuditTrailPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams]);

  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(() => loadSavedFilters());
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [copyLinkState, setCopyLinkState] = useState<'idle' | 'copied'>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [notesByEvent, setNotesByEvent] = useState<Record<string, string>>({});

  const updateFilters = useCallback(
    (next: AuditFilterState) => {
      const nextParams = filtersToSearchParams(next);
      const currentEvent =
        new URLSearchParams(window.location.search).get(DRAWER_PARAM) ??
        searchParams.get(DRAWER_PARAM);
      if (currentEvent) {
        nextParams.set(DRAWER_PARAM, currentEvent);
      }
      setSearchParams(nextParams, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const handleFilterFieldChange = useCallback(
    (field: keyof AuditFilterState, value: string) => {
      setActiveFilterId(null);
      updateFilters({ ...filters, [field]: value });
    },
    [filters, updateFilters],
  );

  const handleClearFilters = useCallback(() => {
    setActiveFilterId(null);
    updateFilters(EMPTY_FILTERS);
  }, [updateFilters]);

  const handleSaveFilter = useCallback(
    (name: string, description: string) => {
      const created = createSavedFilter(name, description, filters, { pinned: true });
      setSavedFilters((prev) => {
        const next = [...prev, created];
        persistSavedFilters(next);
        return next;
      });
      setActiveFilterId(created.id);
      setSaveDialogOpen(false);
      setStatusMessage(`Saved and pinned filter "${created.name}".`);
    },
    [filters],
  );

  const handleApplySavedFilter = useCallback(
    (saved: SavedFilter) => {
      setActiveFilterId(saved.id);
      updateFilters(saved.filters);
    },
    [updateFilters],
  );

  const handleMoveSavedFilter = useCallback((id: string, direction: -1 | 1) => {
    setSavedFilters((prev) => {
      const next = movePinned(prev, id, direction);
      persistSavedFilters(next);
      return next;
    });
  }, []);

  const handleUnpinSavedFilter = useCallback((id: string) => {
    setSavedFilters((prev) => {
      const next = togglePinned(prev, id);
      persistSavedFilters(next);
      return next;
    });
  }, []);

  const handleDeleteSavedFilter = useCallback((id: string) => {
    setSavedFilters((prev) => {
      const next = removeSavedFilter(prev, id);
      persistSavedFilters(next);
      return next;
    });
    setActiveFilterId((current) => (current === id ? null : current));
  }, []);

  const handleCopyUrl = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(window.location.href);
      setCopyLinkState('copied');
      window.setTimeout(() => setCopyLinkState('idle'), 2000);
    } catch {
      setCopyLinkState('idle');
    }
  }, []);

  const handleExport = useCallback(
    (scope: ExportScope, format: ExportFormat) => {
      setExportDialogOpen(false);
      setStatusMessage(
        `Export prepared: ${format.toUpperCase()} (${scope.replace('_', ' ')}).`,
      );
    },
    [],
  );

  const handleNoteChange = useCallback((eventId: string, value: string) => {
    setNotesByEvent((prev) => ({ ...prev, [eventId]: value }));
  }, []);

  const filteredEvents = useMemo(
    () => filterAuditEvents(MOCK_AUDIT_EVENTS, filters),
    [filters],
  );

  const active = hasActiveFilters(filters);

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
            <ShieldCheck className="w-8 h-8 text-primary" aria-hidden="true" />
            Audit Trail
          </h1>
          <p className="text-gray-400 mt-2 max-w-2xl">
            Inspect administrative and on-chain events, share filtered views via URL,
            compare field diffs, and attach auditor notes.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={handleCopyUrl}
            aria-label="Copy shareable filter URL"
          >
            {copyLinkState === 'copied' ? (
              <>
                <Check size={14} aria-hidden="true" />
                Copied URL
              </>
            ) : (
              <>
                <Link2 size={14} aria-hidden="true" />
                Copy URL
              </>
            )}
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => setExportDialogOpen(true)}
          >
            <Download size={14} aria-hidden="true" />
            Export
          </button>
        </div>
      </div>

      {statusMessage && (
        <div
          role="status"
          aria-live="polite"
          className="glass-card p-3 text-sm flex items-center justify-between gap-4"
        >
          <span>{statusMessage}</span>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setStatusMessage(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="atf-layout">
        <PinnedSearchSidebar
          savedFilters={savedFilters}
          activeFilterId={activeFilterId}
          onApply={handleApplySavedFilter}
          onMove={handleMoveSavedFilter}
          onUnpin={handleUnpinSavedFilter}
          onDelete={handleDeleteSavedFilter}
        />

        <div className="atf-main space-y-4">
          <section
            className="atf-filterbar glass-card"
            aria-label="Audit trail filters"
          >
            <div className="input-group">
              <label className="input-label" htmlFor="audit-filter-query">
                Search
              </label>
              <input
                id="audit-filter-query"
                type="search"
                className="input-field"
                value={filters.query}
                onChange={(e) => handleFilterFieldChange('query', e.target.value)}
                placeholder="Search ID, actor, entity, summary..."
              />
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="audit-filter-action">
                Action
              </label>
              <select
                id="audit-filter-action"
                className="input-field"
                value={filters.action}
                onChange={(e) => handleFilterFieldChange('action', e.target.value)}
              >
                <option value="">All actions</option>
                {AUDIT_ACTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="audit-filter-actor">
                Actor
              </label>
              <input
                id="audit-filter-actor"
                type="text"
                className="input-field"
                value={filters.actor}
                onChange={(e) => handleFilterFieldChange('actor', e.target.value)}
                placeholder="e.g. maria.chen"
              />
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="audit-filter-from">
                From date
              </label>
              <input
                id="audit-filter-from"
                type="date"
                className="input-field"
                value={filters.dateFrom}
                onChange={(e) => handleFilterFieldChange('dateFrom', e.target.value)}
              />
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="audit-filter-to">
                To date
              </label>
              <input
                id="audit-filter-to"
                type="date"
                className="input-field"
                value={filters.dateTo}
                onChange={(e) => handleFilterFieldChange('dateTo', e.target.value)}
              />
            </div>

            <div className="atf-filterbar-actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => setSaveDialogOpen(true)}
              >
                <BookmarkPlus size={14} aria-hidden="true" />
                Save filter
              </button>
              {active && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={handleClearFilters}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  Clear filters
                </button>
              )}
            </div>
          </section>

          <LedgerTable<AuditEvent>
            data={filteredEvents}
            columns={columns}
            rowKey={(row) => row.id}
            ariaLabel="Audit trail events"
            detailMode="drawer"
            drawer={{
              deepLinkParam: DRAWER_PARAM,
              title: (row) => `${row.id} · ${row.action}`,
            }}
            rowDetail={(row) => {
              const noteValue = notesByEvent[row.id] ?? row.initialNote ?? '';
              return (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-xs text-muted">Timestamp</span>
                      <p className="font-medium">{row.timestamp}</p>
                    </div>
                    <div>
                      <span className="text-xs text-muted">Actor</span>
                      <p className="font-mono">{row.actor}</p>
                    </div>
                    <div>
                      <span className="text-xs text-muted">Entity</span>
                      <p className="font-medium">{row.entity}</p>
                    </div>
                    <div>
                      <span className="text-xs text-muted">Status</span>
                      <p className="font-medium">{row.status}</p>
                    </div>
                    <div className="col-span-2">
                      <span className="text-xs text-muted">Summary</span>
                      <p>{row.summary}</p>
                    </div>
                  </div>

                  <div>
                    <EventDiffViewer
                      diff={row.diff}
                      defaultOpen
                      entryLabel={`${row.actor} ${row.action}`}
                    />
                  </div>

                  <div>
                    <AuditNoteEditor
                      value={noteValue}
                      onChange={(val) => handleNoteChange(row.id, val)}
                      maxChars={500}
                    />
                  </div>
                </div>
              );
            }}
          />
        </div>
      </div>

      <SaveFilterDialog
        open={saveDialogOpen}
        filters={filters}
        existing={savedFilters}
        onSave={handleSaveFilter}
        onClose={() => setSaveDialogOpen(false)}
      />

      <ExportDialog
        open={exportDialogOpen}
        filters={filters}
        onExport={handleExport}
        onClose={() => setExportDialogOpen(false)}
      />
    </div>
  );
};

export default AuditTrailPage;
