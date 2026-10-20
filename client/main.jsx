import { useEffect, useRef, useState } from 'react';
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
const filterStorageKey = 'supportops.queue-filter.v1';
const pendingStorageKey = 'supportops.pending-actions.v1';

function selectedCaseFromHash() {
  try {
    const caseId = decodeURIComponent(window.location.hash.slice(1));
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(caseId) ? caseId : null;
  } catch {
    return null;
  }
}

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
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
}

function activityLabel(activity) {
  if (activity.type === 'initial_report') return 'Initial customer report';
  if (activity.type === 'note' || activity.type === 'internal_note') return 'Internal note';
  if (activity.type === 'simulated_reply') return 'Simulated reply to customer — not sent';
  return 'System event';
}

function activitySummary(activity) {
  const payload = activity.payload;
  if (activity.type === 'initial_report' || activity.type === 'note' || activity.type === 'internal_note' || activity.type === 'simulated_reply') {
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
  const selectedIdRef = useRef(selectedCaseFromHash());
  const [selectedId, setSelectedId] = useState(selectedIdRef.current);
  const [selectedCase, setSelectedCase] = useState(null);
  const [statusFilter, setStatusFilter] = useState(() => readStorage(sessionStorage, filterStorageKey, 'all'));
  const statusFilterRef = useRef(statusFilter);
  const queueRequestRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const [drafts, setDrafts] = useState(() => readStorage(sessionStorage, draftStorageKey, {}));
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

  function applyCaseDetail(item, generation) {
    if (selectedIdRef.current !== item.id || selectionGenerationRef.current !== generation) return;
    setSelectedCase((current) => current?.id === item.id && current.version > item.version ? current : item);
    setDetailError('');
  }

  useEffect(() => {
    saveStorage(sessionStorage, draftStorageKey, drafts);
  }, [drafts]);

  useEffect(() => {
    const controller = new AbortController();
    const query = statusFilter === 'all' ? '' : '?status=' + encodeURIComponent(statusFilter);
    const request = ++queueRequestRef.current;
    setLoadState('loading');
    fetch('/api/cases' + query, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('case_list_unavailable');
        return response.json();
      })
      .then(({ cases: loadedCases }) => {
        if (request !== queueRequestRef.current || statusFilterRef.current !== statusFilter) return;
        setCases(loadedCases);
        setQueueError('');
        setLoadState('ready');
      })
      .catch((error) => {
        if (error.name === 'AbortError' || request !== queueRequestRef.current || statusFilterRef.current !== statusFilter) return;
        setQueueError('The case queue could not be loaded. Your drafts remain saved in this browser.');
        setLoadState('error');
      });
    return () => controller.abort();
  }, [statusFilter]);

  useEffect(() => {
    const syncSelection = () => {
      const nextId = selectedCaseFromHash();
      if (selectedIdRef.current === nextId) return;
      selectionGenerationRef.current += 1;
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      setSelectedCase(null);
      setDetailError('');
    };
    window.addEventListener('hashchange', syncSelection);
    window.addEventListener('popstate', syncSelection);
    return () => {
      window.removeEventListener('hashchange', syncSelection);
      window.removeEventListener('popstate', syncSelection);
    };
  }, []);

  useEffect(() => {
    if (loadState !== 'ready' || selectedId || cases.length === 0) return;
    const firstCaseId = cases[0].id;
    selectionGenerationRef.current += 1;
    selectedIdRef.current = firstCaseId;
    window.history.replaceState(null, '', '#' + encodeURIComponent(firstCaseId));
    setSelectedId(firstCaseId);
  }, [cases, loadState, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedCase(null);
      return undefined;
    }
    const generation = selectionGenerationRef.current;
    const controller = new AbortController();
    fetch('/api/cases/' + encodeURIComponent(selectedId), { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'case_detail_unavailable');
        return body.case;
      })
      .then((item) => {
        applyCaseDetail(item, generation);
      })
      .catch((error) => {
        if (
          error.name === 'AbortError' ||
          selectedIdRef.current !== selectedId ||
          selectionGenerationRef.current !== generation
        ) return;
        setSelectedCase(null);
        setDetailError('This case could not be loaded. The selection was kept; choose another case only if you intend to.');
      });
    return () => controller.abort();
  }, [selectedId]);

  function chooseCase(caseId) {
    if (selectedIdRef.current === caseId) {
      refreshCase(caseId).catch(() => {
        if (selectedIdRef.current === caseId) {
          setDetailError('This case could not be loaded. The selection was kept; choose another case only if you intend to.');
        }
      });
      return;
    }
    window.history.pushState(null, '', '#' + encodeURIComponent(caseId));
    selectionGenerationRef.current += 1;
    selectedIdRef.current = caseId;
    setSelectedId(caseId);
    setSelectedCase(null);
    setDetailError('');
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
    const filter = statusFilterRef.current;
    const request = ++queueRequestRef.current;
    try {
      const query = filter === 'all' ? '' : '?status=' + encodeURIComponent(filter);
      const response = await fetch('/api/cases' + query);
      if (!response.ok) throw new Error('case_list_unavailable');
      const { cases: loadedCases } = await response.json();
      if (request !== queueRequestRef.current || statusFilterRef.current !== filter) return;
      setCases(loadedCases);
      setQueueError('');
      setLoadState('ready');
    } catch (error) {
      if (request === queueRequestRef.current && statusFilterRef.current === filter) {
        setLoadState('error');
        throw error;
      }
    }
  }

  async function refreshCase(caseId) {
    const generation = selectionGenerationRef.current;
    const response = await fetch('/api/cases/' + encodeURIComponent(caseId));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'case_detail_unavailable');
    applyCaseDetail(body.case, generation);
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
      if (action.type === 'internal_note') {
        setDrafts((current) => {
          const draft = current[action.caseId] || {};
          return draft.noteText === action.payload.text
            ? { ...current, [action.caseId]: { ...draft, noteText: '' } }
            : current;
        });
      }
      if (action.type === 'simulated_reply') {
        setDrafts((current) => {
          const draft = current[action.caseId] || {};
          return draft.replyText === action.payload.text
            ? { ...current, [action.caseId]: { ...draft, replyText: '' } }
            : current;
        });
      }
      if (action.type === 'status') {
        setDrafts((current) => {
          const draft = current[action.caseId] || {};
          const sameStatusDraft = draft.transitionTarget === action.payload.status && (
            action.payload.status === 'escalated'
              ? (draft.escalationReason || '') === action.payload.reason &&
                (draft.escalationFindings || '') === action.payload.findings &&
                (draft.outstandingQuestions || '') === action.payload.questions
              : action.payload.status === 'resolved'
                ? (draft.resolutionOutcome || '') === action.payload.outcome
                : true
          );
          return sameStatusDraft
            ? {
                ...current,
                [action.caseId]: {
                  ...draft,
                  transitionTarget: '',
                  escalationReason: '',
                  escalationFindings: '',
                  outstandingQuestions: '',
                  resolutionOutcome: '',
                },
              }
            : current;
        });
      }
      const refreshResults = await Promise.allSettled([refreshQueue(), refreshCase(action.caseId)]);
      const queueRefreshFailed = refreshResults[0].status === 'rejected';
      const detailRefreshFailed = refreshResults[1].status === 'rejected';
      if (queueRefreshFailed) setQueueError('The save succeeded, but the case queue could not be refreshed.');
      if (detailRefreshFailed && selectedIdRef.current === action.caseId) {
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
    if (!selectedCase || selectedIdRef.current !== selectedCase.id) return;
    const caseId = selectedCase.id;
    const slot = caseId + ':activity:' + type;
    const field = type === 'note' ? 'noteText' : 'replyText';
    const text = drafts[caseId]?.[field] || '';
    const requestType = type === 'note' ? 'internal_note' : type;
    const action = {
      caseId,
      type: requestType,
      method: 'POST',
      path: '/api/cases/' + encodeURIComponent(caseId) + '/activities',
      key: crypto.randomUUID(),
      payload: { type: requestType, text, expectedVersion: selectedCase.version },
      state: 'uncertain',
    };
    storePending(slot, action);
    sendPending(slot, action);
  }

  function submitStatus(event) {
    event.preventDefault();
    if (!selectedCase || selectedIdRef.current !== selectedCase.id) return;
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

  const activeCase = selectedCase?.id === selectedId ? selectedCase : null;
  const selectedDraft = activeCase ? drafts[activeCase.id] || {} : {};
  const statusSlot = activeCase ? activeCase.id + ':status' : '';
  const pendingStatus = statusSlot ? pendingRequests[statusSlot] : null;
  const requestedOutcome = pendingStatus?.payload?.status === 'resolved' ? pendingStatus.payload.outcome : undefined;
  const savedOutcome = activeCase?.activities
    .filter((activity) => activity.type === 'status_changed' && activity.payload.to === 'resolved')
    .at(-1)?.payload.outcome;
  const retainedEscalationDraft = activeCase?.status === 'resolved' && selectedDraft.transitionTarget === 'escalated';
  const retainedOutcomeDraft = selectedDraft.resolutionOutcome &&
    selectedDraft.resolutionOutcome !== requestedOutcome &&
    selectedDraft.resolutionOutcome !== savedOutcome;
  const selectedIsOutsideFilter = Boolean(
    activeCase && statusFilter !== 'all' && activeCase.status !== statusFilter,
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
                statusFilterRef.current = value;
                queueRequestRef.current += 1;
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
                  <span className="case-card-priority">{displayValue(item.priority)} priority</span>
                  <span className="case-card-bottom">
                    <span>{channelNames[item.channel]}</span>
                    <span>{formatDate(item.updatedAt)}</span>
                  </span>
                </button>
              ))}
              {cases.length === 0 && <p className="empty-queue">No cases match this status filter.</p>}
            </nav>

            {detailError && <p className="notice notice-error" role="alert">{detailError}</p>}
            {!activeCase && !detailError && selectedId && <p className="notice">Loading case history…</p>}

            {activeCase && (
              <article className="case-detail" aria-labelledby="case-title">
                {selectedIsOutsideFilter && (
                  <p className="notice filter-notice" role="status">
                    This case is outside the current {statusNames[statusFilter]} filter. It remains visible here; your selection and drafts are preserved.
                  </p>
                )}
                <div className="detail-topline">
                  <p className="eyebrow">Case {activeCase.id}</p>
                  <span className={'status status-' + activeCase.status}>{statusNames[activeCase.status]}</span>
                </div>
                <h2 id="case-title">{activeCase.subject}</h2>
                <p className="organization">{activeCase.organizationName}</p>

                <dl className="case-metadata">
                  <div><dt>Channel</dt><dd>{channelNames[activeCase.channel]}</dd></div>
                  <div><dt>Priority</dt><dd>{displayValue(activeCase.priority)}</dd></div>
                  <div><dt>Created</dt><dd>{formatDate(activeCase.createdAt)}</dd></div>
                  <div><dt>Last activity</dt><dd>{formatDate(activeCase.updatedAt)}</dd></div>
                </dl>

                <section className="history-section" aria-labelledby="history-title">
                  <div className="section-heading">
                    <h3 id="history-title">Case history</h3>
                    <span>{activeCase.activities.length} entries · oldest first</span>
                  </div>
                  <ol className="activity-list">
                    {activeCase.activities.map((activity) => (
                      <li className={'activity activity-' + (activity.type === 'internal_note' ? 'note' : activity.type)} key={activity.id}>
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
                        onChange={(event) => updateDraft(activeCase.id, 'noteText', event.target.value)}
                      />
                      <button type="submit" disabled={!selectedDraft.noteText?.trim() || Boolean(busySlot) || Boolean(pendingRequests[activeCase.id + ':activity:note'])}>
                        Add internal note
                      </button>
                      {pendingRequests[activeCase.id + ':activity:note'] && (
                        <PendingAction slot={activeCase.id + ':activity:note'} action={pendingRequests[activeCase.id + ':activity:note']} busySlot={busySlot} feedback={feedback} retry={sendPending} reconcile={reconcileConflict} />
                      )}
                      {feedback[activeCase.id + ':activity:note'] && <p className="save-feedback" role="status">{feedback[activeCase.id + ':activity:note']}</p>}
                    </form>

                    <form className="action-card reply-card" onSubmit={(event) => submitActivity(event, 'simulated_reply')}>
                      <h4>Simulated reply to customer — not sent</h4>
                      <label htmlFor="reply-text">Record a fictional outgoing reply. No message leaves this app.</label>
                      <textarea
                        id="reply-text"
                        maxLength={10000}
                        value={selectedDraft.replyText || ''}
                        onChange={(event) => updateDraft(activeCase.id, 'replyText', event.target.value)}
                      />
                      <button type="submit" disabled={!selectedDraft.replyText?.trim() || Boolean(busySlot) || Boolean(pendingRequests[activeCase.id + ':activity:simulated_reply'])}>
                        Record simulated reply
                      </button>
                      {pendingRequests[activeCase.id + ':activity:simulated_reply'] && (
                        <PendingAction slot={activeCase.id + ':activity:simulated_reply'} action={pendingRequests[activeCase.id + ':activity:simulated_reply']} busySlot={busySlot} feedback={feedback} retry={sendPending} reconcile={reconcileConflict} />
                      )}
                      {feedback[activeCase.id + ':activity:simulated_reply'] && <p className="save-feedback" role="status">{feedback[activeCase.id + ':activity:simulated_reply']}</p>}
                    </form>
                  </div>
                </section>

                <section className="status-section" aria-labelledby="status-title">
                  <h3 id="status-title">Case status</h3>
                  {activeCase.status === 'resolved' ? (
                    <>
                      <p className="terminal-note">Resolved is terminal. Internal notes and simulated replies can still be recorded without changing the resolution.</p>
                      {retainedEscalationDraft && (
                        <div className="status-form">
                          <div className="status-fields">
                            <p className="field-hint">This escalation draft was not applied. The resolved case cannot accept another status change; review or copy the draft below.</p>
                            <label htmlFor="retained-escalation-reason">Unsaved escalation reason</label>
                            <textarea id="retained-escalation-reason" maxLength={10000} value={selectedDraft.escalationReason || ''} onChange={(event) => updateDraft(activeCase.id, 'escalationReason', event.target.value)} />
                            <label htmlFor="retained-escalation-findings">Unsaved escalation findings</label>
                            <textarea id="retained-escalation-findings" maxLength={10000} value={selectedDraft.escalationFindings || ''} onChange={(event) => updateDraft(activeCase.id, 'escalationFindings', event.target.value)} />
                            <label htmlFor="retained-outstanding-questions">Unsaved outstanding questions</label>
                            <textarea id="retained-outstanding-questions" maxLength={10000} value={selectedDraft.outstandingQuestions || ''} onChange={(event) => updateDraft(activeCase.id, 'outstandingQuestions', event.target.value)} />
                          </div>
                        </div>
                      )}
                      {retainedOutcomeDraft && (
                        <div className="status-form">
                          <div className="status-fields">
                            <label htmlFor="retained-resolution-outcome">Unsaved resolution outcome draft</label>
                            <textarea
                              id="retained-resolution-outcome"
                              aria-describedby="retained-resolution-outcome-help"
                              maxLength={10000}
                              value={selectedDraft.resolutionOutcome}
                              onChange={(event) => updateDraft(activeCase.id, 'resolutionOutcome', event.target.value)}
                            />
                            <p className="field-hint" id="retained-resolution-outcome-help">This draft was not saved as the resolution outcome. Resolved is terminal; review or copy it before clearing it.</p>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <form className="status-form" onSubmit={submitStatus}>
                      <label htmlFor="transition-target">Move case to</label>
                      <select
                        id="transition-target"
                        required
                        value={selectedDraft.transitionTarget || ''}
                        onChange={(event) => updateDraft(activeCase.id, 'transitionTarget', event.target.value)}
                      >
                        <option value="">Choose a status</option>
                        {statusTargets[activeCase.status].map((status) => <option value={status} key={status}>{statusNames[status]}</option>)}
                      </select>
                      {selectedDraft.transitionTarget === 'escalated' && (
                        <div className="status-fields">
                          <label htmlFor="escalation-reason">Escalation reason</label>
                          <textarea id="escalation-reason" required maxLength={10000} value={selectedDraft.escalationReason || ''} onChange={(event) => updateDraft(activeCase.id, 'escalationReason', event.target.value)} />
                          <label htmlFor="escalation-findings">Current findings</label>
                          <textarea id="escalation-findings" required maxLength={10000} value={selectedDraft.escalationFindings || ''} onChange={(event) => updateDraft(activeCase.id, 'escalationFindings', event.target.value)} />
                          <label htmlFor="outstanding-questions">Outstanding questions</label>
                          <textarea id="outstanding-questions" maxLength={10000} value={selectedDraft.outstandingQuestions || ''} onChange={(event) => updateDraft(activeCase.id, 'outstandingQuestions', event.target.value)} />
                          <p className="field-hint">No diagnostic evidence is linked in M2; this escalation records an empty evidence list.</p>
                        </div>
                      )}
                      {selectedDraft.transitionTarget === 'resolved' && (
                        <div className="status-fields">
                          <label htmlFor="resolution-outcome">Resolution outcome</label>
                          <textarea id="resolution-outcome" required maxLength={10000} value={selectedDraft.resolutionOutcome || ''} onChange={(event) => updateDraft(activeCase.id, 'resolutionOutcome', event.target.value)} />
                        </div>
                      )}
                      <button type="submit" disabled={!selectedDraft.transitionTarget || Boolean(busySlot) || Boolean(pendingRequests[activeCase.id + ':status'])}>
                        Save status and history
                      </button>
                    </form>
                  )}
                  {pendingStatus && (
                    <PendingAction slot={statusSlot} action={pendingStatus} busySlot={busySlot} feedback={feedback} retry={sendPending} reconcile={reconcileConflict} />
                  )}
                  {!pendingStatus && feedback[statusSlot] && <p className="save-feedback" role="status">{feedback[statusSlot]}</p>}
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
      {action.type === 'status' && action.payload.status === 'resolved' && (
        <blockquote>Submitted resolution outcome: {action.payload.outcome}</blockquote>
      )}
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
