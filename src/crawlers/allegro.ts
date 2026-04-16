// Allegro REST API crawler — OAuth Device Flow + /offers/listing search
// Docs: https://developer.allegro.pl/tutorials/uwierzytelnianie-i-autoryzacja-zlq9e75GdIR

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import type { ItemListing } from './olx-items.js';

const ALLEGRO_AUTH_URL = 'https://allegro.pl/auth/oauth';
const ALLEGRO_API_URL = 'https://api.allegro.pl';

const CLIENT_ID = process.env.ALLEGRO_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.ALLEGRO_CLIENT_SECRET ?? '';
const AUTH_HEADER = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

const TOKEN_DIR = '.local/sessions';
const TOKEN_FILE = `${TOKEN_DIR}/allegro-token.json`;
mkdirSync(TOKEN_DIR, { recursive: true });

interface AllegroToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number; // epoch ms — calculated on save
}

// --- Token Management ---

function loadToken(): AllegroToken | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, { encoding: 'utf-8' }));
    return data as AllegroToken;
  } catch {
    return null;
  }
}

function saveToken(token: AllegroToken): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { encoding: 'utf-8' });
}

function isTokenExpired(token: AllegroToken): boolean {
  return Date.now() > token.expires_at - 60_000; // 1 minute buffer
}

// --- Device Flow Auth ---

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const res = await fetch(`${ALLEGRO_AUTH_URL}/device`, {
    method: 'POST',
    headers: {
      'Authorization': AUTH_HEADER,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'client_id=' + CLIENT_ID,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device flow init failed: ${res.status} ${text}`);
  }

  return await res.json() as DeviceCodeResponse;
}

export async function pollForToken(deviceCode: string, interval: number, timeoutMs = 300_000): Promise<AllegroToken> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const res = await fetch(`${ALLEGRO_AUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceCode}`,
    });

    if (res.status === 200) {
      const data = await res.json() as any;
      const token: AllegroToken = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_type: data.token_type,
        expires_in: data.expires_in,
        expires_at: Date.now() + data.expires_in * 1000,
      };
      saveToken(token);
      return token;
    }

    const body = await res.json().catch(() => ({})) as any;
    const error = body.error;

    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 1;
      continue;
    }
    if (error === 'access_denied') throw new Error('User denied authorization');
    if (error === 'expired_token') throw new Error('Device code expired — restart the flow');

    throw new Error(`Unexpected auth error: ${error} ${JSON.stringify(body)}`);
  }

  throw new Error('Device flow timed out');
}

async function refreshToken(token: AllegroToken): Promise<AllegroToken> {
  const res = await fetch(`${ALLEGRO_AUTH_URL}/token`, {
    method: 'POST',
    headers: {
      'Authorization': AUTH_HEADER,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=refresh_token&refresh_token=${token.refresh_token}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json() as any;
  const newToken: AllegroToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveToken(newToken);
  return newToken;
}

export async function getValidToken(): Promise<AllegroToken> {
  let token = loadToken();

  if (!token) {
    throw new Error('No Allegro token. Run the auth flow first (startDeviceFlow + pollForToken).');
  }

  if (isTokenExpired(token)) {
    console.log('  Allegro: refreshing expired token...');
    token = await refreshToken(token);
  }

  return token;
}

// --- Search API ---

export interface AllegroSearchParams {
  phrase: string;
  categoryId?: string;
  priceFrom?: number;
  priceTo?: number;
  searchMode?: 'REGULAR' | 'DESCRIPTIONS' | 'CLOSED';
  sort?: string;        // '-startTime', '+price', '-price', '-popularity'
  offset?: number;
  limit?: number;       // max 60
}

async function allegroFetch<T>(path: string, token: AllegroToken): Promise<T> {
  const res = await fetch(`${ALLEGRO_API_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${token.access_token}`,
      'Accept': 'application/vnd.allegro.public.v1+json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Allegro API ${res.status}: ${text.slice(0, 300)}`);
  }

  return await res.json() as T;
}

function parseAllegroOffer(item: any): ItemListing {
  const price = item.sellingMode?.price;
  const delivery = item.delivery?.lowestPrice;
  const seller = item.seller ?? {};
  const images = (item.images ?? []).map((img: any) => img.url);

  return {
    platformId: String(item.id),
    platform: 'olx', // reusing type — will change to 'allegro' when we extend Platform type
    url: `https://allegro.pl/oferta/${item.id}`,
    title: item.name ?? '',
    description: '', // not in listing response, need separate call
    price: price ? parseFloat(price.amount) : 0,
    currency: price?.currency ?? 'PLN',
    negotiable: false,
    condition: null, // available via filters, not per-item in listing
    city: item.location?.city ?? '',
    district: null,
    region: item.location?.province ?? '',
    lat: null,
    lng: null,
    phone: null,
    contactName: seller.login ?? null,
    isBusiness: seller.company ?? false,
    photos: images,
    categoryId: item.category?.id ? parseInt(item.category.id, 10) : 0,
    categoryName: null,
    params: {
      format: item.sellingMode?.format ?? '',
      popularity: String(item.sellingMode?.popularity ?? 0),
      stock: String(item.stock?.available ?? 0),
      ...(delivery ? { deliveryPrice: `${delivery.amount} ${delivery.currency}` } : {}),
      freeDelivery: String(item.delivery?.availableForFree ?? false),
    },
    createdAt: '', // not in listing response
    scrapedAt: new Date().toISOString(),
  };
}

export interface AllegroSearchResult {
  items: ItemListing[];
  totalAvailable: number;
  hasNextPage: boolean;
}

export async function searchAllegro(params: AllegroSearchParams): Promise<AllegroSearchResult> {
  const token = await getValidToken();

  const qs = new URLSearchParams();
  qs.set('phrase', params.phrase);
  qs.set('searchMode', params.searchMode ?? 'REGULAR');
  qs.set('sort', params.sort ?? '-startTime');
  qs.set('limit', String(params.limit ?? 60));
  qs.set('offset', String(params.offset ?? 0));

  if (params.categoryId) qs.set('category.id', params.categoryId);
  if (params.priceFrom) qs.set('price.from', String(params.priceFrom));
  if (params.priceTo) qs.set('price.to', String(params.priceTo));

  const data = await allegroFetch<any>(`/offers/listing?${qs.toString()}`, token);

  const promoted = (data.items?.promoted ?? []).map(parseAllegroOffer);
  const regular = (data.items?.regular ?? []).map(parseAllegroOffer);
  const items = [...promoted, ...regular];

  const totalAvailable = data.searchMeta?.totalCount ?? 0;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 60;

  return {
    items,
    totalAvailable,
    hasNextPage: offset + limit < Math.min(totalAvailable, 6000), // Allegro caps at 6000
  };
}

export async function searchAllAllegroPages(params: AllegroSearchParams, maxPages = 5): Promise<ItemListing[]> {
  const all: ItemListing[] = [];
  let offset = params.offset ?? 0;
  const limit = params.limit ?? 60;

  for (let page = 0; page < maxPages; page++) {
    const result = await searchAllegro({ ...params, offset, limit });
    all.push(...result.items);

    console.log(`  Allegro page ${page + 1}: ${result.items.length} items (total: ${all.length}/${result.totalAvailable})`);

    if (!result.hasNextPage || result.items.length === 0) break;
    offset += limit;

    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
  }

  return all;
}
