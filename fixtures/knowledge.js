export const initialKnowledgeEntries = [
  {
    id: 'KB-AUTH-01', version: 1, title: 'Interpreting API authentication failures',
    content: 'A 401 response indicates that the observed request was not authorized with its supplied credentials. Confirm the configured key, its active status, and required scopes with the customer. Repeated 401 responses alone do not establish a provider outage.',
  },
  {
    id: 'KB-WEBHOOK-01', version: 1, title: 'Webhook retries and endpoint acknowledgment',
    content: 'A failed or timed-out attempt may be followed by another retry. A 2xx response, including 204, shows that the endpoint acknowledged the HTTP request. It does not show whether the receiving application completed downstream business processing.',
  },
  {
    id: 'KB-REQUEST-01', version: 1, title: 'Request identifiers and investigation windows',
    content: 'Ask for the exact request or event identifier, the affected environment, and a narrow UTC time window. Request sanitized response details when an identifier is unavailable. Do not infer a matching diagnostic from approximate timing alone.',
  },
  {
    id: 'KB-OUTAGE-01', version: 1, title: 'What diagnostic evidence can show about outages',
    content: 'A local authentication error or an individual endpoint response cannot confirm a provider-wide outage. Compare independent observations and use an authoritative incident source before describing an outage as confirmed. Keep unobserved causes as hypotheses.',
  },
];
