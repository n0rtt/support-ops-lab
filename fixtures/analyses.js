export const analysisFixtures = [
  {
    id: 'fixture-a-intentional-outage-error',
    version: '1.0.0',
    caseId: 'SEW-1001',
    title: 'A — intentionally incorrect outage diagnosis',
    label: 'Synthetic evaluation fixture · intentionally incorrect',
    requires: { diagnosticIds: ['DIAG-AUTH-401-001', 'DIAG-AUTH-401-002', 'DIAG-AUTH-401-003'], noDiagnostics: false },
    recommendation: {
      classification: 'other',
      observations: [{
        text: 'Three supplied API requests returned HTTP 401 Unauthorized.',
        references: ['DIAG-AUTH-401-001', 'DIAG-AUTH-401-002', 'DIAG-AUTH-401-003'].map((id) => ({ kind: 'diagnostic', id })),
      }],
      possibleCause: {
        text: 'The provider is likely experiencing a service outage that is causing the authentication failures.',
        references: [{ kind: 'diagnostic', id: 'DIAG-AUTH-401-001' }],
      },
      nextSteps: [
        'Check an authoritative provider incident source before describing an outage as confirmed.',
        'Ask the customer to verify the configured API key and its required scopes.',
      ],
      draftResponse: 'We are investigating a possible service outage affecting your API requests and will update you when service recovers.',
      references: [
        { kind: 'diagnostic', id: 'DIAG-AUTH-401-001' },
        { kind: 'knowledge', id: 'KB-AUTH-01' },
      ],
      uncertainty: ['No independent provider incident source was supplied.'],
    },
  },
  {
    id: 'fixture-b-webhook-delivery',
    version: '1.0.0',
    caseId: 'SEW-1002',
    title: 'B — webhook delivery evidence',
    label: 'Synthetic evaluation fixture',
    requires: { diagnosticIds: ['DIAG-WH-SUB-001', 'DIAG-WH-SUB-002', 'DIAG-WH-SUB-003', 'DIAG-WH-INV-001', 'DIAG-WH-INV-002'], noDiagnostics: false },
    recommendation: {
      classification: 'webhook_delivery',
      observations: [
        { text: 'The first supplied attempt returned HTTP 500.', references: [{ kind: 'diagnostic', id: 'DIAG-WH-SUB-001' }] },
        { text: 'The second attempt timed out without an HTTP response.', references: [{ kind: 'diagnostic', id: 'DIAG-WH-SUB-002' }] },
        { text: 'The third attempt received HTTP 204 acknowledgment; downstream processing was not observed.', references: [{ kind: 'diagnostic', id: 'DIAG-WH-SUB-003' }] },
        { text: 'The invoice event attempt returned HTTP 503.', references: [{ kind: 'diagnostic', id: 'DIAG-WH-INV-001' }] },
        { text: 'A retry for the invoice event is pending; no delivery time or response was observed.', references: [{ kind: 'diagnostic', id: 'DIAG-WH-INV-002' }] },
      ],
      possibleCause: null,
      nextSteps: [
        'Ask the customer to confirm whether their receiver processed the acknowledged event.',
        'Compare the event ID with the customer application logs for the supplied attempt times.',
      ],
      draftResponse: 'We observed HTTP 500 and timeout results for the subscription event, followed by an HTTP 204 acknowledgment. The invoice event has an HTTP 503 result and a pending retry with no observed response. The 204 confirms endpoint acknowledgment only; we cannot confirm downstream processing for either event. Could you check your receiver logs for both event IDs?',
      references: [{ kind: 'knowledge', id: 'KB-WEBHOOK-01' }],
      uncertainty: ['The receiving application’s downstream processing result was not supplied.'],
    },
  },
  {
    id: 'fixture-c-insufficient-evidence',
    version: '1.0.0',
    caseId: 'SEW-1003',
    title: 'C — insufficient evidence',
    label: 'Synthetic evaluation fixture',
    requires: { diagnosticIds: [], noDiagnostics: true },
    recommendation: {
      classification: 'insufficient_evidence',
      observations: [],
      possibleCause: null,
      nextSteps: [
        'Ask for one exact request ID and a narrow UTC time window.',
        'Request the affected environment and sanitized error details.',
      ],
      draftResponse: 'We do not yet have enough technical detail to identify the cause. Please send one affected request ID, the environment, and an approximate UTC time window, along with any sanitized error response.',
      references: [{ kind: 'knowledge', id: 'KB-REQUEST-01' }],
      uncertainty: ['No request or event identifier, exact occurrence time, or matching diagnostic was supplied.'],
    },
  },
];
