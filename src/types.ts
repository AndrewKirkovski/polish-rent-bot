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
  deposit: number | null;
  adminFee: number | null;
  estimatedMedia: {
    water: number | null;
    electricity: number | null;
    gas: number | null;
    internet: number | null;
    heating: number | null;
  };
  totalMonthlyCost: number | null;
  contractType: 'najem_okazjonalny' | 'najem_zwykly' | 'najem_instytucjonalny' | null;
  availableFrom: string | null;
  minimumLease: string | null;
  petFriendly: boolean | null;
  smokingAllowed: boolean | null;
  furnished: 'full' | 'partial' | 'none' | null;
  parkingIncluded: boolean | null;
  balcony: boolean | null;
  additionalNotes: string[];
}

export interface ParsedItemData {
  actualCondition: string;
  whySelling: string | null;
  defects: string[];
  includedAccessories: string[];
  additionalNotes: string[];
}

// ---------------------------------------------------------------------------
// Location scoring
// ---------------------------------------------------------------------------

export interface AmenityResult {
  type: string;
  nearest: { name: string; walkingMinutes: number; distance: string } | null;
  withinLimit: boolean;
}

export interface CommuteResult {
  distance: string;
  duration: string;
  durationMinutes: number;
  mode: string;
}

export interface LocationScore {
  amenities: AmenityResult[];
  commute: CommuteResult | null;
  overallScore: number;
  mapsLink: string;
}
