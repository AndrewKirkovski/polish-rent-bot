// Zod v4 schemas for validating Claude JSON responses
// Provides runtime validation + safe defaults for missing fields

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Rental listing schema — matches ParsedRentalData interface
// ---------------------------------------------------------------------------

// Trimmed to the pipeline-critical fields + WFH-fit signals + minimal display text.
// The smaller output also stops the old ~30-field schema truncating at max_tokens.
export const ParsedRentalDataSchema = z.looseObject({
  // --- cost / pipeline-critical ---
  deposit: z.number().nullable().default(null),
  depositNote: z.string().nullable().default(null),
  adminFee: z.number().nullable().default(null),
  addressHint: z.string().nullable().default(null),
  locationHint: z.object({
    query: z.string().nullable().default(null),
    kind: z.enum(['address', 'intersection', 'building', 'estate', 'transit_stop', 'landmark', 'neighborhood', 'none']).default('none'),
    anchorDistanceMeters: z.number().min(0).max(50_000).nullable().default(null),
    uncertaintyMeters: z.number().min(0).max(20_000).nullable().default(null),
    evidence: z.string().nullable().default(null),
  }).default({
    query: null,
    kind: 'none',
    anchorDistanceMeters: null,
    uncertaintyMeters: null,
    evidence: null,
  }),
  isConcreteApartment: z.boolean().nullable().default(true),
  estimatedMedia: z.object({
    water: z.number().nullable().default(null),
    electricity: z.number().nullable().default(null),
    gas: z.number().nullable().default(null),
    internet: z.number().nullable().default(null),
    heating: z.number().nullable().default(null),
    other: z.number().nullable().default(null),
  }).default({
    water: null,
    electricity: null,
    gas: null,
    internet: null,
    heating: null,
    other: null,
  }),
  contractType: z.enum(['najem_okazjonalny', 'najem_zwykly', 'najem_instytucjonalny']).nullable().default(null),
  availableFrom: z.string().nullable().default(null),
  minimumLease: z.string().nullable().default(null),
  furnished: z.enum(['full', 'partial', 'none']).nullable().default(null),
  balcony: z.boolean().nullable().default(null),
  parkingIncluded: z.boolean().nullable().default(null),
  // --- work-from-home fit (the signals this household ranks on) ---
  separateRooms: z.number().nullable().default(null),
  layoutType: z.enum(['rozkladowy', 'przechodni', 'open']).nullable().default(null),
  twoOfficeCapable: z.boolean().nullable().default(null),
  quiet: z.enum(['quiet', 'mixed', 'noisy']).nullable().default(null),
  naturalLight: z.enum(['bright', 'average', 'dark']).nullable().default(null),
  internetType: z.enum(['fiber', 'cable', 'unknown']).nullable().default(null),
  // --- display ---
  descriptionSummary: z.string().nullable().default(null),
  redFlags: z.array(z.string()).default([]),
  positives: z.array(z.string()).default([]),
  restrictions: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Item listing schema — matches ParsedItemData interface
// ---------------------------------------------------------------------------

export const ParsedItemDataSchema = z.looseObject({
  actualCondition: z.string().default('Unknown'),
  whySelling: z.string().nullable().default(null),
  defects: z.array(z.string()).default([]),
  includedAccessories: z.array(z.string()).default([]),
  priceAssessment: z.string().nullable().default(null),
  descriptionSummary: z.string().nullable().default(null),
  bestFor: z.string().nullable().default(null),
  redFlags: z.array(z.string()).default([]),
  additionalNotes: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Rejection evaluation schema (two-tier AI caching)
// ---------------------------------------------------------------------------

export const RejectionResultSchema = z.object({
  rejected: z.boolean().default(false),
  rejectionReason: z.string().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Rental triage — cheap pre-parse gate: is it a whole apartment, and how many rooms?
// ---------------------------------------------------------------------------

export const RentalTriageSchema = z.object({
  apartment: z.boolean().default(true),   // false = single room / coliving / not one flat
  rooms: z.number().nullable().default(null),
});
