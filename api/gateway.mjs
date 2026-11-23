// Share discovery across requests handled by a warm function instance.
let recent;
let discovering;
async function getWorker() {
  if(recent && Date.now()<recent.until) return recent.origin;
  discovering ??= (async()=>{
    const canonical=process.env.EDITMIND_PUBLIC_ORIGIN ||
      ('https://' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL));
    const response=await fetch(new URL('/api/backend',canonical),{signal:AbortSignal.timeout(160000)});
    if(!response.ok) throw new Error('Worker discovery failed');
    const worker=new URL((await response.json()).origin);
    if(worker.protocol!=='https:' || !worker.hostname.endsWith('.vercel.run')) throw new Error('Invalid worker origin');
    recent={origin:worker.origin,until:Date.now()+15000};
    return worker.origin;
  })().finally(()=>{discovering=undefined;});
  return discovering;
}

export default async function gateway(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const route = String(req.query.route || '').split('?')[0];
  if (!/^(?:api\/v1(?:\/[\w.-]+)*|health|ready|openapi\.yaml)$/.test(route) || route.split('/').some(p => p === '..' || p === '.')) {
    return res.status(404).json({error:{code:'ROUTE_NOT_FOUND',message:'Unknown API route.',retryable:false,details:{}}});
  }
  try {
    const origin=await getWorker();
    if (route === 'api/v1/endpoint') return res.json({origin});
    const dest = new URL('/' + route, origin);
    for (const [key,value] of Object.entries(req.query)) {
      if (key === 'route') continue;
      for (const v of [].concat(value)) dest.searchParams.append(key,v);
    }
    return res.redirect(307,dest.href);
  } catch {
    return res.status(503).json({error:{code:'WORKER_UNAVAILABLE',message:'The media worker is starting. Retry shortly.',retryable:true,details:{}}});
  }
}
