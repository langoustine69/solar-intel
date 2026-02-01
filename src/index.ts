import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';

const agent = await createAgent({
  name: 'solar-intel',
  version: '1.0.0',
  description: 'Solar energy intelligence for AI agents - PV estimation, solar resource data, radiation forecasts, and optimal tilt calculations',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === CONFIG ===
const NREL_API_KEY = process.env.NREL_API_KEY || 'DEMO_KEY';

// === HELPER FUNCTIONS ===
async function fetchJSON(url: string, timeout = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
  } catch (e: any) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// Calculate optimal tilt based on latitude (rule of thumb: lat - 15 to lat + 15 depending on season)
function calculateOptimalTilt(lat: number): { annual: number; summer: number; winter: number } {
  const absLat = Math.abs(lat);
  return {
    annual: Math.round(absLat * 0.9),  // Good year-round compromise
    summer: Math.round(absLat - 15),    // Lower tilt for summer sun
    winter: Math.round(absLat + 15),    // Higher tilt for winter sun
  };
}

// === SERVE ICON ===
app.get('/icon.png', (c) => {
  const iconPath = './icon.png';
  if (existsSync(iconPath)) {
    const icon = readFileSync(iconPath);
    return new Response(icon, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }
    });
  }
  return new Response('Icon not found', { status: 404 });
});

// === ERC-8004 REGISTRATION ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.BASE_URL || 'https://solar-intel-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "solar-intel",
    description: "Solar energy intelligence for AI agents. 1 free + 5 paid endpoints. PV estimation, solar resource data, radiation forecasts, optimal tilt calculations. Data from NREL and Open-Meteo.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

// === FREE ENDPOINT - Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free solar potential overview for any location - quick check before deeper analysis',
  input: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude'),
    lon: z.number().min(-180).max(180).describe('Longitude'),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const { lat, lon } = ctx.input;
    
    // Get solar resource from NREL
    const resource = await fetchJSON(
      `https://developer.nrel.gov/api/solar/solar_resource/v1.json?api_key=${NREL_API_KEY}&lat=${lat}&lon=${lon}`
    );
    
    const avgGHI = resource.outputs?.avg_ghi?.annual || 0;
    const avgDNI = resource.outputs?.avg_dni?.annual || 0;
    
    // Categorize solar potential
    let rating: string;
    if (avgGHI >= 5.5) rating = 'Excellent';
    else if (avgGHI >= 4.5) rating = 'Good';
    else if (avgGHI >= 3.5) rating = 'Moderate';
    else rating = 'Low';
    
    return {
      output: {
        location: { lat, lon },
        solarPotential: rating,
        avgGHI_kWhPerM2PerDay: avgGHI,
        avgDNI_kWhPerM2PerDay: avgDNI,
        optimalTilt: calculateOptimalTilt(lat),
        fetchedAt: new Date().toISOString(),
        dataSource: 'NREL Solar Resource (live)'
      }
    };
  },
});

// === PAID ENDPOINT 1 ($0.002) - PV System Estimation ===
addEntrypoint({
  key: 'pv-estimate',
  description: 'Estimate annual solar panel output using NREL PVWatts - capacity, tilt, azimuth configurable',
  input: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude'),
    lon: z.number().min(-180).max(180).describe('Longitude'),
    systemCapacity: z.number().min(0.05).max(500000).default(4).describe('System capacity in kW'),
    tilt: z.number().min(0).max(90).optional().describe('Panel tilt angle (degrees, default: latitude)'),
    azimuth: z.number().min(0).max(360).default(180).describe('Panel azimuth (180=south for northern hemisphere)'),
    moduleType: z.enum(['standard', 'premium', 'thinfilm']).default('standard').describe('Module type'),
    losses: z.number().min(0).max(99).default(14).describe('System losses percentage'),
  }),
  price: { amount: 2000 }, // $0.002
  handler: async (ctx) => {
    const { lat, lon, systemCapacity, azimuth, moduleType, losses } = ctx.input;
    const tilt = ctx.input.tilt ?? Math.abs(lat);
    
    // Map module type to NREL code
    const moduleTypeCode = { standard: 0, premium: 1, thinfilm: 2 }[moduleType];
    
    const url = `https://developer.nrel.gov/api/pvwatts/v8.json?api_key=${NREL_API_KEY}` +
      `&system_capacity=${systemCapacity}&azimuth=${azimuth}&tilt=${tilt}` +
      `&array_type=1&module_type=${moduleTypeCode}&losses=${losses}&lat=${lat}&lon=${lon}`;
    
    const data = await fetchJSON(url);
    
    return {
      output: {
        location: { lat, lon },
        systemConfig: {
          capacityKW: systemCapacity,
          tiltDegrees: tilt,
          azimuthDegrees: azimuth,
          moduleType,
          lossesPercent: losses,
        },
        annualOutput: {
          acKWh: Math.round(data.outputs.ac_annual),
          capacityFactor: Math.round(data.outputs.capacity_factor * 100) / 100,
          solarRadiation_kWhPerM2PerDay: Math.round(data.outputs.solrad_annual * 100) / 100,
        },
        monthlyOutput_kWh: data.outputs.ac_monthly.map((v: number) => Math.round(v)),
        monthlySolarRadiation: data.outputs.solrad_monthly.map((v: number) => Math.round(v * 100) / 100),
        fetchedAt: new Date().toISOString(),
        dataSource: 'NREL PVWatts v8 (live)'
      }
    };
  },
});

// === PAID ENDPOINT 2 ($0.001) - Solar Resource Data ===
addEntrypoint({
  key: 'solar-resource',
  description: 'Detailed solar resource data - DNI, GHI, and latitude-tilt irradiance by month',
  input: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude'),
    lon: z.number().min(-180).max(180).describe('Longitude'),
  }),
  price: { amount: 1000 }, // $0.001
  handler: async (ctx) => {
    const { lat, lon } = ctx.input;
    
    const resource = await fetchJSON(
      `https://developer.nrel.gov/api/solar/solar_resource/v1.json?api_key=${NREL_API_KEY}&lat=${lat}&lon=${lon}`
    );
    
    return {
      output: {
        location: { lat, lon },
        directNormalIrradiance: {
          annual_kWhPerM2PerDay: resource.outputs.avg_dni.annual,
          monthly: resource.outputs.avg_dni.monthly,
        },
        globalHorizontalIrradiance: {
          annual_kWhPerM2PerDay: resource.outputs.avg_ghi.annual,
          monthly: resource.outputs.avg_ghi.monthly,
        },
        latitudeTiltIrradiance: {
          annual_kWhPerM2PerDay: resource.outputs.avg_lat_tilt.annual,
          monthly: resource.outputs.avg_lat_tilt.monthly,
        },
        fetchedAt: new Date().toISOString(),
        dataSource: 'NREL Solar Resource (live)'
      }
    };
  },
});

// === PAID ENDPOINT 3 ($0.002) - Radiation Forecast ===
addEntrypoint({
  key: 'radiation-forecast',
  description: '7-day solar radiation forecast with hourly resolution - direct, diffuse, shortwave',
  input: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude'),
    lon: z.number().min(-180).max(180).describe('Longitude'),
    forecastDays: z.number().min(1).max(16).default(7).describe('Days to forecast (1-16)'),
  }),
  price: { amount: 2000 }, // $0.002
  handler: async (ctx) => {
    const { lat, lon, forecastDays } = ctx.input;
    
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=direct_radiation,diffuse_radiation,direct_normal_irradiance,shortwave_radiation` +
      `&daily=sunshine_duration&forecast_days=${forecastDays}&timezone=auto`;
    
    const data = await fetchJSON(url);
    
    // Aggregate daily stats from hourly data
    const hourlyTimes = data.hourly.time;
    const shortwave = data.hourly.shortwave_radiation;
    
    const dailyStats: any[] = [];
    for (let day = 0; day < forecastDays; day++) {
      const dayStart = day * 24;
      const dayEnd = dayStart + 24;
      const dayShortwave = shortwave.slice(dayStart, dayEnd).filter((v: number | null) => v !== null);
      
      if (dayShortwave.length > 0) {
        dailyStats.push({
          date: data.daily.time[day],
          peakRadiation_Wm2: Math.max(...dayShortwave),
          avgRadiation_Wm2: Math.round(dayShortwave.reduce((a: number, b: number) => a + b, 0) / dayShortwave.length),
          sunshineDuration_hours: Math.round(data.daily.sunshine_duration[day] / 3600 * 10) / 10,
        });
      }
    }
    
    return {
      output: {
        location: { lat, lon },
        timezone: data.timezone,
        forecastDays,
        dailySummary: dailyStats,
        hourlyData: {
          times: data.hourly.time,
          directRadiation_Wm2: data.hourly.direct_radiation,
          diffuseRadiation_Wm2: data.hourly.diffuse_radiation,
          directNormalIrradiance_Wm2: data.hourly.direct_normal_irradiance,
          shortwaveRadiation_Wm2: data.hourly.shortwave_radiation,
        },
        fetchedAt: new Date().toISOString(),
        dataSource: 'Open-Meteo (live)'
      }
    };
  },
});

// === PAID ENDPOINT 4 ($0.002) - Optimal Tilt Calculator ===
addEntrypoint({
  key: 'optimal-tilt',
  description: 'Calculate optimal panel tilt and azimuth for maximum annual output',
  input: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude'),
    lon: z.number().min(-180).max(180).describe('Longitude'),
    systemCapacity: z.number().min(0.05).max(500000).default(4).describe('System capacity in kW'),
  }),
  price: { amount: 2000 }, // $0.002
  handler: async (ctx) => {
    const { lat, lon, systemCapacity } = ctx.input;
    
    // Calculate theoretical optimal tilts
    const theoretical = calculateOptimalTilt(lat);
    
    // Test a few tilt angles with PVWatts to find actual optimal
    const tiltsToTest = [
      Math.max(0, theoretical.annual - 10),
      theoretical.annual,
      Math.min(90, theoretical.annual + 10),
    ];
    
    // Southern hemisphere: face north (azimuth 0), Northern: face south (azimuth 180)
    const optimalAzimuth = lat >= 0 ? 180 : 0;
    
    const results = await Promise.all(
      tiltsToTest.map(async (tilt) => {
        const url = `https://developer.nrel.gov/api/pvwatts/v8.json?api_key=${NREL_API_KEY}` +
          `&system_capacity=${systemCapacity}&azimuth=${optimalAzimuth}&tilt=${tilt}` +
          `&array_type=1&module_type=0&losses=14&lat=${lat}&lon=${lon}`;
        const data = await fetchJSON(url);
        return { tilt, output: data.outputs.ac_annual };
      })
    );
    
    // Find the best performing tilt
    const best = results.reduce((a, b) => a.output > b.output ? a : b);
    
    return {
      output: {
        location: { lat, lon },
        systemCapacityKW: systemCapacity,
        optimalConfig: {
          tiltDegrees: best.tilt,
          azimuthDegrees: optimalAzimuth,
          azimuthDirection: lat >= 0 ? 'South' : 'North',
          estimatedAnnualOutput_kWh: Math.round(best.output),
        },
        seasonalTilts: {
          summer: theoretical.summer,
          winter: theoretical.winter,
          yearRound: theoretical.annual,
        },
        tiltComparison: results.map(r => ({
          tiltDegrees: r.tilt,
          annualOutput_kWh: Math.round(r.output),
        })),
        fetchedAt: new Date().toISOString(),
        dataSource: 'NREL PVWatts v8 (live)'
      }
    };
  },
});

// === PAID ENDPOINT 5 ($0.003) - Compare Locations ===
addEntrypoint({
  key: 'compare-locations',
  description: 'Compare solar potential across multiple locations for site selection',
  input: z.object({
    locations: z.array(z.object({
      name: z.string().optional(),
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    })).min(2).max(5).describe('Locations to compare (2-5)'),
    systemCapacity: z.number().min(0.05).max(500000).default(4).describe('System capacity in kW'),
  }),
  price: { amount: 3000 }, // $0.003
  handler: async (ctx) => {
    const { locations, systemCapacity } = ctx.input;
    
    const results = await Promise.all(
      locations.map(async (loc, idx) => {
        const tilt = Math.abs(loc.lat);
        const azimuth = loc.lat >= 0 ? 180 : 0;
        
        const [pvData, resourceData] = await Promise.all([
          fetchJSON(
            `https://developer.nrel.gov/api/pvwatts/v8.json?api_key=${NREL_API_KEY}` +
            `&system_capacity=${systemCapacity}&azimuth=${azimuth}&tilt=${tilt}` +
            `&array_type=1&module_type=0&losses=14&lat=${loc.lat}&lon=${loc.lon}`
          ),
          fetchJSON(
            `https://developer.nrel.gov/api/solar/solar_resource/v1.json?api_key=${NREL_API_KEY}&lat=${loc.lat}&lon=${loc.lon}`
          ),
        ]);
        
        return {
          name: loc.name || `Location ${idx + 1}`,
          lat: loc.lat,
          lon: loc.lon,
          annualOutput_kWh: Math.round(pvData.outputs.ac_annual),
          capacityFactor: Math.round(pvData.outputs.capacity_factor * 100) / 100,
          avgGHI_kWhPerM2PerDay: resourceData.outputs.avg_ghi.annual,
          avgDNI_kWhPerM2PerDay: resourceData.outputs.avg_dni.annual,
        };
      })
    );
    
    // Sort by annual output descending
    const ranked = [...results].sort((a, b) => b.annualOutput_kWh - a.annualOutput_kWh);
    
    return {
      output: {
        systemCapacityKW: systemCapacity,
        rankedLocations: ranked.map((r, idx) => ({
          rank: idx + 1,
          ...r,
          vsTop: idx === 0 ? 0 : Math.round((ranked[0].annualOutput_kWh - r.annualOutput_kWh) / ranked[0].annualOutput_kWh * 100),
        })),
        bestLocation: ranked[0].name,
        outputRange: {
          min: ranked[ranked.length - 1].annualOutput_kWh,
          max: ranked[0].annualOutput_kWh,
          difference: ranked[0].annualOutput_kWh - ranked[ranked.length - 1].annualOutput_kWh,
        },
        fetchedAt: new Date().toISOString(),
        dataSource: 'NREL PVWatts + Solar Resource (live)'
      }
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return { 
      output: { 
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      } 
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`☀️ Solar Intel Agent running on port ${port}`);

export default { port, fetch: app.fetch };
