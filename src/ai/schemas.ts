// Zod v4 schemas for validating Claude JSON responses
// Provides runtime validation + safe defaults for missing fields

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Rental listing schema — matches ParsedRentalData interface
// ---------------------------------------------------------------------------

export const ParsedRentalDataSchema = z.looseObject({
  deposit: z.number().nullable().default(null),
  depositNote: z.string().nullable().default(null),
  adminFee: z.number().nullable().default(null),
  adminFeeIncludes: z.string().nullable().default(null),
  tenantPays: z.string().nullable().default(null),
  estimatedMedia: z.object({
    water: z.number().nullable().default(null),
    electricity: z.number().nullable().default(null),
    gas: z.number().nullable().default(null),
    internet: z.number().nullable().default(null),
    heating: z.number().nullable().default(null),
  }).default({
    water: null,
    electricity: null,
    gas: null,
    internet: null,
    heating: null,
  }),
  totalMonthlyCost: z.number().nullable().default(null),
  totalBreakdown: z.string().nullable().default(null),
  contractType: z.enum(['najem_okazjonalny', 'najem_zwykly', 'najem_instytucjonalny']).nullable().default(null),
  contractNote: z.string().nullable().default(null),
  availableFrom: z.string().nullable().default(null),
  minimumLease: z.string().nullable().default(null),
  petFriendly: z.boolean().nullable().default(null),
  smokingAllowed: z.boolean().nullable().default(null),
  furnished: z.enum(['full', 'partial', 'none']).nullable().default(null),
  parkingIncluded: z.boolean().nullable().default(null),
  balcony: z.boolean().nullable().default(null),
  descriptionSummary: z.string().nullable().default(null),
  furnitureAndEquipment: z.array(z.string()).default([]),
  kitchenDetails: z.string().nullable().default(null),
  bathroomDetails: z.string().nullable().default(null),
  internetReady: z.string().nullable().default(null),
  landlordNotes: z.string().nullable().default(null),
  bestSuitedFor: z.string().nullable().default(null),
  redFlags: z.array(z.string()).default([]),
  positives: z.array(z.string()).default([]),
  restrictions: z.array(z.string()).default([]),
  additionalNotes: z.array(z.string()).default([]),
  rejected: z.boolean().default(false),
  rejectionReason: z.string().nullable().default(null),
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
  rejected: z.boolean().default(false),
  rejectionReason: z.string().nullable().default(null),
});
