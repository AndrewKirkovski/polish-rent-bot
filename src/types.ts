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
  /** OLX only: true when the platform map pin is the seller-placed building pin
   *  (map.show_detailed=true), false when it's a fuzzed area centroid; null/undefined
   *  for platforms without the signal (e.g. Otodom). */
  coordsPrecise?: boolean | null;

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
  locationHint: {
    /** Best Google-geocodable anchor for the apartment location, copied from the ad. */
    query: string | null;
    kind: 'address' | 'intersection' | 'building' | 'estate' | 'transit_stop' | 'landmark' | 'neighborhood' | 'none';
    /** Claimed/estimated distance from the anchor to the apartment. */
    anchorDistanceMeters: number | null;
    /** Conservative uncertainty around anchorDistanceMeters. */
    uncertaintyMeters: number | null;
    /** Short source phrase or explanation grounded in the listing description. */
    evidence: string | null;
  };
  isConcreteApartment: boolean | null;
  estimatedMedia: {
    water: number | null;
    electricity: number | null;
    gas: number | null;
    internet: number | null;
    heating: number | null;
    /** Undifferentiated zaliczka / "media ~X zł" with no per-utility breakdown. */
    other: number | null;
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
  distanceMeters?: number;
  walkingMinutesRange?: { min: number; max: number };
  distanceMetersRange?: { min: number; max: number };
  approximate?: boolean;
  transitMinutes?: number;      // for airport, groceries transit fallback
  drivingMinutes?: number;      // for airport (taxi estimate)
  frequencyMinutes?: number;    // service frequency at stop (metro/tram/bus)
  lineName?: string;            // transit line name (e.g. "M1", "T15", "175")
}

export interface AmenityResult {
  type: string;
  /** Requested Warsaw metro line, when this result is line-specific. */
  requestedLine?: 'M1' | 'M2';
  places: NearbyPlace[];          // closest candidates, sorted by expected/reachable distance
  nearest: NearbyPlace | null;    // shortcut to places[0]
  withinLimit: boolean;           // true if nearest <= maxMinutes
  uncertain?: boolean;            // estimated range crosses the requested threshold
  error?: boolean;                // transient Maps API/measurement failure — verdict UNKNOWN,
                                  // not a genuine "nothing nearby" (empty places is ambiguous otherwise)
}

export interface CommuteResult {
  distance: string;
  duration: string;
  durationMinutes: number;
  mode: string;
}

/** Public-transport estimate to Warszawa Centralna (weekday 11:00). Time is a min-based range;
 *  null time means the routing API failed (distance is still an offline straight-line fallback). */
export interface CentralStationEstimate {
  distanceText: string;
  durationMinRange: { min: number; max: number } | null;
}

export type LocationPrecision = 'exact' | 'street' | 'approximate' | 'district' | 'none';

export interface LocationScore {
  amenities: AmenityResult[];
  commute: CommuteResult | null;
  /** The 2 nearest metro stations (any line), computed offline from coordinates. */
  metroNearest: NearbyPlace[];
  /** Transit time + distance to Warszawa Centralna; null when location is unknown. */
  centralStation: CentralStationEstimate | null;
  overallScore: number;
  mapsLink: string;
  precision?: LocationPrecision;
  locationUnknown?: boolean;
  locationWarning?: string;
  locationEvidence?: string;
}
