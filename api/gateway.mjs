// Send large requests directly to the current media origin after discovery.
// Only the project's own discovery function can choose this destination.
export default async function gateway(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const route = String(req.query.route || '').split('?')[0];
  if (!/^(?:api\/v1(?:\/[\w.-]+)*|health|ready|openapi\.yaml)$/.test(route) || route.split('/').some(p => p === '..' || p === '.')) {
    return res.status(404).json({error:{code:'ROUTE_NOT_FOUND',message:'Unknown API route.',retryable:false,details:{}}});
  }
  try {
    const canonical = process.env.EDITMIND_PUBLIC_ORIGIN ||
      ('https://' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL));
    const service = await fetch(new URL('/api/backend',canonical),{signal:AbortSignal.timeout(160000)});
    if (!service.ok) throw new Error('Worker discovery failed');
    const {origin} = await service.json();
    const worker = new URL(origin);
    if (worker.protocol !== 'https:' || !worker.hostname.endsWith('.vercel.run')) throw new Error('Invalid worker origin');
    if (route === 'api/v1/endpoint') return res.json({origin:worker.origin});
    const dest = new URL('/' + route, worker.origin);
    for (const [key,value] of Object.entries(req.query)) {
      if (key === 'route') continue;
      for (const v of [].concat(value)) dest.searchParams.append(key,v);
    }
    return res.redirect(307,dest.href);
  } catch {
    return res.status(503).json({error:{code:'WORKER_UNAVAILABLE',message:'The media worker is starting. Retry shortly.',retryable:true,details:{}}});
  }
}
