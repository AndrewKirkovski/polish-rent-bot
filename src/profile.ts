// Hardcoded household profile — two work-from-home professionals, no kids/pets/students,
// needing two home offices. The one place to edit who the bot searches for; drives the
// persona prompt, fit-score weights, and amenity taxonomy.

import type { AmenityPreference } from './ai/maps.js';

export interface HouseholdProfile {
  city: string;
  districts: string[];
  // Room count is chosen per search (roomsFrom/roomsTo), not fixed here.
  budgetTotalPln: { from: number; to: number };  // TOTAL = najem + czynsz + media
  amenities: AmenityPreference[];
  weights: Record<string, number>;               // consumed by computeFitScore
}

export const HOUSEHOLD_PROFILE: HouseholdProfile = {
  city: 'warszawa',
  districts: ['mokotow', 'wola', 'srodmiescie', 'ochota', 'zoliborz'],
  budgetTotalPln: { from: 3000, to: 8000 },
  amenities: [
    { type: 'metro', maxMinutes: 12 },
    { type: 'groceries', maxMinutes: 10 },
    { type: 'gym', maxMinutes: 15 },
    { type: 'cafe', maxMinutes: 10 },
    { type: 'restaurant', maxMinutes: 10 },
  ],
  weights: {
    twoOfficeCapable: 1.0,
    internet: 1.0,
    quiet: 0.9,
    naturalLight: 0.6,
    budget: 0.6,
    amenities: 0.6,
    elevator: 0.3,
  },
};

/** Compact persona block prepended to the extraction prompt (cached, ~free per listing). */
export function personaPromptLine(p: HouseholdProfile = HOUSEHOLD_PROFILE): string {
  return `Household: two work-from-home professionals sharing the flat in ${p.city}. `
    + `No children, no pets, not students. They need TWO separate quiet rooms usable as home `
    + `offices (simultaneous video calls), fibre/reliable internet, low noise, natural light, `
    + `and proximity to metro/groceries/gym/cafes/restaurants. IGNORE schools, kindergartens, `
    + `playgrounds, pet policy and student-oriented features.`;
}
