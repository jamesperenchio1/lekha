import { z } from "zod";
import { tool } from "ai";

export function buildWeatherTools() {
  return {
    weather: tool({
      description:
        "Get current weather + a 3-day forecast for a place. Fast (<1s), no API key required. Use this for ANY weather question — never web_search. If no location is known, ASK the user before calling.",
      inputSchema: z.object({
        location: z
          .string()
          .min(1)
          .max(120)
          .describe("City, address, or coords. e.g. 'Bangkok', 'Tokyo', 'San Francisco', '13.7563,100.5018'"),
      }),
      execute: async ({ location }) => {
        const result = await tryWttr(location) ?? await tryOpenMeteo(location);
        if (!result) return { ok: false, error: "Both weather providers failed. Try again in a moment." };
        return result;
      },
    }),
  };
}

async function fetchJSON<T>(url: string, timeoutMs = 4000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "lekha-bot" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function tryWttr(location: string) {
  const t0 = Date.now();
  try {
    const data = await fetchJSON<{
      current_condition?: Array<{
        temp_C?: string; temp_F?: string; FeelsLikeC?: string;
        weatherDesc?: Array<{ value?: string }>; humidity?: string;
        windspeedKmph?: string; winddir16Point?: string;
      }>;
      nearest_area?: Array<{
        areaName?: Array<{ value?: string }>; country?: Array<{ value?: string }>;
        region?: Array<{ value?: string }>;
      }>;
      weather?: Array<{
        date?: string; maxtempC?: string; mintempC?: string;
        hourly?: Array<{ chanceofrain?: string; weatherDesc?: Array<{ value?: string }>; time?: string }>;
      }>;
    }>(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
    console.log("[weather] wttr.in", { location, ms: Date.now() - t0 });
    const cur = data.current_condition?.[0];
    const area = data.nearest_area?.[0];
    const place = [area?.areaName?.[0]?.value, area?.region?.[0]?.value, area?.country?.[0]?.value]
      .filter(Boolean).join(", ") || location;
    return {
      ok: true,
      place,
      current: cur ? {
        tempC: cur.temp_C ? Number(cur.temp_C) : null,
        tempF: cur.temp_F ? Number(cur.temp_F) : null,
        feelsLikeC: cur.FeelsLikeC ? Number(cur.FeelsLikeC) : null,
        description: cur.weatherDesc?.[0]?.value ?? "",
        humidityPct: cur.humidity ? Number(cur.humidity) : null,
        windKmh: cur.windspeedKmph ? Number(cur.windspeedKmph) : null,
        windDir: cur.winddir16Point ?? null,
      } : null,
      forecast: data.weather?.slice(0, 3).map((d) => ({
        date: d.date,
        highC: d.maxtempC ? Number(d.maxtempC) : null,
        lowC: d.mintempC ? Number(d.mintempC) : null,
        condition: d.hourly?.[4]?.weatherDesc?.[0]?.value ?? null,
        rainChancePct: d.hourly?.[4]?.chanceofrain ? Number(d.hourly[4]!.chanceofrain) : null,
      })) ?? [],
      source: "wttr.in",
    };
  } catch {
    console.warn("[weather] wttr.in failed", { location, ms: Date.now() - t0 });
    return null;
  }
}

async function tryOpenMeteo(location: string) {
  const t0 = Date.now();
  try {
    // Geocode city name → lat/lon
    const geo = await fetchJSON<{ results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> }>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
    );
    const place = geo.results?.[0];
    if (!place) return null;
    const { latitude: lat, longitude: lon, name, country } = place;

    const wx = await fetchJSON<{
      current?: { temperature_2m?: number; relative_humidity_2m?: number; wind_speed_10m?: number; weather_code?: number };
      daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[]; weather_code?: number[] };
    }>(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&forecast_days=3&timezone=auto`,
    );
    console.log("[weather] open-meteo fallback", { location, ms: Date.now() - t0 });
    const cur = wx.current;
    const daily = wx.daily;
    return {
      ok: true,
      place: [name, country].filter(Boolean).join(", "),
      current: cur ? {
        tempC: cur.temperature_2m ?? null,
        tempF: cur.temperature_2m != null ? Math.round(cur.temperature_2m * 9 / 5 + 32) : null,
        feelsLikeC: null,
        description: wmoDesc(cur.weather_code),
        humidityPct: cur.relative_humidity_2m ?? null,
        windKmh: cur.wind_speed_10m ?? null,
        windDir: null,
      } : null,
      forecast: (daily?.time ?? []).slice(0, 3).map((date, i) => ({
        date,
        highC: daily?.temperature_2m_max?.[i] ?? null,
        lowC: daily?.temperature_2m_min?.[i] ?? null,
        condition: wmoDesc(daily?.weather_code?.[i]),
        rainChancePct: daily?.precipitation_probability_max?.[i] ?? null,
      })),
      source: "Open-Meteo",
    };
  } catch {
    console.warn("[weather] open-meteo failed", { location, ms: Date.now() - t0 });
    return null;
  }
}

function wmoDesc(code: number | null | undefined): string {
  if (code == null) return "";
  if (code === 0) return "Clear sky";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 49) return "Foggy";
  if (code <= 59) return "Drizzle";
  if (code <= 69) return "Rain";
  if (code <= 79) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  if (code <= 99) return "Thunderstorm";
  return "Unknown";
}
