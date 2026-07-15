// Shared types for all crawlers

export type Platform = 'olx' | 'otodom' | 'allegro';

export interface Listing {
  // Identity
  platformId: string;        // ID on the source platform
  platform: Platform;
  url: string;
  slug: string;

  // Core
  title: string;
  description: string;
  price: number;             // monthly rent in PLN
  currency: string;          // usually "PLN"
  rent: number | null;       // czynsz administracyjny (admin fee)
  deposit: number | null;    // kaucja — extracted via AI later

  // Property
  area: number | null;       // m²
  rooms: number | null;
  floor: number | null;
  buildingFloor: number | null;  // total floors in building
  buildingType: string | null;   // blok, kamienica, apartamentowiec, etc.
  heating: string | null;
  furniture: boolean | null;
  parking: string | null;
  // Platform ground truth for the AI parse; null = not stated (AI infers).
  // Fibre-vs-cable is inferred separately — see ParsedRentalData.internetType.
  hasInternet: boolean | null;
  hasElevator: boolean | null;
  hasAc: boolean | null;
  buildYear: number | null;

  // Location
  city: string;
  district: string | null;
  street: string | null;
  region: string;
  lat: number | null;
  lng: number | null;

  // Contact
  phone: string | null;
  contactName: string | null;
  advertiserType: 'private' | 'agency' | 'developer' | null;
  agencyName: string | null;

  // Media
  photos: string[];

  // Timestamps
  createdAt: string;         // ISO 8601 from platform
  scrapedAt: string;         // when we scraped it
}

export interface CrawlResult {
  platform: Platform;
  listings: Listing[];
  totalAvailable: number;
  page: number;
  hasNextPage: boolean;
  nextPageUrl: string | null;
}

export interface SessionState {
  platform: Platform;
  cookies: string;           // JSON serialized cookies or storageState
  expiresAt: string | null;
  userId: string | null;
}

// ---------------------------------------------------------------------------
// AI-parsed listing data
// ---------------------------------------------------------------------------

export interface ParsedRentalData {
  // cost / pipeline-critical
  deposit: number | null;
  depositNote: string | null;
  adminFee: number | null;
  addressHint: string | null;
  isConcreteApartment: boolean | null;
  estimatedMedia: {
    water: number | null;
    electricity: number | null;
    gas: number | null;
    internet: number | null;
    heating: number | null;
  };
  contractType: 'najem_okazjonalny' | 'najem_zwykly' | 'najem_instytucjonalny' | null;
  availableFrom: string | null;
  minimumLease: string | null;
  furnished: 'full' | 'partial' | 'none' | null;
  balcony: boolean | null;
  parkingIncluded: boolean | null;
  // work-from-home fit
  separateRooms: number | null;
  layoutType: 'rozkladowy' | 'przechodni' | 'open' | null;
  twoOfficeCapable: boolean | null;
  quiet: 'quiet' | 'mixed' | 'noisy' | null;
  naturalLight: 'bright' | 'average' | 'dark' | null;
  internetType: 'fiber' | 'cable' | 'unknown' | null;
  // display
  descriptionSummary: string | null;
  redFlags: string[];
  positives: string[];
  restrictions: string[];
}

export interface ParsedItemData {
  // Note: 'relevant' field is used by items to distinguish "wrong product" from "close but rejected"
  actualCondition: string;
  whySelling: string | null;
  defects: string[];
  includedAccessories: string[];
  priceAssessment: string | null;
  descriptionSummary: string | null;
  bestFor: string | null;
  redFlags: string[];
  additionalNotes: string[];
}

// ---------------------------------------------------------------------------
// Rejection cache result (two-tier AI caching)
// ---------------------------------------------------------------------------

export interface RejectionResult {
  rejected: boolean;
  rejectionReason: string | null;
}

// ---------------------------------------------------------------------------
// Location scoring
// ---------------------------------------------------------------------------

export interface NearbyPlace {
  name: string;
  walkingMinutes: number;
  distance: string;
  transitMinutes?: number;      // for airport, groceries transit fallback
  drivingMinutes?: number;      // for airport (taxi estimate)
  frequencyMinutes?: number;    // service frequency at stop (metro/tram/bus)
  lineName?: string;            // transit line name (e.g. "M1", "T15", "175")
}

export interface AmenityResult {
  type: string;
  places: NearbyPlace[];          // top 3 closest, sorted by distance
  nearest: NearbyPlace | null;    // shortcut to places[0]
  withinLimit: boolean;           // true if nearest <= maxMinutes
}

export interface CommuteResult {
  distance: string;
  duration: string;
  durationMinutes: number;
  mode: string;
}

export type LocationPrecision = 'exact' | 'street' | 'district' | 'none';

export interface LocationScore {
  amenities: AmenityResult[];
  commute: CommuteResult | null;
  overallScore: number;
  mapsLink: string;
  precision?: LocationPrecision;
}
