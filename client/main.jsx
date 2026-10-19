import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const channelNames = {
  email: 'Email',
  telegram: 'Telegram',
  manual: 'Manual / internal',
};

function displayValue(value) {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function App() {
  const [cases, setCases] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/cases', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('case_list_unavailable');
        return response.json();
      })
      .then(({ cases: loadedCases }) => {
        setCases(loadedCases);
        setLoadState('ready');
      })
      .catch((cause) => {
        if (cause.name === 'AbortError') return;
        setError('The synthetic case list could not be loaded. Try refreshing the page.');
        setLoadState('error');
      });
    return () => controller.abort();
  }, []);

  const selectedCase = cases.find((item) => item.id === selectedId) ?? cases[0];

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Support Engineering Workbench home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Support Engineering Workbench</span>
        </a>
        <span className="mode-label">M1 foundation · read-only</span>
      </header>

      <main className="workspace">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Synthetic support desk</p>
            <h1>Support queue</h1>
          </div>
          <span className="case-count">{cases.length} cases</span>
        </div>

        {loadState === 'loading' && <p className="notice">Loading synthetic cases…</p>}
        {loadState === 'error' && <p className="notice notice-error" role="alert">{error}</p>}

        {loadState === 'ready' && (
          <div className="case-layout">
            <nav className="case-list" aria-label="Support cases">
              {cases.map((item) => (
                <button
                  className={'case-card' + (selectedCase?.id === item.id ? ' selected' : '')}
                  key={item.id}
                  type="button"
                  aria-pressed={selectedCase?.id === item.id}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="case-card-top">
                    <span className="case-id">{item.id}</span>
                    <span className={'status status-' + item.status}>{displayValue(item.status)}</span>
                  </span>
                  <strong>{item.subject}</strong>
                  <span className="case-org">{item.organizationName}</span>
                  <span className="case-card-bottom">
                    <span>{channelNames[item.channel]}</span>
                    <span>{formatDate(item.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </nav>

            {selectedCase && (
              <article className="case-detail" aria-labelledby="case-title">
                <div className="detail-topline">
                  <p className="eyebrow">Case {selectedCase.id}</p>
                  <span className={'status status-' + selectedCase.status}>
                    {displayValue(selectedCase.status)}
                  </span>
                </div>
                <h2 id="case-title">{selectedCase.subject}</h2>
                <p className="organization">{selectedCase.organizationName}</p>

                <dl className="case-metadata">
                  <div><dt>Channel</dt><dd>{channelNames[selectedCase.channel]}</dd></div>
                  <div><dt>Priority</dt><dd>{displayValue(selectedCase.priority)}</dd></div>
                  <div><dt>Created</dt><dd>{formatDate(selectedCase.createdAt)}</dd></div>
                  <div><dt>Updated</dt><dd>{formatDate(selectedCase.updatedAt)}</dd></div>
                </dl>

                <section className="report-section" aria-labelledby="report-title">
                  <h3 id="report-title">Initial report</h3>
                  <p className="report-source">Simulated customer intake</p>
                  <blockquote>
                    {selectedCase.initialReport || 'No initial report is available for this case.'}
                  </blockquote>
                </section>
              </article>
            )}
          </div>
        )}
      </main>

      <footer className="footer">
        <span>All cases and organizations are fictional.</span>
        <span>No messages or external systems are connected.</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
