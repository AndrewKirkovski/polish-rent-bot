// OLX room + district API matrix — verifies multi-room query strategy.
// Run: npx tsx src/experiments/test-olx-rooms-districts.ts

import { writeFileSync, mkdirSync } from 'fs';
import { searchOlx, OLX_CATEGORIES, OLX_CITIES, OLX_DISTRICTS } from '../crawlers/olx.js';

const RESULTS_DIR = '.local/recon';
mkdirSync(RESULTS_DIR, { recursive: true });

const CITY_ID = OLX_CITIES.WARSZAWA;
const MOKOTOW = OLX_DISTRICTS.warszawa.mokotow;
const WOLA = OLX_DISTRICTS.warszawa.wola;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
  Referer: 'https://www.olx.pl/',
};

async function fetchRoomCombo(label: string, qsExtra: string): Promise<{ label: string; count: number; roomCounts: Record<number, number> }> {
  const base = `https://www.olx.pl/api/v1/offers/?offset=0&limit=40&category_id=${OLX_CATEGORIES.MIESZKANIA_WYNAJEM}&city_id=${CITY_ID}&district_id=${MOKOTOW}&sort_by=created_at:desc&filter_refiners=spell_checker&${qsExtra}`;
  const res = await fetch(base, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  const data = await res.json() as { data?: unknown[] };
  const listings = data.data ?? [];
  const roomCounts: Record<number, number> = {};
  for (const raw of listings as Array<{ params?: Array<{ key: string; value?: { key?: string } }> }>) {
    const roomsParam = raw.params?.find((p) => p.key === 'rooms');
    const key = roomsParam?.value?.key;
    const map: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
    const n = key ? map[key] ?? 0 : 0;
    if (n) roomCounts[n] = (roomCounts[n] ?? 0) + 1;
  }
  return { label, count: listings.length, roomCounts };
}

async function main() {
  console.log('=== OLX Room + District Matrix ===\n');

  const roomTests = [
    await fetchRoomCombo('rooms[0]=three only', 'filter_enum_rooms%5B0%5D=three'),
    await fetchRoomCombo('rooms[0]=two&rooms[1]=three', 'filter_enum_rooms%5B0%5D=two&filter_enum_rooms%5B1%5D=three'),
    await fetchRoomCombo('no room filter', ''),
  ];

  const separateTwo = await searchOlx({ categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM, cityId: CITY_ID, districtId: MOKOTOW, rooms: 2, limit: 40 });
  const separateThree = await searchOlx({ categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM, cityId: CITY_ID, districtId: MOKOTOW, rooms: 3, limit: 40 });

  const districtMokotow = await searchOlx({ categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM, cityId: CITY_ID, districtId: MOKOTOW, rooms: 3, limit: 10 });
  const districtWola = await searchOlx({ categoryId: OLX_CATEGORIES.MIESZKANIA_WYNAJEM, cityId: CITY_ID, districtId: WOLA, rooms: 3, limit: 10 });

  const matrix = {
    testedAt: new Date().toISOString(),
    roomTests,
    separateQueries: {
      two: { count: separateTwo.listings.length, sampleDistricts: [...new Set(separateTwo.listings.map((l) => l.district))].slice(0, 5) },
      three: { count: separateThree.listings.length, sampleDistricts: [...new Set(separateThree.listings.map((l) => l.district))].slice(0, 5) },
    },
    districtTests: {
      mokotow: { count: districtMokotow.listings.length, districts: [...new Set(districtMokotow.listings.map((l) => l.district))] },
      wola: { count: districtWola.listings.length, districts: [...new Set(districtWola.listings.map((l) => l.district))] },
    },
    recommendation: 'Use parallel per-room queries; multi-value filter_enum_rooms may not return union — verify roomTests.',
  };

  const outPath = `${RESULTS_DIR}/olx-room-district-matrix.json`;
  writeFileSync(outPath, JSON.stringify(matrix, null, 2), 'utf-8');
  console.log(JSON.stringify(matrix, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(console.error);
