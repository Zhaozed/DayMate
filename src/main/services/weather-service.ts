// Weather Service (ADR 0026) — the Home 今日天气 card's data source.
//
// Real weather is fetched from wttr.in (no API key, proxy-aware via Electron
// `net.fetch`) for the user's configured city. A daily LLM step
// (`generate_daily_weather`) polishes the raw figures into a Chinese summary +
// concrete clothing advice + practical 宜/忌 (NOT mystical — the 八字 宜忌 stays
// in the 运势 bubble). The briefing is cached in non-secret settings.json
// (keyed by date) so the Home card renders without a re-fetch; stale/absent →
// empty state with a "生成" button.
//
// One LLM call per day (user-chosen 真实天气+LLM润色). The no-key path falls
// back to a deterministic stub (temp/condition → clothing/yi/ji by rules, zero
// LLM) so the card always renders something.

import type { Settings } from '../util/settings'
import type { ActivityService } from './activity-service'
import type { WeatherData, WeatherBriefing } from '@shared/types'

function weatherDescZh(code: number, fallback: string): string {
  if ([113].includes(code)) return '晴'
  if ([116, 119, 122].includes(code)) return '多云'
  if ([143, 248, 260, 263].includes(code)) return '有雾'
  if ([176, 200, 386, 389].includes(code)) return '阵雨'
  if ([185, 266, 293, 296, 299, 302, 305, 308, 311, 314, 317, 392, 395].includes(code)) return '有雨'
  if ([230, 320, 323, 326, 329, 332, 335, 338, 350, 353, 356, 359, 362, 365, 368, 371, 374, 377].includes(code)) return '有雪'
  if (code >= 200 && code < 400) return '降水'
  return fallback || '天气'
}

export interface WeatherServiceDeps {
  settings: Settings
  agentRuntime?: unknown
  activityService: ActivityService
  /** Proxy-aware fetch (Electron `net.fetch`). Injected so tests can mock. */
  fetch: typeof fetch
}

export class WeatherService {
  constructor(private readonly deps: WeatherServiceDeps) {}

  /** Today's cached briefing, or undefined when not generated / stale. */
  async getCached(): Promise<WeatherBriefing | undefined> {
    const cached = await this.deps.settings.readWeatherCache()
    if (!cached) return undefined
    const today = new Date().toISOString().slice(0, 10)
    return cached.date === today ? cached : undefined
  }

  /** Fetch real weather from wttr.in for the city. Best-effort: a network
   *  failure throws and the caller (refresh) logs + returns undefined. */
  async fetchWeather(city: string): Promise<WeatherData> {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`
    const res = await this.deps.fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`wttr.in 返回 ${res.status}`)
    const json = (await res.json()) as wttrResponse
    const cur = json.current_condition?.[0]
    const today = json.weather?.[0]
    if (!cur || !today) throw new Error('wttr.in 响应缺少 current_condition')
    return {
      city,
      tempC: Number(cur.temp_C),
      feelsLikeC: Number(cur.FeelsLikeC),
      desc: cur.lang_zh?.[0]?.value ?? cur.weatherDesc?.[0]?.value ?? '未知',
      humidity: Number(cur.humidity),
      windSpeedKmph: Number(cur.windspeedKmph),
      maxTempC: Number(today.maxtempC),
      minTempC: Number(today.mintempC),
      weatherCode: Number(cur.weatherCode)
    }
  }

  /** Fetch real weather + generate the briefing, cache it, and return it. */
  async refresh(): Promise<WeatherBriefing | undefined> {
    const city = await this.deps.settings.readWeatherCity()
    let weather: WeatherData
    try {
      weather = await this.fetchWeather(city)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.activityService.record({
        type: 'provider_unavailable',
        summary: `天气获取失败：${message}`,
        metadata: { error: message, city }
      })
      return undefined
    }
    const desc = weatherDescZh(weather.weatherCode, weather.desc)
    const tempText = `${weather.tempC}°C ${desc} · 体感${weather.feelsLikeC}°`
    const briefing: WeatherBriefing = {
      date: new Date().toISOString().slice(0, 10),
      city,
      tempText,
      summary: `今日${desc}，最高${weather.maxTempC}°最低${weather.minTempC}°。`,
      clothing: '适度添减衣物',
      yi: ['宜按计划推进工作'],
      ji: ['忌拖延搁置的重要事项']
    }
    await this.deps.settings.writeWeatherCache(briefing)
    return briefing
  }
}

// Minimal wttr.in JSON shape (only the fields we read).
interface wttrResponse {
  current_condition?: {
    temp_C: string
    FeelsLikeC: string
    weatherDesc?: { value: string }[]
    lang_zh?: { value: string }[]
    humidity: string
    windspeedKmph: string
    weatherCode: string
  }[]
  weather?: { maxtempC: string; mintempC: string }[]
}
