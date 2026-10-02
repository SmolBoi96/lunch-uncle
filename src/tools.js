/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

// CT Hub 2, 114 Lavender Street.
export const CT_HUB_2 = { latitude: 1.311797, longitude: 103.863419 };

const SEARCH_RADIUS_METRES = 800;
const MAX_PLACES = 10;
const FORECAST_AREA = "Kallang";
const TOOL_TIMEOUT_MS = 8_000;
const MAX_PHOTOS = 3;
const PHOTO_WIDTH_PX = 480;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_MEDIA_URL = "https://places.googleapis.com/v1/";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        "Search for places to eat near CT Hub 2. Returns name, rating, distance and whether it is open now.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "chicken rice", "japanese", "cheap lunch".',
          },
          open_now: {
            type: "boolean",
            description: "Only return places that are open right now.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the two-hour weather forecast for the Kallang area, which covers CT Hub 2.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_arrivals",
      description:
        "Get the next bus arrivals at a Singapore bus stop, by five-digit stop code.",
      parameters: {
        type: "object",
        properties: {
          stop_code: {
            type: "string",
            description: 'Five-digit bus stop code, e.g. "07371".',
          },
        },
        required: ["stop_code"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one tool call requested by the model and return the result as a string.
 *
 * Photo references from place searches are collected into photos, keyed by
 * place name, so the loop can attach images to the final reply without
 * sending long photo ids to the model.
 */
export async function executeTool(name, args, env, photos = new Map()) {
  try {
    switch (name) {
      case "find_lunch_places": {
        const { photos: found = [], ...result } = await findLunchPlaces(args, env);
        for (const photo of found) {
          photos.set(photo.name, photo);
        }
        return JSON.stringify(result);
      }
      case "get_rain_forecast":
        return JSON.stringify(await getRainForecast());
      case "get_bus_arrivals":
        return JSON.stringify(await getBusArrivals(args));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    // Let the model carry on without this tool instead of failing the turn.
    console.error(`tool ${name} failed:`, err);
    return JSON.stringify({ error: `${name} is not available right now` });
  }
}

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

async function findLunchPlaces({ query, open_now = false }, env) {
  const centre = CT_HUB_2;

  const body = {
    textQuery: query,
    includedType: "restaurant",
    openNow: open_now,
    pageSize: MAX_PLACES,
    locationBias: {
      circle: { center: centre, radius: SEARCH_RADIUS_METRES },
    },
  };

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.rating,places.currentOpeningHours,places.photos",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { error: `Places API returned ${res.status}` };
  }

  const data = await res.json();
  return {
    places: formatPlaces(data.places ?? [], centre),
    photos: formatPlacePhotos(data.places ?? []),
  };
}

/**
 * Shape Places API results into the fields Uncle needs.
 */
export function formatPlaces(places, origin) {
  return places.map(({ displayName, rating, location, currentOpeningHours }) => ({
    name: displayName?.text ?? "Unnamed",
    rating: rating ?? null,
    distance_m: Math.round(haversineMetres(origin, location)),
    // null when Google has no opening hours for the place.
    open_now: currentOpeningHours?.openNow ?? null,
  }));
}

/**
 * Take the first photo of each place, with the credit Google requires us to show.
 */
export function formatPlacePhotos(places) {
  return places
    .filter((p) => p.photos?.[0]?.name)
    .map(({ displayName, photos: [photo] }) => {
      const author = photo.authorAttributions?.[0];
      return {
        name: displayName?.text ?? "Unnamed",
        ref: photo.name,
        author: author?.displayName ?? null,
        author_uri: author?.uri ?? null,
      };
    });
}

/**
 * Pick the photos for places that the reply actually names, in reply order.
 *
 * Uncle often shortens names, e.g. "Hwa Heng" for "Hwa Heng Beef Noodle" or
 * "Blanco Court Beef Noodles" for "Blanco Court Beef Noodles Aperia Mall",
 * so the first two or more words of a name also count as a match. When two
 * places match at the same spot, such as two branches, the longer match wins.
 */
export function pickSuggestedPhotos(reply, photos, max = MAX_PHOTOS) {
  const text = reply.toLowerCase();
  const byPosition = new Map();
  for (const photo of photos.values()) {
    const match = findName(text, photo.name.toLowerCase());
    if (!match) continue;
    const best = byPosition.get(match.position);
    if (!best || match.length > best.length) {
      byPosition.set(match.position, { ...match, photo });
    }
  }
  return [...byPosition.values()]
    .sort((a, b) => a.position - b.position)
    .slice(0, max)
    .map(({ photo }) => photo);
}

// Find the longest leading part of a place name that appears in text as
// whole words. Branch details after "@", "(", "|" or " - " are ignored.
function findName(text, name) {
  const core = name.split(/\s*[@|(（]|\s[-–]\s/)[0].trim();
  const words = core.split(/\s+/).filter(Boolean);
  const shortest = words.length === 1 ? 1 : 2;
  for (let n = words.length; n >= shortest; n--) {
    const phrase = words.slice(0, n).join(" ");
    if (phrase.length < 4) break;
    const position = indexOfWords(text, phrase);
    if (position >= 0) return { position, length: phrase.length };
  }
  return null;
}

function indexOfWords(text, phrase) {
  const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  let at = text.indexOf(phrase);
  while (at >= 0) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + phrase.length])) {
      return at;
    }
    at = text.indexOf(phrase, at + 1);
  }
  return -1;
}

/**
 * Turn picked photos into public image URLs the browser can load.
 *
 * Google's media endpoint needs the API key, so the Worker asks it for the
 * final image URL instead of sending the key to the browser.
 */
export async function getPhotoUrls(photos, env) {
  const results = await Promise.all(
    photos.map(async (photo) => {
      try {
        const url =
          `${PLACES_MEDIA_URL}${photo.ref}/media` +
          `?maxWidthPx=${PHOTO_WIDTH_PX}&skipHttpRedirect=true`;
        const res = await fetch(url, {
          headers: { "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY },
          signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.error(`photo for ${photo.name} returned ${res.status}`);
          return null;
        }
        const { photoUri } = await res.json();
        return photoUri ? formatImage(photo, photoUri) : null;
      } catch (err) {
        console.error(`photo for ${photo.name} failed:`, err);
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}

/**
 * Shape one image for the chat page.
 */
export function formatImage(photo, url) {
  return {
    name: photo.name,
    url,
    author: photo.author,
    author_uri: photo.author_uri,
  };
}

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

async function getRainForecast() {
  const res = await fetch(FORECAST_URL, {
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!res.ok) {
    return { error: `Forecast API returned ${res.status}` };
  }
  return formatForecast(await res.json(), FORECAST_AREA);
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 */
export function formatForecast(payload, area) {
  const item = payload?.data?.items?.[0];
  if (!item) {
    return { error: "No forecast available" };
  }
  const entry = item.forecasts.find((f) => f.area === area);
  return {
    area,
    forecast: entry?.forecast ?? "Unknown",
    valid_period: item.valid_period?.text ?? null,
  };
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

async function getBusArrivals({ stop_code }) {
  const url = `${BUS_URL}?id=${encodeURIComponent(stop_code)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  if (!res.ok) {
    return { error: `Bus API returned ${res.status}` };
  }
  return formatBusArrivals(await res.json(), stop_code);
}

/**
 * Reduce an arrivelah response to service numbers and minutes to arrival.
 */
export function formatBusArrivals(payload, stopCode) {
  const services = payload?.services ?? [];
  return {
    stop_code: stopCode,
    services: services.map((s) => ({
      service: s.no,
      next_min: minutesFromNow(s.next),
      subsequent_min: minutesFromNow(s.subsequent),
    })),
  };
}

function minutesFromNow(arrival) {
  if (!arrival || typeof arrival.duration_ms !== "number") {
    return null;
  }
  return Math.max(0, Math.round(arrival.duration_ms / 60000));
}
