import { z } from "zod";
import { tool } from "ai";

/**
 * Free, no-auth weather via wttr.in. JSON returned in <1s.
 * Prefer this over web_search for any weather question.
 */
export function buildWeatherTools() {
  return {
    weather: tool({
      description:
        "Get current weather + a 3-day forecast for a place. Fast (<1s), no API key required. Use this for ANY weather question — never web_search.",
      inputSchema: z.object({
        location: z
          .string()
          .min(1)
          .max(120)
          .describe("City, address, or coords. e.g. 'Bangkok', 'Tokyo', 'San Francisco', '13.7563,100.5018'"),
      }),
      execute: async ({ location }) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const t0 = Date.now();
        try {
          const r = await fetch(
            `https://wttr.in/${encodeURIComponent(location)}?format=j1`,
            { signal: ctrl.signal, headers: { "user-agent": "lekha-bot" } },
          );
          if (!r.ok) return { ok: false, error: `Weather lookup failed: HTTP ${r.status}` };
          const data = (await r.json()) as {
            current_condition?: Array<{
              temp_C?: string;
              temp_F?: string;
              FeelsLikeC?: string;
              FeelsLikeF?: string;
              weatherDesc?: Array<{ value?: string }>;
              humidity?: string;
              windspeedKmph?: string;
              windspeedMiles?: string;
              winddir16Point?: string;
            }>;
            nearest_area?: Array<{
              areaName?: Array<{ value?: string }>;
              country?: Array<{ value?: string }>;
              region?: Array<{ value?: string }>;
            }>;
            weather?: Array<{
              date?: string;
              maxtempC?: string;
              mintempC?: string;
              avgtempC?: string;
              hourly?: Array<{ tempC?: string; chanceofrain?: string; weatherDesc?: Array<{ value?: string }>; time?: string }>;
            }>;
          };
          console.log("[weather]", { location, ms: Date.now() - t0 });

          const cur = data.current_condition?.[0];
          const area = data.nearest_area?.[0];
          const placeBits = [
            area?.areaName?.[0]?.value,
            area?.region?.[0]?.value,
            area?.country?.[0]?.value,
          ].filter(Boolean);
          return {
            ok: true,
            place: placeBits.join(", ") || location,
            current: cur
              ? {
                  tempC: cur.temp_C ? Number(cur.temp_C) : null,
                  tempF: cur.temp_F ? Number(cur.temp_F) : null,
                  feelsLikeC: cur.FeelsLikeC ? Number(cur.FeelsLikeC) : null,
                  description: cur.weatherDesc?.[0]?.value ?? "",
                  humidityPct: cur.humidity ? Number(cur.humidity) : null,
                  windKmh: cur.windspeedKmph ? Number(cur.windspeedKmph) : null,
                  windDir: cur.winddir16Point ?? null,
                }
              : null,
            forecast:
              data.weather?.slice(0, 3).map((d) => ({
                date: d.date,
                highC: d.maxtempC ? Number(d.maxtempC) : null,
                lowC: d.mintempC ? Number(d.mintempC) : null,
                condition: d.hourly?.[4]?.weatherDesc?.[0]?.value ?? null,
                rainChancePct: d.hourly?.[4]?.chanceofrain ? Number(d.hourly[4]!.chanceofrain) : null,
              })) ?? [],
          };
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") {
            return { ok: false, error: "Weather lookup timed out after 4s." };
          }
          return { ok: false, error: err instanceof Error ? err.message : "Lookup failed" };
        } finally {
          clearTimeout(t);
        }
      },
    }),
  };
}
