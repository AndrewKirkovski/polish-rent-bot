// Shared test factory — minimal Listing with sensible defaults, override per test.
import type { Listing, ParsedRentalData, LocationScore } from '../src/types.js';

export function mkListing(over: Partial<Listing> = {}): Listing {
  return {
    platformId: 'x', platform: 'olx', url: 'http://example.com/x', slug: 's',
    title: 'Mieszkanie 3 pokoje Mokotow', description: '',
    price: 4000, currency: 'PLN', rent: 500, deposit: null,
    area: 60, rooms: 3, floor: 2, buildingFloor: 5, buildingType: null,
    heating: null, furniture: null, parking: null,
    hasInternet: null, hasElevator: null, hasAc: null, buildYear: null,
    city: 'warszawa', district: null, street: null, region: 'mazowieckie',
    lat: null, lng: null, phone: null, contactName: null, advertiserType: null, agencyName: null,
    photos: [], createdAt: '', scrapedAt: '',
    ...over,
  };
}

export function mkParsed(over: Partial<ParsedRentalData> = {}): ParsedRentalData {
  return {
    deposit: null, depositNote: null, adminFee: null, addressHint: null, isConcreteApartment: true,
    estimatedMedia: { water: null, electricity: null, gas: null, internet: null, heating: null },
    contractType: null, availableFrom: null, minimumLease: null, furnished: null,
    balcony: null, parkingIncluded: null,
    separateRooms: null, layoutType: null, twoOfficeCapable: null, quiet: null, naturalLight: null, internetType: null,
    descriptionSummary: null, redFlags: [], positives: [], restrictions: [],
    ...over,
  };
}

export function mkScore(amenities: LocationScore['amenities'], over: Partial<LocationScore> = {}): LocationScore {
  return { amenities, commute: null, overallScore: 50, mapsLink: 'http://m', precision: 'exact', ...over };
}
