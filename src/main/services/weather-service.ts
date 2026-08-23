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
import type { AgentRuntime } from '../agent/agent-runtime'
import type { ActivityService } from './activity-service'
import type { WeatherData, WeatherBriefing } from '@shared/types'

export interface WeatherServiceDeps {
  settings: Settings
  agentRuntime: AgentRuntime
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

  /** Fetch real weather + generate (LLM or stub) the polished briefing, cache
   *  it, and return it. Returns undefined on a fetch/generation failure (the
   *  Home card then shows the empty state). */
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
    let briefing: WeatherBriefing
    try {
      const out = (await this.deps.agentRuntime.runAgentStep('generate_daily_weather', {
        weather
      })) as { tempText: string; summary: string; clothing: string; yi: string[]; ji: string[] }
      briefing = {
        date: new Date().toISOString().slice(0, 10),
        city,
        tempText: out.tempText,
        summary: out.summary,
        clothing: out.clothing,
        yi: out.yi,
        ji: out.ji
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.activityService.record({
        type: 'agent_failed',
        summary: `天气简报生成失败：${message}`,
        metadata: { error: message, city }
      })
      return undefined
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
