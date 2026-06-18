import { flex, type LineMessage } from "./client";

export type WeatherResult = {
  ok: true;
  place: string;
  current: {
    tempC: number | null;
    feelsLikeC: number | null;
    description: string;
    humidityPct: number | null;
    windKmh: number | null;
    windDir: string | null;
  } | null;
  forecast: Array<{
    date?: string | null;
    highC: number | null;
    lowC: number | null;
    condition: string | null;
    rainChancePct: number | null;
  }>;
  source: string;
};

export function buildWeatherFlex(result: WeatherResult): LineMessage {
  const cur = result.current;
  const condDesc = cur?.description ?? "";
  const bg = headerBg(condDesc);
  const tempText = cur?.tempC != null ? `${Math.round(cur.tempC)}°C` : "—";

  const detailParts: string[] = [];
  if (cur?.feelsLikeC != null) detailParts.push(`Feels ${Math.round(cur.feelsLikeC)}°C`);
  if (cur?.humidityPct != null) detailParts.push(`💧 ${cur.humidityPct}%`);
  if (cur?.windKmh != null) {
    const dir = cur.windDir ? `${cur.windDir} ` : "";
    detailParts.push(`💨 ${dir}${Math.round(cur.windKmh)} km/h`);
  }

  const headerContents: unknown[] = [
    { type: "text", text: `📍 ${result.place}`, size: "sm", color: "#ffffffBB", wrap: true },
    { type: "text", text: tempText, size: "4xl", weight: "bold", color: "#ffffff" },
    {
      type: "text",
      text: `${conditionEmoji(condDesc)}  ${condDesc}`,
      size: "sm",
      color: "#ffffffCC",
      margin: "xs",
    },
  ];
  if (detailParts.length > 0) {
    headerContents.push({
      type: "text",
      text: detailParts.join("  ·  "),
      size: "xs",
      color: "#ffffff99",
      margin: "sm",
      wrap: true,
    });
  }

  const forecastRows: unknown[] = [];
  result.forecast.slice(0, 3).forEach((f, i) => {
    if (i > 0) forecastRows.push({ type: "separator", color: "#eeeeee" });
    const high = f.highC != null ? `${Math.round(f.highC)}°` : "—";
    const low = f.lowC != null ? `${Math.round(f.lowC)}°` : "—";
    forecastRows.push({
      type: "box",
      layout: "horizontal",
      paddingTop: "6px",
      paddingBottom: "6px",
      contents: [
        { type: "text", text: f.date ? fmtDate(f.date) : "—", size: "sm", flex: 3, color: "#555555" },
        {
          type: "text",
          text: conditionEmoji(f.condition ?? ""),
          size: "sm",
          flex: 1,
          align: "center",
        },
        { type: "text", text: `${high} / ${low}`, size: "sm", flex: 3, align: "center", color: "#333333" },
        {
          type: "text",
          text: f.rainChancePct != null ? `🌧 ${f.rainChancePct}%` : "",
          size: "sm",
          flex: 2,
          align: "end",
          color: "#666666",
        },
      ],
    });
  });

  const bubble: Record<string, unknown> = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: bg,
      paddingAll: "20px",
      contents: headerContents,
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingBottom: "8px",
      paddingEnd: "16px",
      contents: [
        {
          type: "text",
          text: `source: ${result.source}`,
          size: "xxs",
          color: "#bbbbbb",
          align: "end",
        },
      ],
    },
  };

  if (forecastRows.length > 0) {
    bubble.body = {
      type: "box",
      layout: "vertical",
      paddingTop: "8px",
      paddingBottom: "4px",
      paddingStart: "16px",
      paddingEnd: "16px",
      contents: forecastRows,
    };
  }

  return flex(`${result.place}: ${tempText} ${condDesc}`, bubble);
}

function conditionEmoji(desc: string): string {
  const d = desc.toLowerCase();
  if (/thunder|storm/.test(d)) return "⛈️";
  if (/snow|blizzard|sleet/.test(d)) return "❄️";
  if (/rain|drizzle|shower/.test(d)) return "🌧️";
  if (/fog|mist|haze/.test(d)) return "🌫️";
  if (/overcast/.test(d)) return "☁️";
  if (/partly/.test(d)) return "⛅";
  if (/clear|sunny/.test(d)) return "☀️";
  return "🌤️";
}

function headerBg(desc: string): string {
  const d = desc.toLowerCase();
  if (/thunder|storm/.test(d)) return "#37474F";
  if (/snow/.test(d)) return "#455A64";
  if (/rain|drizzle|shower/.test(d)) return "#1565C0";
  if (/overcast/.test(d)) return "#546E7A";
  if (/clear|sunny/.test(d)) return "#BF360C";
  return "#1565C0";
}

function fmtDate(s: string): string {
  try {
    return new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return s;
  }
}
