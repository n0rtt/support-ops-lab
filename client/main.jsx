import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const channelNames = { email: 'Email', telegram: 'Telegram', manual: 'Manual / internal' };
const statusNames = { open: 'Open', in_progress: 'In progress', escalated: 'Escalated', resolved: 'Resolved' };
const statusTargets = {
  open: ['in_progress', 'escalated', 'resolved'],
  in_progress: ['escalated', 'resolved'],
  escalated: ['in_progress', 'resolved'],
  resolved: [],
};
const draftStorageKey = 'supportops.case-drafts.v1';
const selectionStorageKey = 'supportops.selected-case.v1';
const filterStorageKey = 'supportops.queue-filter.v1';
const pendingStorageKey = 'supportops.pending-actions.v1';

function readStorage(storage, key, fallback) {
  try {
    const value = storage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function saveStorage(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function displayValue(value) {
  return value.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function activityLabel(activity) {
  if (activity.type === 'initial_report') return 'Initial customer report';
  if (activity.type === 'note') return 'Internal note';
  if (activity.type === 'simulated_reply') return 'Simulated reply to customer — not sent';
  return 'System event';
}

function activitySummary(activity) {
  const payload = activity.payload;
  if (activity.type === 'initial_report' || activity.type === 'note' || activity.type === 'simulated_reply') {
    return payload.text;
  }
  const lines = [];
  if (payload.from && payload.to) lines.push(`Status changed from ${statusNames[payload.from]} to ${statusNames[payload.to]}.`);
  if (payload.reason) lines.push(`Escalation reason: ${payload.reason}`);
  if (payload.findings) lines.push(`Findings: ${payload.findings}`);
  if (payload.questions !== undefined) lines.push(`Outstanding questions: ${payload.questions || 'None recorded.'}`);
  if (payload.to === 'escalated') lines.push('Diagnostic evidence: None linked.');
  if (payload.outcome) lines.push(`Resolution outcome: ${payload.outcome}`);
  return lines.join('\n');
}

function App() {
  const [cases, setCases] = useState([]);
  const [selectedId, setSelectedId] = useState(() => readStorage(sessionStorage, selectionStorageKey, null));
  const [selectedCase, setSelectedCase] = useState(null);
  const [statusFilter, setStatusFilter] = useState(() => readStorage(sessionStorage, filterStorageKey, 'all'));
  const [drafts, setDrafts] = useState(() => readStorage(localStorage, draftStorageKey, {}));
  const [pendingRequests, setPendingRequests] = useState(() => {
    const saved = readStorage(sessionStorage, pendingStorageKey, {});
    return Object.fromEntries(Object.entries(saved).map(([slot, action]) => [
      slot,
      { ...action, state: action.state === 'conflict' ? 'conflict' : 'uncertain' },
    ]));
  });
  const [loadState, setLoadState] = useState('loading');
  const [detailError, setDetailError] = useState('');
  const [queueError, setQueueError] = useState('');
  const [busySlot, setBusySlot] = useState('');
  const [feedback, setFeedback] = useState({});

  useEffect(() => {
    saveStorage(localStorage, draftStorageKey, drafts);
  }, [drafts]);

  useEffect(() => {
    const controller = new AbortController();
    const query = statusFilter === 'all' ? '' : '?status=' + encodeURIComponent(statusFilter);
    setLoadState('loading');
    fetch('/api/cases' + query, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('case_list_unavailable');
        return response.json();
      })
      .then(({ cases: loadedCases }) => {
        setCases(loadedCases);
        setQueueError('');
        setLoadState('ready');
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setQueueError('The case queue could not be loaded. Your drafts remain saved in this browser.');
        setLoadState('error');
      });
    return () => controller.abort();
  }, [statusFilter]);

  useEffect(() => {
    if (loadState !== 'ready' || selectedId || cases.length === 0) return;
    setSelectedId(cases[0].id);
  }, [cases, loadState, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedCase(null);
      return undefined;
    }
    const controller = new AbortController();
    fetch('/api/cases/' + encodeURIComponent(selectedId), { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'case_detail_unavailable');
        return body.case;
      })
      .then((item) => {
        setSelectedCase(item);
        setDetailError('');
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setSelectedCase(null);
        setDetailError('This case could not be loaded. The selection was kept; choose another case only if you intend to.');
      });
    return () => controller.abort();
  }, [selectedId]);

  function chooseCase(caseId) {
    saveStorage(sessionStorage, selectionStorageKey, caseId);
    if (selectedId === caseId) {
      refreshCase(caseId).catch(() => setDetailError('This case could not be loaded. The selection was kept; choose another case only if you intend to.'));
      return;
    }
    setSelectedId(caseId);
    setSelectedCase(null);
  }

  function updateDraft(caseId, name, value) {
    setDrafts((current) => ({
      ...current,
      [caseId]: { ...current[caseId], [name]: value },
    }));
  }

  function storePending(slot, action) {
    const next = { ...pendingRequests, [slot]: action };
    saveStorage(sessionStorage, pendingStorageKey, next);
    setPendingRequests(next);
  }

  function clearPending(slot) {
    const next = { ...pendingRequests };
    delete next[slot];
    saveStorage(sessionStorage, pendingStorageKey, next);
    setPendingRequests(next);
  }

  async function refreshQueue() {
    const query = statusFilter === 'all' ? '' : '?status=' + encodeURIComponent(statusFilter);
    const response = await fetch('/api/cases' + query);
    if (!response.ok) throw new Error('case_list_unavailable');
    setCases((await response.json()).cases);
    setQueueError('');
  }

  async function refreshCase(caseId) {
    const response = await fetch('/api/cases/' + encodeURIComponent(caseId));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'case_detail_unavailable');
    if (selectedId === caseId) {
      setSelectedCase(body.case);
      setDetailError('');
    }
  }

  function describeFailure(status, code) {
    if (status === 409 && code === 'stale_case') return 'This case changed in another view. The action was not applied. Refresh the case and review your saved draft before trying again.';
    if (status === 409 && code === 'idempotency_key_reused') return 'This request key is already tied to different content. The action was not applied; refresh the case before continuing.';
    if (status === 409 && code === 'invalid_transition') return 'That status change is not allowed. The case and your draft were preserved.';
    if (status === 503) return 'The database is busy. Your exact request is saved here and can be retried safely.';
    if (status >= 500) return 'The save failed. Your exact request and draft are still saved here; retry the same request.';
    return 'The save was rejected (' + (code || 'invalid_request') + '). Your draft was preserved.';
  }

  async function sendPending(slot, action) {
    setBusySlot(slot);
    setFeedback((current) => ({ ...current, [slot]: '' }));
    let acknowledged = false;
    try {
      const response = await fetch(action.path, {
        method: action.method,
        headers: { 'content-type': 'application/json', 'idempotency-key': action.key },
        body: JSON.stringify(action.payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) {
          storePending(slot, { ...action, state: 'conflict', error: body.error });
        } else if (response.status >= 500 || response.status === 408) {
          storePending(slot, { ...action, state: 'uncertain' });
        } else {
          clearPending(slot);
        }
        setFeedback((current) => ({ ...current, [slot]: describeFailure(response.status, body.error) }));
        return;
      }

      acknowledged = true;
      clearPending(slot);
      if (action.type === 'note' && drafts[action.caseId]?.noteText === action.payload.text) {
        updateDraft(action.caseId, 'noteText', '');
      }
      if (action.type === 'simulated_reply' && drafts[action.caseId]?.replyText === action.payload.text) {
        updateDraft(action.caseId, 'replyText', '');
      }
      if (action.type === 'status') {
        const currentDraft = drafts[action.caseId] || {};
        const sameStatusDraft = currentDraft.transitionTarget === action.payload.status && (
          action.payload.status === 'escalated'
            ? (currentDraft.escalationReason || '') === action.payload.reason &&
              (currentDraft.escalationFindings || '') === action.payload.findings &&
              (currentDraft.outstandingQuestions || '') === action.payload.questions
            : action.payload.status === 'resolved'
              ? (currentDraft.resolutionOutcome || '') === action.payload.outcome
              : true
        );
        if (sameStatusDraft) {
          setDrafts((current) => ({
            ...current,
            [action.caseId]: {
              ...current[action.caseId],
              transitionTarget: '',
              escalationReason: '',
              escalationFindings: '',
              outstandingQuestions: '',
              resolutionOutcome: '',
            },
          }));
        }
      }
      const refreshResults = await Promise.allSettled([refreshQueue(), refreshCase(action.caseId)]);
      const queueRefreshFailed = refreshResults[0].status === 'rejected';
      const detailRefreshFailed = refreshResults[1].status === 'rejected';
      if (queueRefreshFailed) setQueueError('The save succeeded, but the case queue could not be refreshed.');
      if (detailRefreshFailed && selectedId === action.caseId) {
        setDetailError('The save succeeded, but case history could not be refreshed. Reload to see the latest history.');
      }
      setFeedback((current) => ({
        ...current,
        [slot]: queueRefreshFailed || detailRefreshFailed
          ? 'Saved. The updated view could not be fully refreshed; reload to see the latest case state.'
          : body.replayed ? 'Save confirmed from the existing receipt.' : 'Saved.',
      }));
    } catch {
      if (acknowledged) {
        setFeedback((current) => ({ ...current, [slot]: 'Saved. The updated case view could not be refreshed; reload the case to see the latest history.' }));
      } else {
        storePending(slot, { ...action, state: 'uncertain' });
        setFeedback((current) => ({
          ...current,
          [slot]: 'The connection ended before the save was confirmed. Your exact request and draft are saved here; retry the same request.',
        }));
      }
    } finally {
      setBusySlot('');
    }
  }

  function submitActivity(event, type) {
    event.preventDefault();
    if (!selectedCase) return;
    const caseId = selectedCase.id;
    const slot = caseId + ':activity:' + type;
    const field = type === 'note' ? 'noteText' : 'replyText';
    const text = drafts[caseId]?.[field] || '';
    const action = {
      caseId,
      type,
      method: 'POST',
      path: '/api/cases/' + encodeURIComponent(caseId) + '/activities',
      key: crypto.randomUUID(),
      payload: { type, text, expectedVersion: selectedCase.version },
      state: 'uncertain',
    };
    storePending(slot, action);
    sendPending(slot, action);
  }

  function submitStatus(event) {
    event.preventDefault();
    if (!selectedCase) return;
    const caseId = selectedCase.id;
    const draft = drafts[caseId] || {};
    const status = draft.transitionTarget;
    const payload = { status, expectedVersion: selectedCase.version };
    if (status === 'escalated') {
      Object.assign(payload, {
        reason: draft.escalationReason || '',
        findings: draft.escalationFindings || '',
        questions: draft.outstandingQuestions || '',
        evidenceIds: [],
      });
    }
    if (status === 'resolved') payload.outcome = draft.resolutionOutcome || '';
    const slot = caseId + ':status';
    const action = {
      caseId,
      type: 'status',
      method: 'PATCH',
      path: '/api/cases/' + encodeURIComponent(caseId) + '/status',
      key: crypto.randomUUID(),
      payload,
      state: 'uncertain',
    };
    storePending(slot, action);
    sendPending(slot, action);
  }

  async function reconcileConflict(slot, action) {
    try {
      await refreshCase(action.caseId);
      clearPending(slot);
      await refreshQueue().catch(() => setQueueError('The case history refreshed, but the queue could not be updated.'));
      setFeedback((current) => ({ ...current, [slot]: 'Latest case history loaded. Your draft remains available for review.' }));
    } catch {
      setFeedback((current) => ({ ...current, [slot]: 'The latest case could not be loaded. The rejected request and draft remain saved.' }));
    }
  }

  const selectedDraft = selectedCase ? drafts[selectedCase.id] || {} : {};
  const selectedIsOutsideFilter = Boolean(
    selectedCase && statusFilter !== 'all' && selectedCase.status !== statusFilter,
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Support Engineering Workbench home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Support Engineering Workbench</span>
        </a>
        <span className="mode-label">M2 manual workflow · no AI credentials needed</span>
      </header>

      <main className="workspace">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Synthetic support desk</p>
            <h1>Support queue</h1>
          </div>
          <label className="filter-control">
            <span>Filter by status</span>
            <select
              aria-label="Filter cases by status"
              value={statusFilter}
              onChange={(event) => {
                const value = event.target.value;
                saveStorage(sessionStorage, filterStorageKey, value);
                setStatusFilter(value);
              }}
            >
              <option value="all">All statuses</option>
              {Object.entries(statusNames).map(([value, name]) => <option value={value} key={value}>{name}</option>)}
            </select>
          </label>
        </div>

        {queueError && <p className="notice notice-error" role="alert">{queueError}</p>}
        {loadState === 'loading' && <p className="notice">Loading synthetic cases…</p>}

        {loadState !== 'loading' && (
          <div className="case-layout">
            <nav className="case-list" aria-label="Support cases">
              <p className="queue-summary">{cases.length} {cases.length === 1 ? 'case' : 'cases'}</p>
              {cases.map((item) => (
                <button
                  className={'case-card' + (selectedId === item.id ? ' selected' : '')}
                  key={item.id}
                  type="button"
                  aria-pressed={selectedId === item.id}
                  onClick={() => chooseCase(item.id)}
                >
                  <span className="case-card-top">
                    <span className="case-id">{item.id}</span>
                    <span className={'status status-' + item.status}>{statusNames[item.status]}</span>
                  </span>
                  <strong>{item.subject}</strong>
                  <span className="case-org">{item.organizationName}</span>
                  <span className="case-card-bottom">
                    <span>{channelNames[item.channel]}</span>
                    <span>{formatDate(item.updatedAt)}</span>
                  </span>
                </button>
              ))}
              {cases.length === 0 && <p className="empty-queue">No cases match this status filter.</p>}
            </nav>

            {detailError && <p className="notice notice-error" role="alert">{detailError}</p>}
            {!selectedCase && !detailError && selectedId && <p className="notice">Loading case history…</p>}

            {selectedCase && (
              <article className="case-detail" aria-labelledby="case-title">
                {selectedIsOutsideFilter && (
                  <p className="notice filter-notice" role="status">
                    This case is outside the current {statusNames[statusFilter]} filter. It remains visible here; your selection and drafts are preserved.
                  </p>
                )}
                <div className="detail-topline">
                  <p className="eyebrow">Case {selectedCase.id}</p>
                  <span className={'status status-' + selectedCase.status}>{statusNames[selectedCase.status]}</span>
                </div>
                <h2 id="case-title">{selectedCase.subject}</h2>
                <p className="organization">{selectedCase.organizationName}</p>

                <dl className="case-metadata">
                  <div><dt>Channel</dt><dd>{channelNames[selectedCase.channel]}</dd></div>
                  <div><dt>Priority</dt><dd>{displayValue(selectedCase.priority)}</dd></div>
                  <div><dt>Created</dt><dd>{formatDate(selectedCase.createdAt)}</dd></div>
                  <div><dt>Last activity</dt><dd>{formatDate(selectedCase.updatedAt)}</dd></div>
                </dl>

                <section className="history-section" aria-labelledby="history-title">
                  <div className="section-heading">
                    <h3 id="history-title">Case history</h3>
                    <span>{selectedCase.activities.length} entries · oldest first</span>
                  </div>
                  <ol className="activity-list">
                    {selectedCase.activities.map((activity) => (
                      <li className={'activity activity-' + activity.type} key={activity.id}>
                        <div className="activity-heading">
                          <strong>{activityLabel(activity)}</strong>
                          <time dateTime={activity.createdAt}>{formatDate(activity.createdAt)}</time>
                        </div>
                        <p>{activitySummary(activity)}</p>
                      </li>
                    ))}
                  </ol>
                </section>

                <section className="operator-actions" aria-labelledby="actions-title">
                  <h3 id="actions-title">Record an update</h3>
                  <div className="action-grid">
                    <form className="action-card" onSubmit={(event) => submitActivity(event, 'note')}>
                      <h4>Internal note</h4>
                      <label htmlFor="note-text">Visible to support operators only</label>
                      <textarea
                        id="note-text"
                        maxLength={10000}
                        value={selectedDraft.noteText || ''}
                        onChange={(event) => updateDraft(selectedCase.id, 'noteText', event.target.value)}
                      />
                      <button type="submit" disabled={!selectedDraft.noteText?.trim() || Boolean(busySlot) || Boolean(pendingRequests[selectedCase.id + ':activity:note'])}>
                        Add internal note
                      </button>
                      {pendingRequests[selectedCase.id + ':activity:note'] && (
                        <PendingAction slot={selectedCase.id + ':activity:note'} action={pendingRequests[selectedCase.id + ':activity:note']} busySlot={busySlot} feedback={feedback} retry={sendPending} reconcile={reconcileConflict} />
                      )}
                      {feedback[selectedCase.id + ':activity:note'] && <p className="save-feedback" role="status">{feedback[selectedCase.id + ':activity:note']}</p>}
                    </form>

                    <form className="action-card reply-card" onSubmit={(event) => submitActivity(event, 'simulated_reply')}>
                      <h4>Simulated reply to customer — not sent</h4>
                      <label htmlFor="reply-text">Record a fictional outgoing reply. No message leaves this app.</label>
                      <textarea
                        id="reply-text"
                        maxLength={10000}
                        value={selectedDraft.replyText || ''}
                        onChange={(event) => updateDraft(selectedCase.id, 'replyText', event.target.value)}
                      />
                      <button type="submit" disabled={!selectedDraft.replyText?.trim() || Boolean(busySlot) || Boolean(pendingRequests[selectedCase.id + ':activity:simulated_reply'])}>
                        Record simulated reply
                      </button>
                      {pendingRequests[selectedCase.id + ':activity:simulated_reply'] && (
                        <PendingAction slot={selectedCase.id + ':activity:simulated_reply'} action={pendingRequests[selectedCase.id + ':activity:simulated_reply']} busySlot={busySlot} feedback={feedback} retry={sendPending} reconcile={reconcileConflict} />
                      )}
                      {feedback[selectedCase.id + ':activity:simulated_reply'] && <p className="save-feedback" role="status">{feedback[selectedCase.id + ':activity:simulated_reply']}</p>}
                    </form>
                  </div>
                </section>

                <section className="status-section" aria-labelledby="status-title">
                  <h3 id="status-title">Case status</h3>
                  {selectedCase.status === 'resolved' ? (
                    <p className="terminal-note">Resolved is terminal. Internal notes and simulated replies can still be recorded without changing the resolution.</p>
                  ) : (
                    <form className="status-form" onSubmit={submitStatus}>
                      <label htmlFor="transition-target">Move case to</label>
                      <select
                        id="transition-target"
                        required
                        value={selectedDraft.transitionTarget || ''}
                        onChange={(event) => updateDraft(selectedCase.id, 'transitionTarget', event.target.value)}
                      >
                        <option value="">Choose a status</option>
                        {statusTargets[selectedCase.status].map((status) => <option value={status} key={status}>{statusNames[status]}</option>)}
                      </select>
                      {selectedDraft.transitionTarget === 'escalated' && (
                        <div className="status-fields">
                          <label htmlFor="escalation-reason">Escalation reason</label>
                          <textarea id="escalation-reason" required maxLength={10000} value={selectedDraft.escalationReason || ''} onChange={(event) => updateDraft(selectedCase.id, 'escalationReason', event.target.value)} />
                          <label htmlFor="escalation-findings">Current findings</label>
                          <textarea id="escalation-findings" required maxLength={10000} value={selectedDraft.escalationFindings || ''} onChange={(event) => updateDraft(selectedCase.id, 'escalationFindings', event.target.value)} />
                          <label htmlFor="outstanding-questions">Outstanding questions</label>
                          <textarea id="outstanding-questions" maxLength={10000} value={selectedDraft.outstandingQuestions || ''} onChange={(event) => updateDraft(selectedCase.id, 'outstandingQuestions', event.target.value)} />
                          <p className="field-hint">No diagnostic evidence is linked in M2; this escalation records an empty evidence list.</p>
                        </div>
                      )}
                      {selectedDraft.transitionTarget === 'resolved' && (
                        <div className="status-fields">
                          <label htmlFor="resolution-outcome">Resolution outcome</label>
                          <textarea id="resolution-outcome" required maxLength={10000} value={selectedDraft.resolutionOutcome || ''} onChange={(event) => updateDraft(selectedCase.id, 'resolutionOutcome', event.target.value)} />
                        </div>
                      )}
                      <button type="submit" disabled={!selectedDraft.transitionTarget || Boolean(busySlot) || Boolean(pendingRequests[selectedCase.id + ':status'])}>
                        Save status and history
                      </button>
                      {pendingRequests[selectedCase.id + ':status'] && (
                        <PendingAction slot={selectedCase.id + ':status'} action={pendingRequests[selectedCase.id + ':status']} busySlot={busySlot} feedback={feedback} retry={sendPending} reconcile={reconcileConflict} />
                      )}
                      {feedback[selectedCase.id + ':status'] && <p className="save-feedback" role="status">{feedback[selectedCase.id + ':status']}</p>}
                    </form>
                  )}
                </section>
              </article>
            )}
          </div>
        )}
      </main>

      <footer className="footer">
        <span>Cases and organizations are fictional. Incoming reports and replies are simulated.</span>
        <span>No messages or external systems are connected.</span>
      </footer>
    </div>
  );
}

function PendingAction({ slot, action, busySlot, feedback, retry, reconcile }) {
  return (
    <div className="pending-action">
      <p>{action.state === 'conflict' ? 'This request was rejected and will not be retried automatically.' : 'A previous save is awaiting confirmation. The exact request is retained.'}</p>
      {action.type !== 'status' && <blockquote>{action.payload.text}</blockquote>}
      {feedback[slot] && <p role="alert">{feedback[slot]}</p>}
      {action.state === 'conflict' ? (
        <button type="button" onClick={() => reconcile(slot, action)} disabled={Boolean(busySlot)}>Reload case and review draft</button>
      ) : (
        <button type="button" onClick={() => retry(slot, action)} disabled={Boolean(busySlot)}>Retry exact save</button>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
