// Zod v4 schemas for validating Claude JSON responses
// Provides runtime validation + safe defaults for missing fields

import { z } from 'zod';

// Tolerant field builders: a single wrong-typed value from Haiku (e.g. "6000 zł" for a number,
// "yes" for a boolean, "silent" for an enum, a bare string where an object is expected) must
// collapse to a safe default instead of throwing and discarding the ENTIRE parse of the listing.
// `.default(x)` only substitutes for `undefined`; `.catch(x)` is what absorbs a *present but
// invalid* value — so every field below carries BOTH.
const nnum = z.number().nullable().default(null).catch(null);
const nstr = z.string().nullable().default(null).catch(null);
const nbool = z.boolean().nullable().default(null).catch(null);
const nenum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values).nullable().default(null).catch(null);
const nstrarr = z.array(z.string()).default([]).catch([]);
const DEFAULT_LOCATION_HINT = { query: null, kind: 'none' as const, anchorDistanceMeters: null, uncertaintyMeters: null, evidence: null };
const DEFAULT_MEDIA = { water: null, electricity: null, gas: null, internet: null, heating: null, other: null };

// ---------------------------------------------------------------------------
// Rental listing schema — matches ParsedRentalData interface
// ---------------------------------------------------------------------------

// Trimmed to the pipeline-critical fields + WFH-fit signals + minimal display text.
// The smaller output also stops the old ~30-field schema truncating at max_tokens.
export const ParsedRentalDataSchema = z.looseObject({
  // --- cost / pipeline-critical ---
  deposit: nnum,
  depositNote: nstr,
  adminFee: nnum,
  addressHint: nstr,
  // A malformed hint (e.g. kind:"transit" instead of "transit_stop", or locationHint as a bare
  // string) must collapse to "none" — handled downstream — NOT throw away the whole listing parse.
  locationHint: z.object({
    query: z.string().nullable().default(null).catch(null),
    kind: z.enum(['address', 'intersection', 'building', 'estate', 'transit_stop', 'landmark', 'neighborhood', 'none']).catch('none').default('none'),
    anchorDistanceMeters: z.number().min(0).max(50_000).nullable().default(null).catch(null),
    uncertaintyMeters: z.number().min(0).max(20_000).nullable().default(null).catch(null),
    evidence: z.string().nullable().default(null).catch(null),
  }).default(DEFAULT_LOCATION_HINT).catch(DEFAULT_LOCATION_HINT),
  isConcreteApartment: z.boolean().nullable().default(true).catch(true),
  estimatedMedia: z.object({
    water: nnum,
    electricity: nnum,
    gas: nnum,
    internet: nnum,
    heating: nnum,
    other: nnum,
  }).default(DEFAULT_MEDIA).catch(DEFAULT_MEDIA),
  contractType: nenum(['najem_okazjonalny', 'najem_zwykly', 'najem_instytucjonalny']),
  availableFrom: nstr,
  minimumLease: nstr,
  furnished: nenum(['full', 'partial', 'none']),
  balcony: nbool,
  parkingIncluded: nbool,
  // --- work-from-home fit (the signals this household ranks on) ---
  separateRooms: nnum,
  layoutType: nenum(['rozkladowy', 'przechodni', 'open']),
  twoOfficeCapable: nbool,
  quiet: nenum(['quiet', 'mixed', 'noisy']),
  naturalLight: nenum(['bright', 'average', 'dark']),
  internetType: nenum(['fiber', 'cable', 'unknown']),
  // --- display ---
  descriptionSummary: nstr,
  redFlags: nstrarr,
  positives: nstrarr,
  restrictions: nstrarr,
});

// ---------------------------------------------------------------------------
// Item listing schema — matches ParsedItemData interface
// ---------------------------------------------------------------------------

export const ParsedItemDataSchema = z.looseObject({
  actualCondition: z.string().default('Unknown').catch('Unknown'),
  whySelling: nstr,
  defects: nstrarr,
  includedAccessories: nstrarr,
  priceAssessment: nstr,
  descriptionSummary: nstr,
  bestFor: nstr,
  redFlags: nstrarr,
  additionalNotes: nstrarr,
});

// ---------------------------------------------------------------------------
// Rejection evaluation schema (two-tier AI caching)
// ---------------------------------------------------------------------------

export const RejectionResultSchema = z.object({
  rejected: z.boolean().default(false).catch(false),
  rejectionReason: nstr,
});

// ---------------------------------------------------------------------------
// Rental triage — cheap pre-parse gate: is it a whole apartment, and how many rooms?
// ---------------------------------------------------------------------------

export const RentalTriageSchema = z.object({
  apartment: z.boolean().default(true).catch(true),   // false = single room / coliving / not one flat
  rooms: nnum,
});
