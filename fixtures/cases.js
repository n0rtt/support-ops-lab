export const initialCases = [
  {
    id: 'SEW-1001',
    organizationId: 'ORG-ALDER-01',
    organizationName: 'Alder Ridge Analytics',
    subject: 'Nightly API sync returns 401 responses',
    channel: 'email',
    priority: 'high',
    status: 'open',
    createdAt: '2026-10-19T08:15:00.000Z',
    updatedAt: '2026-10-19T08:15:00.000Z',
    initialReport:
      'Our nightly sync started failing on every request. It was working last week, and we have not changed the endpoint.',
  },
  {
    id: 'SEW-1002',
    organizationId: 'ORG-CEDAR-02',
    organizationName: 'Cedarline Subscriptions',
    subject: 'Subscription updates are not appearing',
    channel: 'telegram',
    priority: 'medium',
    status: 'in_progress',
    createdAt: '2026-10-18T14:20:00.000Z',
    updatedAt: '2026-10-18T14:20:00.000Z',
    initialReport:
      'Several subscription changes have not appeared in our app since yesterday. We do not have a request ID yet.',
  },
  {
    id: 'SEW-1003',
    organizationId: 'ORG-BIRCH-03',
    organizationName: 'Birch Grove Systems',
    subject: 'Intermittent API failures with no request IDs',
    channel: 'manual',
    priority: 'low',
    status: 'open',
    createdAt: '2026-10-20T07:40:00.000Z',
    updatedAt: '2026-10-20T07:40:00.000Z',
    initialReport:
      'Some requests seem to fail intermittently, but we cannot yet provide a request identifier or an exact time.',
  },
];
