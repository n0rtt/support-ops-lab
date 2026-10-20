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
  if (!value) return 'Unknown; no observed timestamp';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC';
}

function observedOutcome(diagnostic) {
  if (diagnostic.outcome === 'acknowledged') return 'Acknowledged by endpoint; downstream processing not observed.';
  if (diagnostic.outcome === 'timed_out') return 'No HTTP response observed.';
  if (diagnostic.outcome === 'pending') return 'Pending retry; no observed delivery time or response.';
  return 'Observed failure.';
}

function sameIds(left = [], right = []) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
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
  if (payload.to === 'escalated') {
    lines.push(payload.evidenceIds?.length
      ? `Diagnostic evidence in this escalation: ${payload.evidenceIds.join(', ')}.`
      : 'Diagnostic evidence: None linked.');
  }
  if (activity.type === 'evidence_seeded' || activity.type === 'evidence_linked') {
    lines.push(`${payload.source === 'synthetic_seed' ? 'Synthetic seed linked' : 'Evidence linked'}: ${(payload.diagnosticIds || []).join(', ')}.`);
  }
  if (payload.outcome) lines.push(`Resolution outcome: ${payload.outcome}`);
  return lines.join('\n');
}

function DiagnosticFacts({ diagnostic }) {
  return (
    <dl className="diagnostic-facts">
      <div><dt>Diagnostic row ID</dt><dd>{diagnostic.id}</dd></div>
      <div><dt>Organization</dt><dd>{diagnostic.organizationId}</dd></div>
      <div><dt>Record type</dt><dd>{displayValue(diagnostic.kind)}</dd></div>
      <div><dt>Request / event type</dt><dd>{diagnostic.eventType}</dd></div>
      <div><dt>Request ID</dt><dd>{diagnostic.requestId || 'Not applicable'}</dd></div>
      <div><dt>Event ID</dt><dd>{diagnostic.eventId || 'Not applicable'}</dd></div>
      <div><dt>Attempt</dt><dd>{diagnostic.attemptNumber ?? 'Not applicable'}</dd></div>
      <div><dt>Observed time</dt><dd>{formatDate(diagnostic.observedAt)}</dd></div>
      <div><dt>HTTP response</dt><dd>{diagnostic.httpStatus === null
        ? ['timed_out', 'pending'].includes(diagnostic.outcome) ? 'No HTTP response observed' : 'Unknown; no HTTP status recorded'
        : `HTTP ${diagnostic.httpStatus}`}</dd></div>
      <div><dt>Observed outcome</dt><dd>{observedOutcome(diagnostic)}</dd></div>
      {diagnostic.errorCode && <div><dt>Sanitized error code</dt><dd>{diagnostic.errorCode}</dd></div>}
      {diagnostic.errorDetails && <div className="diagnostic-fact-wide"><dt>Technical detail</dt><dd>{diagnostic.errorDetails}</dd></div>}
    </dl>
  );
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
  const pendingRequestsRef = useRef(pendingRequests);
  const [loadState, setLoadState] = useState('loading');
  const [detailError, setDetailError] = useState('');
  const [queueError, setQueueError] = useState('');
  const [busySlot, setBusySlot] = useState('');
  const [feedback, setFeedback] = useState({});
  const [diagnosticQuery, setDiagnosticQuery] = useState('');
  const [diagnosticMatches, setDiagnosticMatches] = useState([]);
  const [diagnosticHistories, setDiagnosticHistories] = useState([]);
  const [diagnosticSearchState, setDiagnosticSearchState] = useState('idle');
  const [diagnosticSearchError, setDiagnosticSearchError] = useState('');
  const [diagnosticDetail, setDiagnosticDetail] = useState(null);
  const [knowledgeEntries, setKnowledgeEntries] = useState([]);
  const [knowledgeEntry, setKnowledgeEntry] = useState(null);
  const [knowledgeError, setKnowledgeError] = useState('');
  const diagnosticSearchRequestRef = useRef(0);
  const diagnosticDetailRequestRef = useRef(0);
  const knowledgeRequestRef = useRef(0);

  useEffect(() => {
    fetch('/api/knowledge')
      .then(async (response) => {
        if (!response.ok) throw new Error('knowledge_unavailable');
        return response.json();
      })
      .then(({ entries }) => setKnowledgeEntries(entries))
      .catch(() => setKnowledgeError('The knowledge base could not be loaded. Case work remains available.'));
  }, []);

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

  function updateDiagnosticSelection(caseId, ids, selected) {
    setDrafts((current) => {
      const draft = current[caseId] || {};
      const selectedIds = Array.isArray(draft.selectedDiagnosticIds) ? draft.selectedDiagnosticIds : [];
      const nextIds = selected
        ? [...new Set([...selectedIds, ...ids])]
        : selectedIds.filter((id) => !ids.includes(id));
      return { ...current, [caseId]: { ...draft, selectedDiagnosticIds: nextIds } };
    });
  }

  async function searchDiagnostics(event) {
    event.preventDefault();
    const query = diagnosticQuery.trim();
    if (!query) {
      setDiagnosticSearchError('Enter an exact request, event, or diagnostic row ID.');
      setDiagnosticSearchState('error');
      setDiagnosticMatches([]);
      setDiagnosticHistories([]);
      return;
    }
    const request = ++diagnosticSearchRequestRef.current;
    setDiagnosticSearchState('loading');
    setDiagnosticSearchError('');
    setDiagnosticMatches([]);
    setDiagnosticHistories([]);
    setDiagnosticDetail(null);
    try {
      const response = await fetch('/api/diagnostics?q=' + encodeURIComponent(query));
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'diagnostic_search_unavailable');
      if (request !== diagnosticSearchRequestRef.current) return;
      setDiagnosticMatches(body.matches);
      setDiagnosticHistories(body.histories);
      setDiagnosticSearchState('ready');
    } catch {
      if (request !== diagnosticSearchRequestRef.current) return;
      setDiagnosticSearchError('Diagnostic search is unavailable. Your active case and drafts remain available.');
      setDiagnosticSearchState('error');
    }
  }

  async function inspectDiagnostic(diagnosticId) {
    const request = ++diagnosticDetailRequestRef.current;
    setDiagnosticDetail({ diagnosticId, state: 'loading' });
    try {
      const response = await fetch('/api/diagnostics/' + encodeURIComponent(diagnosticId));
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'diagnostic_detail_unavailable');
      if (request === diagnosticDetailRequestRef.current) setDiagnosticDetail({ diagnosticId, state: 'ready', body });
    } catch {
      if (request === diagnosticDetailRequestRef.current) setDiagnosticDetail({ diagnosticId, state: 'error' });
    }
  }

  async function inspectKnowledge(entryId) {
    if (knowledgeEntry?.entry?.id === entryId) {
      setKnowledgeEntry(null);
      return;
    }
    const request = ++knowledgeRequestRef.current;
    setKnowledgeEntry({ id: entryId, state: 'loading' });
    try {
      const response = await fetch('/api/knowledge/' + encodeURIComponent(entryId));
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'knowledge_unavailable');
      if (request === knowledgeRequestRef.current) setKnowledgeEntry({ id: entryId, state: 'ready', entry: body.entry });
    } catch {
      if (request === knowledgeRequestRef.current) setKnowledgeEntry({ id: entryId, state: 'error' });
    }
  }

  function storePending(slot, action) {
    const next = { ...pendingRequestsRef.current, [slot]: action };
    pendingRequestsRef.current = next;
    saveStorage(sessionStorage, pendingStorageKey, next);
    setPendingRequests(next);
  }

  function clearPending(slot) {
    const next = { ...pendingRequestsRef.current };
    delete next[slot];
    pendingRequestsRef.current = next;
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

  function describeFailure(status, code, details = {}) {
    if (status === 409 && code === 'stale_case') return 'This case changed in another view. The action was not applied. Refresh the case and review your saved draft before trying again.';
    if (status === 409 && code === 'idempotency_key_reused') return 'This request key is already tied to different content. The action was not applied; refresh the case before continuing.';
    if (status === 409 && code === 'invalid_transition') return 'That status change is not allowed. The case and your draft were preserved.';
    if (code === 'evidence_association_rejected') {
      const problems = [];
      if (details.notFoundIds?.length) problems.push('not found: ' + details.notFoundIds.join(', '));
      if (details.differentOrganizationIds?.length) problems.push('belongs to another organization: ' + details.differentOrganizationIds.join(', '));
      return 'Evidence was not linked (' + (problems.join('; ') || 'check the selected diagnostic IDs') + '). Your selection and other drafts were preserved.';
    }
    if (code === 'invalid_evidence' && (details.unlinkedIds?.length || details.differentOrganizationIds?.length || details.notFoundIds?.length)) {
      const problems = [];
      if (details.notFoundIds?.length) problems.push('not found: ' + details.notFoundIds.join(', '));
      if (details.differentOrganizationIds?.length) problems.push('belongs to another organization: ' + details.differentOrganizationIds.join(', '));
      if (details.unlinkedIds?.length) problems.push('not linked to this case: ' + details.unlinkedIds.join(', '));
      return 'Escalation evidence was rejected (' + problems.join('; ') + '). Your draft was preserved.';
    }
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
        setFeedback((current) => ({ ...current, [slot]: describeFailure(response.status, body.error, body.details) }));
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
      if (action.type === 'evidence') {
        setDrafts((current) => {
          const draft = current[action.caseId] || {};
          const selectedIds = Array.isArray(draft.selectedDiagnosticIds) ? draft.selectedDiagnosticIds : [];
          return sameIds(selectedIds, action.payload.diagnosticIds)
            ? { ...current, [action.caseId]: { ...draft, selectedDiagnosticIds: [] } }
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
                (draft.outstandingQuestions || '') === action.payload.questions &&
                sameIds(draft.escalationEvidenceIds || [], action.payload.evidenceIds || [])
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
                  escalationEvidenceIds: [],
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
        evidenceIds: draft.escalationEvidenceIds || [],
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

  function submitEvidence(event) {
    event.preventDefault();
    if (!selectedCase || selectedIdRef.current !== selectedCase.id) return;
    const caseId = selectedCase.id;
    const diagnosticIds = [...new Set(drafts[caseId]?.selectedDiagnosticIds || [])];
    if (diagnosticIds.length === 0) return;
    const slot = caseId + ':evidence';
    const action = {
      caseId,
      type: 'evidence',
      method: 'POST',
      path: '/api/cases/' + encodeURIComponent(caseId) + '/evidence',
      key: crypto.randomUUID(),
      payload: { diagnosticIds, expectedVersion: selectedCase.version },
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
  const selectedDiagnosticIds = selectedDraft.selectedDiagnosticIds || [];
  const escalationEvidenceIds = selectedDraft.escalationEvidenceIds || [];
  const evidenceSlot = activeCase ? activeCase.id + ':evidence' : '';
  const pendingEvidence = evidenceSlot ? pendingRequests[evidenceSlot] : null;
  const matchedAttemptRows = diagnosticMatches.filter((item) => item.kind === 'webhook_attempt');
  const matchedEventCount = new Set(matchedAttemptRows.map((item) => JSON.stringify([item.organizationId, item.eventId]))).size;
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
        <span className="mode-label">M3 diagnostic investigation · no AI credentials needed</span>
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

                <section className="diagnostic-section" aria-labelledby="evidence-title">
                  <div className="section-heading">
                    <div><h3 id="evidence-title">Diagnostic evidence</h3><p className="field-hint">Read-only synthetic records. A linked record is a specific diagnostic row, not a live event subscription.</p></div>
                    <span>{activeCase.evidence.length} associated records</span>
                  </div>
                  {activeCase.evidence.length ? (
                    <div className="linked-evidence-list">
                      {activeCase.evidence.map((diagnostic) => (
                        <article className="diagnostic-card" key={diagnostic.id}>
                          <div className="diagnostic-card-heading">
                            <strong>{diagnostic.id}</strong>
                            <span>{diagnostic.source === 'synthetic_seed' ? 'Synthetic seed association' : 'Operator association'}</span>
                          </div>
                          <DiagnosticFacts diagnostic={diagnostic} />
                          <button type="button" onClick={() => inspectDiagnostic(diagnostic.id)}>Inspect record and attempts</button>
                        </article>
                      ))}
                    </div>
                  ) : <p className="empty-diagnostics">No diagnostic evidence is associated with this case.</p>}

                  <form className="diagnostic-search-form" onSubmit={searchDiagnostics}>
                    <label htmlFor="diagnostic-query">Search globally by exact request ID, event ID, or diagnostic row ID</label>
                    <div><input id="diagnostic-query" type="search" maxLength={200} value={diagnosticQuery} onChange={(event) => setDiagnosticQuery(event.target.value)} />
                      <button type="submit" disabled={diagnosticSearchState === 'loading'}>Search diagnostics</button></div>
                    <p className="field-hint">Search is global and may show other organizations. A result is not linked until you explicitly associate its selected row IDs.</p>
                  </form>
                  {diagnosticSearchError && <p className="notice notice-error" role="alert">{diagnosticSearchError}</p>}
                  {diagnosticSearchState === 'loading' && <p role="status">Searching diagnostic records…</p>}
                  {pendingEvidence && <PendingAction slot={evidenceSlot} action={pendingEvidence} busySlot={busySlot} feedback={feedback} retry={sendPending} reconcile={reconcileConflict} />}
                  {!pendingEvidence && feedback[evidenceSlot] && <p className="save-feedback" role="status">{feedback[evidenceSlot]}</p>}
                  {diagnosticSearchState === 'ready' && diagnosticMatches.length === 0 && (
                    <p className="empty-diagnostics" role="status">No diagnostic records matched this exact ID. A missing result does not establish a failure.</p>
                  )}
                  {diagnosticSearchState === 'ready' && diagnosticMatches.length > 0 && (
                    <>
                      <p className="diagnostic-search-summary" role="status">
                        {diagnosticMatches.length} matching diagnostic {diagnosticMatches.length === 1 ? 'row' : 'rows'}
                        {matchedAttemptRows.length > 0 ? ` across ${matchedEventCount} organization-scoped events` : ' for API requests'}.
                        {' '}Attempt rows are not unique events or completed deliveries.
                      </p>
                      <form className="evidence-association-form" onSubmit={submitEvidence}>
                        <ul className="diagnostic-results">
                          {diagnosticMatches.map((diagnostic, index) => {
                            const linked = activeCase.evidence.some((item) => item.id === diagnostic.id);
                            const history = diagnosticHistories.find((item) => item.organizationId === diagnostic.organizationId && item.eventId === diagnostic.eventId);
                            const selected = selectedDiagnosticIds.includes(diagnostic.id);
                            const historyKey = JSON.stringify([diagnostic.organizationId, diagnostic.eventId]);
                            const firstHistoryMatch = diagnostic.kind === 'webhook_attempt' && diagnosticMatches.findIndex((item) => JSON.stringify([item.organizationId, item.eventId]) === historyKey) === index;
                            const selectableAttemptIds = history?.attempts.filter((item) => !activeCase.evidence.some((linkedItem) => linkedItem.id === item.id)).map((item) => item.id) || [];
                            return (
                              <li className="diagnostic-result" key={diagnostic.id}>
                                <div className="diagnostic-result-heading">
                                  <label htmlFor={'select-diagnostic-' + diagnostic.id}>
                                    <input
                                      id={'select-diagnostic-' + diagnostic.id}
                                      type="checkbox"
                                      checked={linked || selected}
                                      disabled={linked}
                                      onChange={(event) => updateDiagnosticSelection(activeCase.id, [diagnostic.id], event.target.checked)}
                                    />
                                    {linked ? 'Already associated' : 'Select for association'}
                                  </label>
                                  <strong>{diagnostic.id}</strong>
                                  <span>{diagnostic.organizationId}</span>
                                </div>
                                <p>{diagnostic.kind === 'webhook_attempt'
                                  ? `Event ${diagnostic.eventId} · attempt ${diagnostic.attemptNumber} · ${history?.attempts.length || 1} records in this organization-scoped event`
                                  : `Request ${diagnostic.requestId}`}</p>
                                <p>{observedOutcome(diagnostic)}</p>
                                <button type="button" onClick={() => inspectDiagnostic(diagnostic.id)}>Inspect record and attempts</button>
                                {firstHistoryMatch && selectableAttemptIds.length > 1 && (
                                  <button type="button" onClick={() => updateDiagnosticSelection(activeCase.id, selectableAttemptIds, true)}>
                                    Select all {selectableAttemptIds.length} unlinked attempt records for this event
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                        <div className="selected-diagnostics">
                          <strong>Rows selected for {activeCase.id}: {selectedDiagnosticIds.length}</strong>
                          {selectedDiagnosticIds.length > 0 && (
                            <ul>{selectedDiagnosticIds.map((id) => <li key={id}>{id}
                              <button type="button" aria-label={'Remove ' + id + ' from selection'} onClick={() => updateDiagnosticSelection(activeCase.id, [id], false)}>Remove</button>
                            </li>)}</ul>
                          )}
                        </div>
                        <button type="submit" disabled={!selectedDiagnosticIds.length || Boolean(busySlot) || Boolean(pendingEvidence)}>
                          Link selected evidence to {activeCase.id}
                        </button>
                      </form>
                    </>
                  )}

                  {diagnosticDetail && (
                    <section className="diagnostic-inspection" aria-label="Selected diagnostic details">
                      {diagnosticDetail.state === 'loading' && <p role="status">Loading diagnostic details…</p>}
                      {diagnosticDetail.state === 'error' && <p className="notice notice-error" role="alert">Diagnostic details are unavailable. The active case and evidence selection remain unchanged.</p>}
                      {diagnosticDetail.state === 'ready' && (
                        <>
                          <h4>Inspection: {diagnosticDetail.body.diagnostic.id}</h4>
                          <DiagnosticFacts diagnostic={diagnosticDetail.body.diagnostic} />
                          {diagnosticDetail.body.attempts.length > 0 && (
                            <>
                              <div className="section-heading">
                                <h4>Complete event history</h4>
                                <span>{diagnosticDetail.body.attempts.length} attempt records · one organization-scoped event</span>
                              </div>
                              <ol className="attempt-history">
                                {diagnosticDetail.body.attempts.map((attempt) => {
                                  const linked = activeCase.evidence.some((item) => item.id === attempt.id);
                                  const selected = selectedDiagnosticIds.includes(attempt.id);
                                  return <li className="diagnostic-card" key={attempt.id}>
                                    <DiagnosticFacts diagnostic={attempt} />
                                    <label><input type="checkbox" checked={linked || selected} disabled={linked} onChange={(event) => updateDiagnosticSelection(activeCase.id, [attempt.id], event.target.checked)} />
                                      {linked ? 'Already associated with this case' : 'Select this attempt for association'}</label>
                                  </li>;
                                })}
                              </ol>
                              {diagnosticDetail.body.attempts.some((item) => !activeCase.evidence.some((linkedItem) => linkedItem.id === item.id)) && (
                                <button type="button" onClick={() => updateDiagnosticSelection(activeCase.id, diagnosticDetail.body.attempts.filter((item) => !activeCase.evidence.some((linkedItem) => linkedItem.id === item.id)).map((item) => item.id), true)}>
                                  Select all unlinked attempt records
                                </button>
                              )}
                            </>
                          )}
                        </>
                      )}
                    </section>
                  )}
                </section>

                <section className="knowledge-section" aria-labelledby="knowledge-title">
                  <div className="section-heading"><h3 id="knowledge-title">Knowledge base</h3><span>Fictional technical guidance · no retrieval or AI</span></div>
                  {knowledgeError && <p className="notice notice-error" role="alert">{knowledgeError}</p>}
                  <ul className="knowledge-list">
                    {knowledgeEntries.map((entry) => (
                      <li key={entry.id}>
                        <button type="button" aria-expanded={knowledgeEntry?.id === entry.id && knowledgeEntry.state === 'ready'} onClick={() => inspectKnowledge(entry.id)}>
                          {entry.id} · {entry.title} · v{entry.version}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {knowledgeEntry?.state === 'loading' && <p role="status">Loading knowledge entry…</p>}
                  {knowledgeEntry?.state === 'error' && <p className="notice notice-error" role="alert">This knowledge entry is unavailable. The case workspace remains open.</p>}
                  {knowledgeEntry?.state === 'ready' && <article className="knowledge-entry"><h4>{knowledgeEntry.entry.id} · {knowledgeEntry.entry.title}</h4><p>{knowledgeEntry.entry.content}</p></article>}
                </section>

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
                            <fieldset className="escalation-evidence">
                              <legend>Unsaved escalation evidence selection</legend>
                              {activeCase.evidence.map((diagnostic) => (
                                <label key={diagnostic.id}>
                                  <input
                                    type="checkbox"
                                    checked={escalationEvidenceIds.includes(diagnostic.id)}
                                    onChange={(event) => updateDraft(activeCase.id, 'escalationEvidenceIds', event.target.checked
                                      ? [...new Set([...escalationEvidenceIds, diagnostic.id])]
                                      : escalationEvidenceIds.filter((id) => id !== diagnostic.id))}
                                  />
                                  {diagnostic.id}
                                </label>
                              ))}
                            </fieldset>
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
                          <fieldset className="escalation-evidence">
                            <legend>Diagnostic evidence already linked to this case</legend>
                            {activeCase.evidence.length === 0 && <p className="field-hint">No evidence is linked. This escalation will record an empty list.</p>}
                            {activeCase.evidence.map((diagnostic) => (
                              <label key={diagnostic.id}>
                                <input
                                  type="checkbox"
                                  checked={escalationEvidenceIds.includes(diagnostic.id)}
                                  onChange={(event) => updateDraft(activeCase.id, 'escalationEvidenceIds', event.target.checked
                                    ? [...new Set([...escalationEvidenceIds, diagnostic.id])]
                                    : escalationEvidenceIds.filter((id) => id !== diagnostic.id))}
                                />
                                {diagnostic.id} · {diagnostic.eventId || diagnostic.requestId} · {observedOutcome(diagnostic)}
                              </label>
                            ))}
                          </fieldset>
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
      {action.type === 'status' && action.payload.status === 'escalated' && (
        <blockquote>Submitted escalation evidence: {action.payload.evidenceIds?.length ? action.payload.evidenceIds.join(', ') : 'None linked.'}</blockquote>
      )}
      {action.type === 'evidence' && (
        <blockquote>Submitted diagnostic rows: {action.payload.diagnosticIds.join(', ')}</blockquote>
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
