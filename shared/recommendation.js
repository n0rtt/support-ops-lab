import { z } from 'zod';

export const recommendationSchemaVersion = 'recommendation-v1';

const referenceSchema = z.strictObject({
  kind: z.enum(['diagnostic', 'knowledge']),
  id: z.string().min(1).max(120),
});

const citedTextSchema = z.strictObject({
  text: z.string().min(1).max(2000),
  references: z.array(referenceSchema).max(20),
});

export const recommendationSchema = z.strictObject({
  classification: z.enum(['authentication', 'webhook_delivery', 'insufficient_evidence', 'other']),
  observations: z.array(citedTextSchema).max(20),
  possibleCause: citedTextSchema.nullable(),
  nextSteps: z.array(z.string().min(1).max(2000)).min(1).max(10),
  draftResponse: z.string().min(1).max(10000),
  references: z.array(referenceSchema).max(40),
  uncertainty: z.array(z.string().min(1).max(2000)).max(20),
});

export function validateRecommendation(value) {
  const result = recommendationSchema.safeParse(value);
  if (!result.success) return result;
  if (result.data.classification === 'insufficient_evidence' && result.data.uncertainty.length === 0) {
    return { success: false, error: new Error('Insufficient-evidence recommendations must state what is unknown.') };
  }
  return result;
}

export function recommendationReferences(recommendation) {
  return [
    ...recommendation.references.map((reference) => ({ ...reference, location: 'references' })),
    ...recommendation.observations.flatMap((observation, index) => observation.references.map((reference) => ({
      ...reference,
      location: `observations[${index}]`,
    }))),
    ...(recommendation.possibleCause?.references.map((reference) => ({ ...reference, location: 'possibleCause' })) || []),
  ];
}
