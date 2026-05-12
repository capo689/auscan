import { useState, useCallback, useEffect, useRef } from "react";

// ─── SCAN STATE — module-level so stop button can kill in-flight Claude calls ──
const SCAN_STATE = { ctrl: null, userStopped: false };

// ─── REGIONS ─────────────────────────────────────────────────────────────────
const GOLD_REGIONS = [
  { id:1,  name:"Witwatersrand Basin",  country:"South Africa",      lat:-26.27, lon:27.78,   type:"Paleoplacer",     desc:"~40% of all gold ever mined. Ancient reef-hosted in Archean sedimentary basin." },
  { id:2,  name:"Carlin Trend",         country:"Nevada, USA",        lat:40.73,  lon:-116.10, type:"Carlin-Type",     desc:"Sediment-hosted invisible gold in carbonate rocks. Arid basin-and-range terrain." },
  { id:3,  name:"Kalgoorlie Super Pit", country:"W. Australia",       lat:-30.75, lon:121.47,  type:"Orogenic Lode",   desc:"Greenstone belt gold. One of the world's largest open-pit operations." },
  { id:4,  name:"Muruntau Mine",        country:"Uzbekistan",         lat:41.52,  lon:64.57,   type:"Orogenic",        desc:"Desert-hosted orogenic gold. Massive open pit in the Kyzylkum Desert." },
  { id:5,  name:"Grasberg Complex",     country:"Indonesia",          lat:-4.05,  lon:137.11,  type:"Porphyry Cu-Au",  desc:"High-altitude tropical porphyry system with enormous gold and copper resources." },
  { id:6,  name:"Oyu Tolgoi",           country:"Mongolia",           lat:42.90,  lon:106.85,  type:"Porphyry Cu-Au",  desc:"Gobi Desert porphyry copper-gold. Major undeveloped resource." },
  { id:7,  name:"Cerro Negro",          country:"Argentina",          lat:-40.80, lon:-68.28,  type:"Epithermal",      desc:"High-grade epithermal vein system in arid Patagonian steppe." },
  { id:8,  name:"Red Lake District",    country:"Canada",             lat:51.02,  lon:-93.79,  type:"Greenstone Belt", desc:"Archean greenstone-hosted high-grade gold in the Canadian Shield." },
  { id:9,  name:"Kibali Mine",          country:"DRC",                lat:3.03,   lon:29.58,   type:"Orogenic",        desc:"Tropical orogenic gold along the Central African Kibaran orogeny." },
  { id:10, name:"Pueblo Viejo",         country:"Dominican Republic", lat:19.38,  lon:-70.41,  type:"Epithermal",      desc:"Large gold-silver deposit in altered volcanic terrain." },
];

// ─── STORAGE ─────────────────────────────────────────────────────────────────
const SK = {
  analyses:"auscan:analyses2", patterns:"auscan:patterns2", zoom:"auscan:zoom",
  savedPatterns:"auscan:saved-patterns2", targets:"auscan:targets2",
  sources:"auscan:sources", searchHistory:"auscan:search-history"
};
const ss  = async (k,v) => { try { await window.storage.set(k,JSON.stringify(v)); } catch(_){} };
const sl  = async (k,fb) => { try { const r=await window.storage.get(k); return r?JSON.parse(r.value):fb; } catch(_){ return fb; } };
const sd  = async (k)    => { try { await window.storage.delete(k); } catch(_){} };

// ─── TIMEOUTS & FETCH ────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r,ms));

// Every external fetch is wrapped — hangs abort at 8s, preventing freezes
function fetchWithTimeout(url, opts={}, ms=8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal:ctrl.signal }).finally(() => clearTimeout(timer));
}

// ─── URLS ────────────────────────────────────────────────────────────────────
const ZOOM_DELTA = {10:0.50,11:0.25,12:0.13,13:0.07,14:0.035,15:0.018,16:0.009};

function esriUrl(lat,lon,zoom=13,px=600) {
  const d=ZOOM_DELTA[zoom]??0.07;
  return `https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${lon-d},${lat-d},${lon+d},${lat+d}&bboxSR=4326&size=${px},${px}&format=png32&transparent=false&f=image`;
}
function gibsUrl(lat,lon,layer,px=512) {
  const d=0.18, dt=new Date(); dt.setDate(dt.getDate()-5);
  const date=dt.toISOString().split('T')[0];
  return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&STYLES=&FORMAT=image/jpeg&WIDTH=${px}&HEIGHT=${px}&CRS=CRS:84&BBOX=${lon-d},${lat-d},${lon+d},${lat+d}&TIME=${date}`;
}
const GIBS_SWIR = "MODIS_Terra_CorrectedReflectance_Bands721";

// ─── EXTERNAL SOURCES — all use fetchWithTimeout ──────────────────────────────
async function fetchSentinel2Thumb(lat,lon) {
  try {
    const d=0.15;
    const r = await fetchWithTimeout('https://earth-search.aws.element84.com/v1/search', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ collections:['sentinel-2-l2a'], bbox:[lon-d,lat-d,lon+d,lat+d],
        datetime:'2021-01-01/2024-12-31', limit:5, sortby:[{field:'properties.eo:cloud_cover',direction:'asc'}] })
    }, 8000);
    const data=await r.json();
    const item=data.features?.[0];
    return { url:item?.assets?.thumbnail?.href||null, date:item?.properties?.datetime?.slice(0,10)||null, cloud:item?.properties?.['eo:cloud_cover'] };
  } catch(e) { return {url:null,error:e.message}; }
}

async function fetchEMITBrowse(lat,lon,token) {
  try {
    const d=0.5, bbox=`${lon-d},${lat-d},${lon+d},${lat+d}`;
    const headers={'Accept':'application/json'};
    if(token) headers['Authorization']=`Bearer ${token}`;
    const r = await fetchWithTimeout(
      `https://cmr.earthdata.nasa.gov/search/granules.json?short_name=EMITL2BMIN&bounding_box=${bbox}&page_size=3&sort_key=-start_date`,
      {headers}, 8000
    );
    const data=await r.json();
    const entry=data.feed?.entry?.[0];
    if(!entry) return {url:null};
    const link=entry.links?.find(l=>l.rel?.includes('browse'));
    return {url:link?.href||null,title:entry.title};
  } catch(e) { return {url:null,error:e.message}; }
}

async function fetchLandsatBrowse(lat,lon,token) {
  try {
    const d=0.2, bbox=`${lon-d},${lat-d},${lon+d},${lat+d}`;
    const headers={'Accept':'application/json'};
    if(token) headers['Authorization']=`Bearer ${token}`;
    const r = await fetchWithTimeout(
      `https://cmr.earthdata.nasa.gov/search/granules.json?short_name=LANDSAT_OLI_TIRS_C2_L2&bounding_box=${bbox}&page_size=3&sort_key=-start_date`,
      {headers}, 8000
    );
    const data=await r.json();
    const entry=data.feed?.entry?.[0];
    const link=entry?.links?.find(l=>l.rel?.includes('browse'));
    return {url:link?.href||null};
  } catch(e) { return {url:null,error:e.message}; }
}

async function fetchASTERBrowse(lat,lon,token) {
  try {
    const d=0.15, bbox=`${lon-d},${lat-d},${lon+d},${lat+d}`;
    const headers={'Accept':'application/json'};
    if(token) headers['Authorization']=`Bearer ${token}`;
    const r = await fetchWithTimeout(
      `https://cmr.earthdata.nasa.gov/search/granules.json?short_name=AST_07XT&bounding_box=${bbox}&page_size=3&sort_key=-start_date`,
      {headers}, 8000
    );
    const data=await r.json();
    const entry=data.feed?.entry?.[0];
    const link=entry?.links?.find(l=>l.rel?.includes('browse'));
    return {url:link?.href||null};
  } catch(e) { return {url:null,error:e.message}; }
}

// Gather all sources with per-step progress reporting
async function gatherSources(lat,lon,zoom,token,enabledSrc,onStep) {
  const sources=[];
  onStep?.("Loading ESRI visual", 8);
  sources.push({key:'esri',label:'ESRI RGB Satellite (visible)',url:esriUrl(lat,lon,zoom)});
  if(enabledSrc.gibs) {
    onStep?.("Loading GIBS SWIR false color", 16);
    sources.push({key:'gibs',label:'MODIS SWIR/NIR false color (iron oxide + clay)',url:gibsUrl(lat,lon,GIBS_SWIR)});
  }
  onStep?.("Querying external APIs…", 24);
  const [emit,landsat,aster,s2] = await Promise.all([
    enabledSrc.emit    ? fetchEMITBrowse(lat,lon,token)    : Promise.resolve({url:null}),
    enabledSrc.landsat ? fetchLandsatBrowse(lat,lon,token) : Promise.resolve({url:null}),
    enabledSrc.aster   ? fetchASTERBrowse(lat,lon,token)   : Promise.resolve({url:null}),
    enabledSrc.sentinel? fetchSentinel2Thumb(lat,lon)      : Promise.resolve({url:null}),
  ]);
  if(emit.url)    sources.push({key:'emit',    label:'NASA EMIT L2B mineral identification (hyperspectral)',url:emit.url});
  if(landsat.url) sources.push({key:'landsat', label:'Landsat OLI-TIRS C2 browse (multispectral)',url:landsat.url});
  if(aster.url)   sources.push({key:'aster',   label:'ASTER surface reflectance (14-band thermal/SWIR)',url:aster.url});
  if(s2.url)      sources.push({key:'sentinel',label:`Sentinel-2 L2A (${s2.cloud?.toFixed(0)||'?'}% cloud, ${s2.date||'recent'})`,url:s2.url});
  onStep?.(`${sources.length} source${sources.length!==1?'s':''} loaded — starting Claude Vision`, 38);
  return sources;
}

// ─── RETRY ENGINE ────────────────────────────────────────────────────────────
async function withRetry(fn,{attempts=3,baseDelay=4000,onAttempt}={}) {
  for(let i=0;i<attempts;i++) {
    try { return {ok:true,data:await fn()}; }
    catch(e) {
      if(e.noRetry) return {ok:false,error:e.message,aborted:true}; // don't retry manual stops
      if(i<attempts-1) { onAttempt?.(i+1,e.message); await sleep(baseDelay*Math.pow(1.6,i)); }
      else return {ok:false,error:e.message||"Unknown error"};
    }
  }
}

// ─── CLAUDE API ─ No internal timeout — hard cap in doScan owns all timing ────
async function callClaude(messages, maxTokens=1000) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:maxTokens,messages})
  });
  const d = await r.json();
  if(d.error) throw new Error(d.error.message);
  return d.content?.find(b=>b.type==="text")?.text||"";
}

// ─── DATA COMPLETENESS HEADER ─────────────────────────────────────────────────
function completenessHeader(sources, requestedCount, claudeStatus, errorMsg='') {
  const pct  = requestedCount>0 ? Math.round((sources.length/requestedCount)*100) : 0;
  const srcList = sources.map(s=>`- ${s.label}`).join('\n');
  const statusStr = claudeStatus==='full'
    ? '✓ Complete multi-sensor analysis'
    : errorMsg
      ? `⚠ ${errorMsg.slice(0,100)}`
      : '⚠ Timed out before completion';
  return (
    `**SENSOR COVERAGE: ${pct}%** (${sources.length} of ${requestedCount} sources loaded)  \n`+
    `**ANALYSIS STATUS:** ${statusStr}\n\n`+
    `**SENSORS USED**\n${srcList||'- None'}\n\n`
  );
}

function generateTimeoutResult(region, sources, requestedCount, errorMsg='') {
  return (
    completenessHeader(sources, requestedCount, 'none', errorMsg||'Analysis did not complete')+
    `**⚠ NO TERRAIN ANALYSIS PRODUCED**\n`+
    (errorMsg?`**Error details:** ${errorMsg}\n\n`:'')+
    `This region can be retried. If errors persist, disable EMIT/Landsat/ASTER in Settings and use ESRI Visual only.\n\n`+
    `**PROSPECTIVITY SCORE**: N/A — retry required`
  );
}

async function analyzeTerrain(region, sources) {
  const content=[];
  sources.slice(0,4).forEach(s=>{
    content.push({type:"image",source:{type:"url",url:s.url}});
    content.push({type:"text",text:`↑ ${s.label}`});
  });
  content.push({type:"text",text:
    `Expert economic geologist with remote sensing expertise.\n\nAnalyzing: ${region.name}, ${region.country} — ${region.type}. ${region.desc}\n\n` +
    `${sources.length} image source(s) above — use ALL available spectral data.\n\n` +
    `**COLOR SIGNATURE**\nDominant/secondary colors. Iron oxide (reds/oranges), clay alteration (whites/yellows), chloritization (greens), silicification (pale grey). If SWIR available, note band ratio anomalies. Rate distinctiveness 1–10.\n\n` +
    `**SPECTRAL ANOMALIES**\nIn false color/SWIR: note zones with anomalous reflectance suggesting hydrothermal alteration, iron oxide halos, or clay concentrations. Note which sensor.\n\n` +
    `**STRUCTURAL FEATURES**\nLinear features, fault traces, circular anomalies, contact zones, intrusive bodies.\n\n` +
    `**TERRAIN MORPHOLOGY**\nRidges, valleys, drainage patterns, erosion surfaces.\n\n` +
    `**VEGETATION ANOMALY**\nDensity and pattern. Biogeochemical halos cause stress near mineralization.\n\n` +
    `**ALTERATION FOOTPRINT**\nHydrothermal alteration zones visible across any sensor.\n\n` +
    `**DATA SOURCES USED**\nNote which sensors contributed meaningful information.\n\n` +
    `**TERRAIN FINGERPRINT SUMMARY**\n2–3 sentences: core multi-sensor visual signature for pattern matching.\n\n` +
    `**PROSPECTIVITY SCORE**: X/10`
  });
  return callClaude([{role:"user",content}],1000);
}

async function scoreGridPoint(pt, patternText, sources) {
  const content=[];
  sources.slice(0,4).forEach(s=>{
    content.push({type:"image",source:{type:"url",url:s.url}});
    content.push({type:"text",text:`↑ ${s.label}`});
  });
  content.push({type:"text",text:
    `Expert exploration geologist — multi-sensor terrain pattern matching.\n\n` +
    `REFERENCE PATTERN (known gold deposits):\n${patternText?.substring(0,1200)||"No pattern — score general gold prospectivity."}\n\n` +
    `${sources.length} image(s) above. Score terrain against reference pattern using ALL data.\n\n` +
    `Return ONLY valid JSON:\n{"score":<0-100>,"grade":"<NO_MATCH|LOW|MODERATE|HIGH|VERY_HIGH>","matchedFeatures":["..."],"missingFeatures":["..."],"anomalyRadius":"<km>","dominantColors":"<brief>","keyObservation":"<1-2 sentences>","mineralSignature":"<spectral notes>","dataSources":["esri","gibs",...],"confidence":"<LOW|MEDIUM|HIGH>"}`
  });
  const raw=await callClaude([{role:"user",content}],600);
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return {score:0,grade:"NO_MATCH",matchedFeatures:[],missingFeatures:[],anomalyRadius:"unknown",dominantColors:"unknown",keyObservation:"Parse error",mineralSignature:"",dataSources:[],confidence:"LOW"}; }
}

async function queryMRDS(lat, lon) {
  return callClaude([{role:"user",content:
    `You are a USGS economic geologist with deep knowledge of the Mineral Resources Data System (MRDS), mining history, and US mineral districts.\n\n`+
    `Coordinates: ${lat.toFixed(4)}°N, ${lon.toFixed(4)}°W\n\n`+
    `For this specific location, provide:\n\n`+
    `**MINING DISTRICT**\nNearest named mining district(s), distance estimate, primary commodities.\n\n`+
    `**MRDS RECORDS**\nKnown MRDS mineral occurrences, prospects, or mines within ~10 miles. Include site names, deposit types (placer/lode/skarn/etc), primary metals.\n\n`+
    `**HISTORIC PRODUCTION**\nAny recorded gold or silver production in this township. Rough magnitude if known.\n\n`+
    `**CLAIM STATUS**\nIs this area historically claimed? Active vs. historic. BLM land availability if known.\n\n`+
    `**PROSPECTIVITY NOTE**\nIs this area underexplored relative to geological potential? Any known exploration programs?\n\n`+
    `Be specific with district and mine names. If you have no data for this exact location, say so — do not fabricate records.`
  }], 700);
}

async function synthesizePatterns(analyses) {
  const text=analyses.map(a=>`### ${a.region.name} (${a.region.type})\n${a.text}`).join("\n\n---\n");
  return callClaude([{role:"user",content:
    `World-class exploration geologist. Multi-sensor terrain fingerprints from ${analyses.length} known gold deposits:\n\n${text}\n\n` +
    `**CROSS-DEPOSIT PATTERNS**\nVisual/spectral features across multiple deposit types.\n\n**DEPOSIT-TYPE SIGNATURES**\nUnique multi-sensor signature per deposit type.\n\n` +
    `**UNIVERSAL SEARCH INDICATORS**\n5–7 most reliable satellite-visible indicators (include SWIR/spectral if in data).\n\n` +
    `**TOP 5 UNEXPLORED TARGET ZONES**\nRegion, country, coords, deposit resemblance, visual similarities, why underexplored.\n\n` +
    `**REMOTE SENSING PRIORITY**\nBest sensor combinations for this terrain type.`
  }]);
}

// ─── GEOCODE — Claude-powered (api.anthropic.com is the only allowed fetch) ──
async function geocode(query) {
  const q=query.trim();

  // Bare coordinates: "44.06, -121.31" or "44.06 -121.31" — no API call needed
  const coord=q.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if(coord) return {lat:parseFloat(coord[1]),lon:parseFloat(coord[2]),display:q};

  // Use Claude — the only external fetch the sandbox allows
  const r=await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:120,
      messages:[{role:"user",content:
        `Return ONLY a JSON object — no other text — with the WGS84 center coordinates of: "${q}"\n`+
        `{"lat":<decimal>,"lon":<decimal>,"display":"<City, State/Country>"}`
      }]
    })
  });
  const d=await r.json();
  if(d.error) throw new Error(d.error.message);
  const text=d.content?.find(b=>b.type==="text")?.text||"";
  try {
    const parsed=JSON.parse(text.replace(/```json|```/g,"").trim());
    if(typeof parsed.lat==="number"&&typeof parsed.lon==="number") return parsed;
  } catch(_){}
  throw new Error(`Could not locate "${q}". Try entering coordinates directly: 44.06, -121.31`);
}
function buildGrid(lat,lon,miles,n) {
  const lD=miles/69,loD=miles/(69*Math.cos(lat*Math.PI/180)),pts=[];
  for(let r=0;r<n;r++) for(let c=0;c<n;c++) {
    const t=n>1?n-1:1;
    pts.push({lat:lat-lD+(r/t)*2*lD,lon:lon-loD+(c/t)*2*loD,row:r,col:c,id:`${r}-${c}`});
  }
  return pts;
}

// ─── MARKDOWN ────────────────────────────────────────────────────────────────
function MD({text}) {
  return (
    <div style={{lineHeight:1.75,fontSize:"0.84rem"}}>
      {(text||"").split("\n").map((line,i)=>{
        if(/^# /.test(line))   return <div key={i} style={{color:"#e8d5a0",fontSize:"0.95rem",fontWeight:700,marginTop:"0.8rem",marginBottom:"0.3rem"}}>{line.slice(2)}</div>;
        if(/^## /.test(line))  return <div key={i} style={{color:"#c9a227",fontWeight:700,marginTop:"1rem",marginBottom:"0.3rem",borderBottom:"1px solid #1e3a5f",paddingBottom:3}}>{line.slice(3)}</div>;
        if(/^### /.test(line)) return <div key={i} style={{color:"#7fdbff",fontWeight:600,marginTop:"0.8rem"}}>{line.slice(4)}</div>;
        if(/^\*\*[^*]+\*\*$/.test(line.trim())) return <div key={i} style={{color:"#c9a227",fontFamily:"monospace",fontSize:"0.68rem",letterSpacing:"0.07em",marginTop:"1rem",marginBottom:"0.3rem",textTransform:"uppercase",borderBottom:"1px solid #1e3a5f",paddingBottom:3}}>{line.replace(/\*\*/g,"")}</div>;
        if(/^[-•] /.test(line)) return <div key={i} style={{paddingLeft:"1rem",position:"relative",marginBottom:"0.2rem",color:"#a8c0d6"}}><span style={{position:"absolute",left:0,color:"#c9a227"}}>›</span>{line.slice(2)}</div>;
        if(/^\d+\./.test(line)) return <div key={i} style={{color:"#a8c0d6",marginBottom:"0.2rem"}}>{line}</div>;
        if(line.trim()==="---") return <hr key={i} style={{border:"none",borderTop:"1px solid #1e3a5f",margin:"0.8rem 0"}}/>;
        if(!line.trim()) return <div key={i} style={{height:"0.35rem"}}/>;
        const parts=line.split(/(\*\*[^*]+\*\*)/g).map((c,j)=>c.startsWith("**")?<strong key={j} style={{color:"#e8d5a0"}}>{c.replace(/\*\*/g,"")}</strong>:<span key={j}>{c}</span>);
        return <div key={i} style={{color:"#a8c0d6",marginBottom:"0.12rem"}}>{parts}</div>;
      })}
    </div>
  );
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const GRADE_C={VERY_HIGH:"#f0a500",HIGH:"#c9a227",MODERATE:"#7fdbff",LOW:"#4a7a9b",NO_MATCH:"#2a3a4a"};
const GRADE_B={VERY_HIGH:"#2a1a00",HIGH:"#1a1200",MODERATE:"#0d1929",LOW:"#080f1e",NO_MATCH:"#050b14"};

// ─── SMALL COMPONENTS ────────────────────────────────────────────────────────
function SatImg({lat,lon,zoom=13}) {
  const [st,setSt]=useState("loading");
  const src=esriUrl(lat,lon,zoom,600);
  return (
    <div style={{width:"100%",aspectRatio:"1/1",position:"relative",background:"#000",borderRadius:3,overflow:"hidden",border:"1px solid #1e3a5f"}}>
      <img key={src} src={src} alt="" crossOrigin="anonymous"
        style={{width:"100%",height:"100%",objectFit:"cover",display:st==="ok"?"block":"none"}}
        onLoad={()=>setSt("ok")} onError={()=>setSt("error")}/>
      {st==="loading"&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"#050b14"}}><div style={{width:8,height:8,borderRadius:"50%",background:"#c9a227",animation:"pulse 1s infinite"}}/></div>}
      {st==="error"&&<div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6,background:"#050b14",padding:8}}>
        <div style={{fontSize:"0.52rem",color:"#4a7a9b",textAlign:"center"}}>Display blocked</div>
        <a href={`https://maps.google.com/@${lat},${lon},14z/data=!3m1!1e3`} target="_blank" rel="noopener noreferrer" style={{fontSize:"0.52rem",color:"#7fdbff",fontFamily:"Space Mono, monospace"}}>Google Maps ↗</a>
      </div>}
      {st==="ok"&&<>
        <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <line x1="20" y1="0" x2="20" y2="14" stroke="#c9a227" strokeWidth="1.5" opacity="0.8"/>
            <line x1="20" y1="26" x2="20" y2="40" stroke="#c9a227" strokeWidth="1.5" opacity="0.8"/>
            <line x1="0" y1="20" x2="14" y2="20" stroke="#c9a227" strokeWidth="1.5" opacity="0.8"/>
            <line x1="26" y1="20" x2="40" y2="20" stroke="#c9a227" strokeWidth="1.5" opacity="0.8"/>
            <circle cx="20" cy="20" r="5" stroke="#c9a227" strokeWidth="1.5" fill="none" opacity="0.8"/>
          </svg>
        </div>
        <div style={{position:"absolute",bottom:5,left:6,background:"rgba(5,11,20,0.75)",padding:"2px 6px",borderRadius:2,fontSize:"0.5rem",color:"#4a7a9b",fontFamily:"Space Mono, monospace"}}>
          {lat.toFixed(4)}° {lon.toFixed(4)}°
        </div>
      </>}
    </div>
  );
}

function Confirm({message,onConfirm,onCancel}) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(5,11,20,0.9)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}}>
      <div style={{background:"#080f1e",border:"1px solid #1e3a5f",borderRadius:6,padding:24,maxWidth:320,width:"100%"}}>
        <div style={{fontSize:"0.7rem",color:"#a8c0d6",marginBottom:20,lineHeight:1.6}}>{message}</div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onCancel} style={{flex:1,padding:10,background:"transparent",border:"1px solid #1e3a5f",color:"#4a7a9b",fontFamily:"Space Mono, monospace",fontSize:"0.62rem",cursor:"pointer",borderRadius:3}}>CANCEL</button>
          <button onClick={onConfirm} style={{flex:1,padding:10,background:"#3a1010",border:"1px solid #7a2020",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.62rem",fontWeight:700,cursor:"pointer",borderRadius:3}}>CONFIRM</button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({status,retryCount=0}) {
  const cfg={
    pending: {label:"PENDING", c:"#2a3a4a",bc:"transparent"},
    active:  {label:"SCANNING",c:"#2ecc71",bc:"transparent",pulse:true},
    retrying:{label:`RETRY ${retryCount}/3`,c:"#f0a500",b:"#1a1000",bc:"#4a2a00"},
    done:    {label:"✓ DONE",  c:"#2ecc71",bc:"#1a4a2a"},
    timeout: {label:"PARTIAL", c:"#f0a500",b:"#1a1200",bc:"#4a3000"},
    skipped: {label:"SKIPPED", c:"#f0a500",b:"#1a1200",bc:"#4a3000"},
    error:   {label:"ERROR",   c:"#ff6b6b",b:"#1a0a0a",bc:"#4a1010"},
  }[status]||{label:status,c:"#4a7a9b",bc:"transparent"};
  return (
    <div style={{display:"flex",alignItems:"center",gap:5}}>
      {cfg.pulse&&<div style={{width:5,height:5,borderRadius:"50%",background:"#2ecc71",animation:"pulse 0.8s infinite"}}/>}
      <span style={{fontSize:"0.5rem",color:cfg.c,background:cfg.b||"transparent",border:`1px solid ${cfg.bc}`,padding:"2px 5px",borderRadius:2,letterSpacing:"0.06em"}}>{cfg.label}</span>
    </div>
  );
}

// ─── PROGRESS BAR COMPONENT ───────────────────────────────────────────────────
function ScanProgressBar({step,pct,onStop,showStop,overallLabel,onForceReset}) {
  const [elapsed,setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  // Reset timer whenever the overall label changes (new scan started)
  useEffect(()=>{
    startRef.current=Date.now();
    setElapsed(0);
    const t=setInterval(()=>setElapsed(Math.floor((Date.now()-startRef.current)/1000)),1000);
    return ()=>clearInterval(t);
  },[overallLabel]);

  const fmt=s=>s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`;
  const isLong = elapsed>50 && pct<100;
  const isVeryLong = elapsed>90 && pct<100;
  // bar is alive if pct is still changing — we use elapsed as a proxy
  const barColor = isVeryLong?"#f0a500":pct>=90?"#2ecc71":"#c9a227";

  return (
    <div style={{background:"#0a1a2a",borderBottom:"1px solid #1e3a5f",padding:"8px 14px 10px",flexShrink:0}}>
      {/* Top row: label + elapsed + stop */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
          <div style={{width:7,height:7,flexShrink:0,borderRadius:"50%",background:"#c9a227",animation:"pulse 1s infinite"}}/>
          <span style={{fontSize:"0.6rem",color:"#7fdbff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{overallLabel}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0,marginLeft:8}}>
          <span style={{fontSize:"0.58rem",color:isVeryLong?"#f0a500":isLong?"#c9a227":"#4a7a9b",fontFamily:"Space Mono, monospace",fontWeight:isLong?700:400}}>
            {fmt(elapsed)}
          </span>
          {showStop&&(
            <button onClick={onStop} style={{padding:"3px 10px",background:"#3a1010",border:"1px solid #7a2020",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.55rem",cursor:"pointer",borderRadius:2,letterSpacing:"0.06em"}}>■ STOP</button>
          )}
        </div>
      </div>
      {/* Progress bar */}
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{flex:1,height:4,background:"#0d1929",borderRadius:2,overflow:"hidden",position:"relative"}}>
          <div style={{height:"100%",width:`${pct}%`,background:barColor,borderRadius:2,transition:"width 0.6s ease"}}/>
          {/* Shimmer overlay — shows bar is alive even when crawling */}
          {pct>30&&pct<100&&(
            <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,background:"linear-gradient(90deg,transparent 0%,rgba(255,255,255,0.08) 50%,transparent 100%)",animation:"shimmer 2s infinite",backgroundSize:"200% 100%"}}/>
          )}
        </div>
        <div style={{fontSize:"0.58rem",color:barColor,minWidth:32,textAlign:"right",fontWeight:700}}>{pct}%</div>
      </div>
      {/* Step label */}
      <div style={{fontSize:"0.52rem",color:"#4a7a9b",marginTop:3,letterSpacing:"0.04em"}}>{step}</div>
      {/* Force reset — appears after 2 min in case loading is genuinely stuck */}
      {elapsed>120&&(
        <div style={{marginTop:6,display:"flex",alignItems:"center",gap:8}}>
          <div style={{fontSize:"0.5rem",color:"#7a3a3a"}}>Loading stuck?</div>
          <button onClick={onForceReset} style={{padding:"3px 8px",background:"#3a1010",border:"1px solid #7a2020",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.5rem",cursor:"pointer",borderRadius:2,letterSpacing:"0.05em"}}>FORCE RESET</button>
        </div>
      )}
        <div style={{marginTop:5,fontSize:"0.52rem",color:isVeryLong?"#f0a500":"#3a5a7a",lineHeight:1.5}}>
          {isVeryLong
            ? `⚠ ${fmt(elapsed)} elapsed — multi-image analysis can take up to 2 minutes. Still running. Press STOP to abort and retry.`
            : `Claude Vision is processing ${step.includes("multi")||step.includes("4")||step.includes("3")?"multiple images":"imagery"}… this is normal for multi-sensor scans.`
          }
        </div>
      )}
    </div>
  );
}

// ─── DOWNLOAD HELPERS ─────────────────────────────────────────────────────────
const dlMd=(fn,c)=>{ const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([c],{type:"text/markdown"})); a.download=fn; a.click(); URL.revokeObjectURL(a.href); };
const patternToMd=(name,text,rc,ts)=>
  `# AuScan Pattern Analysis: ${name}\n\n**Generated:** ${new Date(ts).toLocaleString()}  \n**Regions Analyzed:** ${rc}  \n**Tool:** AuScan v2.1\n\n---\n\n${text}\n`;
const targetsToMd=(targets,query,pname)=>
  `# AuScan Potential Targets\n\n**Search Region:** ${query}  \n**Pattern Set:** ${pname}  \n**Generated:** ${new Date().toLocaleString()}  \n**Targets:** ${targets.length}\n\n---\n\n`+
  targets.map((t,i)=>
    `## Target ${i+1}: ${t.grade} Match (${t.score}%)\n\n**Coordinates:** ${t.lat?.toFixed(5)}°, ${t.lon?.toFixed(5)}°  \n**Anomaly Radius:** ${t.anomalyRadius}  \n**Grade:** ${t.grade} · **Confidence:** ${t.confidence}  \n**Mineral Signature:** ${t.mineralSignature||"N/A"}  \n**Data Sources:** ${(t.dataSources||[]).join(", ")||"visual"}\n\n**Matched:**\n${(t.matchedFeatures||[]).map(f=>`- ${f}`).join("\n")}\n\n**Missing:**\n${(t.missingFeatures||[]).map(f=>`- ${f}`).join("\n")}\n\n**Key Observation:** ${t.keyObservation}  \n\n**Google Maps:** https://maps.google.com/?q=${t.lat?.toFixed(5)},${t.lon?.toFixed(5)}\n\n---\n`
  ).join("\n");

// ─── MAIN APP ──────────────────────────────────────────────────────────────────
export default function AuScan() {
  const [tab,setTab]           = useState("regions");
  const [zoom,setZoom]         = useState(13);
  const [selected,setSel]      = useState(null);
  const [analyses,setAn]       = useState({});
  const [patternText,setPat]   = useState("");
  const [savedPats,setSavedPats] = useState([]);
  const [targets,setTargets]   = useState([]);
  const [loading,setLoading]   = useState(false);
  const [ready,setReady]       = useState(false);
  const [confirm,setConfirm]   = useState(null);
  const [patSubView,setPSV]    = useState("current");
  const [compareA,setCmpA]     = useState(null);
  const [compareB,setCmpB]     = useState(null);
  const [patName,setPatName]   = useState("");
  // Progress
  const [scanStep,setScanStep]     = useState({label:"",pct:0});       // per-scan sub-step
  const [overallLabel,setOvLabel]  = useState("");                      // top-line label
  const progressIntervalRef        = useRef(null);
  // Scan status
  const [scanStatus,setScanStatus] = useState({});
  const [scanAllActive,setScanAllActive] = useState(false);
  const [scanProg,setScanProg]     = useState({current:0,total:0,name:""});
  // Search
  const [searchQ,setSearchQ]     = useState("");
  const [searchR,setSearchR]     = useState(25);
  const [searchN,setSearchN]     = useState(3);
  const [searchRes,setSearchRes] = useState([]);
  const [searchHistory,setSearchHistory] = useState([]); // persisted
  const [searchCtr,setSearchCtr] = useState(null);
  const [searchPat,setSearchPat] = useState("current");
  const [searchActive,setSearchActive] = useState(false);
  const [searchProg,setSearchProg] = useState({current:0,total:0});
  const [activeSearchId,setActiveSearchId] = useState(null);
  const [searchError,setSearchError] = useState(""); // inline error — no alert needed
  const [mrdsByPoint,setMrdsByPoint] = useState({}); // {pointKey: {status,text}}
  // Settings
  const [nasaToken,setNasaToken]   = useState("");
  const [tokenVis,setTokenVis]     = useState(false);
  const [enabledSrc,setEnabledSrc] = useState({gibs:false,emit:true,landsat:true,aster:true,sentinel:true});
  // Refs
  const abortRef       = useRef(false);
  const searchAbortRef = useRef(false);
  const fileInputRef   = useRef(null);
  const claudeCtrlRef  = useRef(null); // AbortController for the active Claude call

  // Load storage
  useEffect(()=>{
    (async()=>{
      const [a,p,z,sp,tg,src,sh]=await Promise.all([
        sl(SK.analyses,{}),sl(SK.patterns,""),sl(SK.zoom,13),
        sl(SK.savedPatterns,[]),sl(SK.targets,[]),
        sl(SK.sources,{gibs:false,emit:true,landsat:true,aster:true,sentinel:true}),
        sl(SK.searchHistory,[])
      ]);
      setAn(a);setPat(p);setZoom(z);setSavedPats(sp);setTargets(tg);setEnabledSrc(src);setSearchHistory(sh);setReady(true);
    })();
  },[]);
  useEffect(()=>{ if(ready){ss(SK.zoom,zoom);} },[zoom,ready]);
  useEffect(()=>{ if(ready){ss(SK.sources,enabledSrc);} },[enabledSrc,ready]);

  const analyzedCount=Object.keys(analyses).length;
  const pendingCount=GOLD_REGIONS.filter(r=>!analyses[r.id]).length;
  const failedCount=GOLD_REGIONS.filter(r=>['error','skipped'].includes(scanStatus[r.id]?.status)).length;

  const updateSS=useCallback((id,patch)=>setScanStatus(prev=>({...prev,[id]:{...(prev[id]||{status:'pending',retryCount:0,error:null}),...patch}})),[]);

  // ── Animated progress during Claude Vision call ──────────────────────────────
  const startClaudeAnim=(fromPct)=>{
    if(progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    const start=Date.now();
    progressIntervalRef.current=setInterval(()=>{
      const elapsed=(Date.now()-start)/1000;
      let pct;
      if(elapsed<45){
        // Fast phase: fromPct to 85% over 45s with ease-out curve
        const t=elapsed/45;
        const eased=1-Math.pow(1-t,2.5);
        pct=Math.round(fromPct+(85-fromPct)*eased);
      } else {
        // Slow crawl after 45s: ~1% per 20s, never stops, never freezes
        pct=Math.min(85+Math.floor((elapsed-45)/20),97);
      }
      setScanStep(prev=>({...prev,pct}));
    },600);
  };
  const stopClaudeAnim=()=>{ if(progressIntervalRef.current){clearInterval(progressIntervalRef.current);progressIntervalRef.current=null;} };

  const HARD_CAP_MS = 300000; // 5-minute ceiling

  const doScan=useCallback(async(region,z)=>{
    const onStep=(label,pct)=>setScanStep({label,pct});
    let sources=[];
    const requestedCount=1+Object.values(enabledSrc).filter(Boolean).length;

    let triggerAbort;
    const abortRace=new Promise((_,reject)=>{ triggerAbort=reject; });
    claudeCtrlRef.current={ abort:(reason='MANUAL_STOP')=>triggerAbort(Object.assign(new Error(reason),{reason})) };
    const capTimer=setTimeout(()=>triggerAbort(Object.assign(new Error('HARD_CAP'),{reason:'HARD_CAP'})), HARD_CAP_MS);

    let text='', isPartial=false, claudeStatus='none', lastError='';

    try {
      // Gather sources — all with 8s timeouts, parallel
      sources=await Promise.race([
        gatherSources(region.lat,region.lon,z||zoom,nasaToken,enabledSrc,onStep),
        abortRace
      ]);

      startClaudeAnim(38);
      let result=null;

      // ── Attempt 1: all loaded sources ──────────────────────────────────────
      try {
        setScanStep(prev=>({...prev,label:`Claude Vision: ${sources.length} sensor${sources.length!==1?'s':''} — analyzing…`}));
        result=await Promise.race([analyzeTerrain(region,sources), abortRace]);
      } catch(e1) {
        // Errors with .reason came from abortRace (MANUAL_STOP or HARD_CAP) — propagate immediately
        if(e1.reason) throw e1;
        // API error — record it, try ESRI-only fallback (abortRace is still pending here)
        lastError=e1.message||'API error';
        setScanStep(prev=>({...prev,label:`⚠ Error: ${lastError.slice(0,50)} — retrying ESRI only…`,pct:42}));

        const esriOnly=sources.filter(s=>s.key==='esri');
        if(esriOnly.length) {
          try {
            result=await Promise.race([analyzeTerrain(region,esriOnly), abortRace]);
            sources=esriOnly; // update to reflect what was actually used
            lastError=''; // analysis succeeded
          } catch(e2) {
            if(e2.reason) throw e2; // abort — propagate
            lastError=`Multi-source: ${lastError.slice(0,60)} | ESRI fallback: ${e2.message||'failed'}`;
          }
        } else {
          lastError=`No ESRI source available. Original error: ${lastError}`;
        }
      }

      if(result) {
        claudeStatus='full';
        text=completenessHeader(sources,requestedCount,'full')+result;
      } else {
        isPartial=true;
        text=generateTimeoutResult(region,sources,requestedCount,lastError);
      }

    } catch(e) {
      if(e.reason==='MANUAL_STOP') { e.noRetry=true; throw e; }
      isPartial=true;
      text=generateTimeoutResult(region,sources,requestedCount,e.message||'Hard cap reached');
    } finally {
      clearTimeout(capTimer);
      claudeCtrlRef.current=null;
      stopClaudeAnim();
      setScanStep({label:isPartial?'⚠ Error result saved':'Saving…',pct:isPartial?85:96});
    }

    const entry={region,text,timestamp:new Date().toISOString(),sources:sources.map(s=>s.key),partial:isPartial,claudeStatus};
    setAn(prev=>{ const next={...prev,[region.id]:entry}; ss(SK.analyses,next); return next; });
    setScanStep({label:isPartial?'⚠ Saved with errors':'Complete',pct:100});
    return entry;
  },[zoom,nasaToken,enabledSrc]);

  // ── Single scan ───────────────────────────────────────────────────────────────
  const handleSingleScan=useCallback(async()=>{
    if(!selected||loading) return;
    setLoading(true); setScanStep({label:"Starting…",pct:2}); setTab("analysis");
    setOvLabel(`Scanning ${selected.name}`);
    updateSS(selected.id,{status:'active',retryCount:0,error:null});
    try {
      const res=await withRetry(()=>doScan(selected,zoom),{
        attempts:3,baseDelay:4000,
        onAttempt:(n,e)=>{ updateSS(selected.id,{status:'retrying',retryCount:n,error:e}); setOvLabel(`Retrying ${selected.name} (${n}/3)`); setScanStep({label:`Retry ${n}/3 — ${e?.slice(0,40)||""}`,pct:5}); }
      });
      if(res.ok) updateSS(selected.id,{status:res.data?.partial?'timeout':'done',error:null});
      else updateSS(selected.id,{status:'error',error:res.error});
    } finally {
      setLoading(false); setOvLabel("");
    }
  },[selected,zoom,loading,doScan,updateSS]);

  // ── Scan all ──────────────────────────────────────────────────────────────────
  const handleScanAll=useCallback(async()=>{
    if(loading||scanAllActive) return;
    const pending=GOLD_REGIONS.filter(r=>!analyses[r.id]);
    if(!pending.length){setConfirm({what:"rescan"}); return;}
    abortRef.current=false;
    setScanAllActive(true); setLoading(true); setTab("analysis");
    const skipped=[];
    for(let i=0;i<pending.length;i++){
      if(abortRef.current) break;
      const r=pending[i];
      setScanProg({current:i+1,total:pending.length,name:r.name});
      setOvLabel(`Scanning ${r.name} (${i+1}/${pending.length})`);
      setSel(r); setScanStep({label:"Starting…",pct:2});
      updateSS(r.id,{status:'active',retryCount:0,error:null});
      const res=await withRetry(()=>doScan(r,zoom),{
        attempts:3,baseDelay:4000,
        onAttempt:(n,e)=>{ updateSS(r.id,{status:'retrying',retryCount:n,error:e}); setOvLabel(`Retrying ${r.name} (${n}/3)`); setScanStep({label:`Retry ${n}/3…`,pct:5}); }
      });
      if(res.ok) updateSS(r.id,{status: res.data?.partial?'timeout':'done',error:null});
      else { updateSS(r.id,{status:'skipped',error:res.error}); skipped.push(r); }
    }
    // Auto-retry skipped
    if(skipped.length&&!abortRef.current){
      for(const r of skipped){
        if(abortRef.current) break;
        setSel(r); updateSS(r.id,{status:'active',retryCount:0});
        setOvLabel(`Auto-retrying ${r.name}`); setScanStep({label:"Auto-retry…",pct:5});
        const res=await withRetry(()=>doScan(r,zoom),{attempts:2,baseDelay:6000,
          onAttempt:(n)=>updateSS(r.id,{status:'retrying',retryCount:n})});
        updateSS(r.id,res.ok?{status:'done',error:null}:{status:'error',error:res.error});
      }
    }
    setScanAllActive(false); setLoading(false); setOvLabel(""); setScanStep({label:"",pct:0}); setScanProg({current:0,total:0,name:""});
  },[loading,scanAllActive,analyses,zoom,doScan,updateSS]);

  const handleRetryFailed=useCallback(async()=>{
    if(loading) return;
    const failed=GOLD_REGIONS.filter(r=>['error','skipped'].includes(scanStatus[r.id]?.status));
    if(!failed.length) return;
    abortRef.current=false;
    setScanAllActive(true); setLoading(true); setTab("analysis");
    for(let i=0;i<failed.length;i++){
      if(abortRef.current) break;
      const r=failed[i];
      setScanProg({current:i+1,total:failed.length,name:r.name});
      setSel(r); updateSS(r.id,{status:'active',retryCount:0,error:null});
      setOvLabel(`Retrying ${r.name} (${i+1}/${failed.length})`);
      setScanStep({label:"Starting retry…",pct:2});
      const res=await withRetry(()=>doScan(r,zoom),{attempts:3,baseDelay:4000,
        onAttempt:(n,e)=>updateSS(r.id,{status:'retrying',retryCount:n,error:e})});
      updateSS(r.id,res.ok?{status:'done',error:null}:{status:'error',error:res.error});
    }
    setScanAllActive(false); setLoading(false); setOvLabel(""); setScanStep({label:"",pct:0}); setScanProg({current:0,total:0,name:""});
  },[loading,scanStatus,doScan,zoom,updateSS]);

  const handleSynthesize=useCallback(async()=>{
    const all=Object.values(analyses).filter(a=>!a.text?.startsWith("Error")&&!a.text?.includes('ANALYSIS INCOMPLETE'));
    if(all.length<2||loading) return;
    setLoading(true); setScanStep({label:"Running synthesis…",pct:20}); setTab("patterns");
    setOvLabel(`Synthesizing ${all.length} deposit signatures`);
    startClaudeAnim(20);
    let triggerAbort;
    const abortRace=new Promise((_,reject)=>{ triggerAbort=reject; });
    claudeCtrlRef.current={ abort:()=>triggerAbort(Object.assign(new Error('MANUAL_STOP'),{reason:'MANUAL_STOP',noRetry:true})) };
    const cap=setTimeout(()=>triggerAbort(new Error('Synthesis timeout — try with fewer regions selected')),300000);
    try {
      const result=await Promise.race([synthesizePatterns(all), abortRace]);
      stopClaudeAnim(); clearTimeout(cap);
      setPat(result); ss(SK.patterns,result); setScanStep({label:"Synthesis complete",pct:100});
    } catch(e) {
      stopClaudeAnim(); clearTimeout(cap);
      setScanStep({label:`Synthesis failed: ${e.message?.slice(0,60)||'timeout'}`,pct:0});
    } finally {
      claudeCtrlRef.current=null;
      setLoading(false); setOvLabel("");
    }
  },[analyses,loading]);

  // Pattern save/load
  const handleSavePat=useCallback(()=>{
    if(!patternText) return;
    const name=patName.trim()||`Pattern Set ${new Date().toLocaleDateString()}`;
    const entry={id:Date.now().toString(),name,text:patternText,regionCount:analyzedCount,timestamp:new Date().toISOString()};
    const next=[...savedPats,entry]; setSavedPats(next); ss(SK.savedPatterns,next); setPatName("");
    dlMd(`auscan-${name.replace(/\s+/g,"-").toLowerCase()}.md`,patternToMd(name,patternText,analyzedCount,entry.timestamp));
  },[patternText,patName,savedPats,analyzedCount]);

  const handleFileLoad=useCallback(e=>{
    const file=e.target.files?.[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      const text=ev.target.result;
      const name=text.match(/^# AuScan Pattern Analysis: (.+)$/m)?.[1]||file.name.replace(/\.md$/,"");
      const rc=parseInt(text.match(/\*\*Regions Analyzed:\*\* (\d+)/)?.[1]||0);
      const parts=text.split(/^---$/m);
      const body=parts.length>1?parts.slice(1).join("---").trim():text;
      const entry={id:Date.now().toString(),name,text:body,regionCount:rc,timestamp:new Date().toISOString()};
      const next=[...savedPats,entry]; setSavedPats(next); ss(SK.savedPatterns,next);
    };
    reader.readAsText(file); e.target.value="";
  },[savedPats]);

  const getSearchPatText=useCallback(()=>searchPat==="current"?patternText:savedPats.find(p=>p.id===searchPat)?.text||patternText,[searchPat,patternText,savedPats]);
  const getSearchPatName=useCallback(()=>searchPat==="current"?"Current Pattern Set":savedPats.find(p=>p.id===searchPat)?.name||"Unknown",[searchPat,savedPats]);

  const handleSearch=useCallback(async()=>{
    if(loading||searchActive||(!patternText&&!savedPats.length)) return;
    const pText=getSearchPatText();
    if(!searchQ.trim()) return;
    setSearchError("");
    setLoading(true); setScanStep({label:"Starting search…",pct:2}); setSearchRes([]);
    setSearchActive(true); setOvLabel(`Searching: ${searchQ}`);
    searchAbortRef.current=false;
    try {
      let center;
      try {
        setScanStep({label:"Geocoding location…",pct:5});
        center=await geocode(searchQ.trim());
        setSearchCtr(center);
      } catch(e){
        setSearchError(`Location not found: ${e.message}`);
        return;
      }
      const grid=buildGrid(center.lat,center.lon,searchR,searchN);
      const results=[];
      setSearchProg({current:0,total:grid.length});
      for(let i=0;i<grid.length;i++){
        if(searchAbortRef.current) break;
        const pt=grid[i];
        setSearchProg({current:i+1,total:grid.length});
        setOvLabel(`Scoring point ${i+1}/${grid.length}`);
        setScanStep({label:`Point ${i+1}/${grid.length}: ${pt.lat.toFixed(3)}°, ${pt.lon.toFixed(3)}°`,pct:Math.round((i/grid.length)*100)});
        let scored;
        try {
          scored=await Promise.race([
            (async()=>{
              const sources=await gatherSources(pt.lat,pt.lon,13,nasaToken,enabledSrc);
              startClaudeAnim(Math.round((i/grid.length)*100));
              setScanStep(prev=>({...prev,label:`Point ${i+1}/${grid.length}: Claude Vision scoring…`}));
              const r=await scoreGridPoint(pt,pText,sources);
              stopClaudeAnim();
              return {...pt,...r,sources:sources.map(s=>s.key),searchQuery:searchQ.trim(),patternName:getSearchPatName()};
            })(),
            new Promise((_,reject)=>setTimeout(()=>{ stopClaudeAnim(); reject(new Error('Point timeout')); },120000))
          ]);
        } catch(ptErr) {
          if(searchAbortRef.current) break;
          scored={...pt,score:0,grade:"NO_MATCH",matchedFeatures:[],missingFeatures:[],anomalyRadius:"N/A",keyObservation:`Timeout: ${ptErr.message}`,mineralSignature:"",dataSources:[],confidence:"LOW"};
        }
        results.push(scored);
        setSearchRes([...results].sort((a,b)=>b.score-a.score));
      }
      const finalRes=[...results].sort((a,b)=>b.score-a.score);
      const histEntry={id:Date.now().toString(),query:searchQ.trim(),center,radius:searchR,grid:searchN,results:finalRes,patternName:getSearchPatName(),timestamp:new Date().toISOString()};
      const newHist=[histEntry,...searchHistory].slice(0,10);
      setSearchHistory(newHist); ss(SK.searchHistory,newHist); setActiveSearchId(histEntry.id);
    } finally {
      setSearchActive(false); setLoading(false);
      setScanStep({label:"",pct:0}); setSearchProg({current:0,total:0}); setOvLabel("");
    }
  },[loading,searchActive,searchQ,searchR,searchN,patternText,savedPats,nasaToken,enabledSrc,searchHistory,getSearchPatText,getSearchPatName]);

  const handleSaveTarget=useCallback(t=>{
    const entry={...t,savedAt:new Date().toISOString(),id:Date.now().toString()};
    const next=[...targets,entry]; setTargets(next); ss(SK.targets,next);
  },[targets]);

  const handleMRDSLookup=useCallback(async(lat,lon,key)=>{
    setMrdsByPoint(prev=>({...prev,[key]:{status:'loading',text:''}}));
    try {
      const text=await queryMRDS(lat,lon);
      setMrdsByPoint(prev=>({...prev,[key]:{status:'done',text}}));
    } catch(e) {
      setMrdsByPoint(prev=>({...prev,[key]:{status:'error',text:`Lookup failed: ${e.message}`}}));
    }
  },[]);

  // Theme
  const G="#c9a227",B="#7fdbff",D="#4a7a9b",BG="#050b14",PNL="#080f1e",BDR="#1e3a5f",LT="#e8d5a0";

  const Tab=(id,label,badge)=>(
    <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:"10px 2px",background:"transparent",border:"none",
      borderBottom:`2px solid ${tab===id?G:"transparent"}`,color:tab===id?G:D,
      fontFamily:"Space Mono, monospace",fontSize:"0.5rem",letterSpacing:"0.03em",textTransform:"uppercase",cursor:"pointer",position:"relative"}}>
      {label}
      {badge>0&&<span style={{position:"absolute",top:3,right:2,background:G,color:"#050b14",borderRadius:8,fontSize:"0.42rem",padding:"1px 3px",fontWeight:700}}>{badge}</span>}
    </button>
  );

  if(!ready) return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:BG,flexDirection:"column",gap:12}}>
      <svg width="24" height="24" viewBox="0 0 20 20"><polygon points="10,2 13,8 20,8 14.5,12.5 16.5,19 10,15 3.5,19 5.5,12.5 0,8 7,8" fill={G}/></svg>
      <div style={{fontSize:"0.6rem",color:D,fontFamily:"Space Mono, monospace",letterSpacing:"0.1em"}}>LOADING…</div>
    </div>
  );

  // Current display results — from history or live
  const displayRes = activeSearchId ? (searchHistory.find(h=>h.id===activeSearchId)?.results||searchRes) : searchRes;

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:BG,fontFamily:"'Space Mono', monospace",color:"#a8c0d6",overflow:"hidden"}}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
        ::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-track{background:#050b14;}::-webkit-scrollbar-thumb{background:#1e3a5f;}
        select option{background:#0d1929;}input[type=range]{accent-color:#c9a227;}
      `}</style>

      {confirm?.what==="rescan"&&<Confirm message="All regions already scanned. Clear analyses and rescan everything?" onConfirm={async()=>{setConfirm(null);setScanStatus({});setAn({});await sd(SK.analyses);setTimeout(handleScanAll,150);}} onCancel={()=>setConfirm(null)}/>}
      {confirm?.what==="clearAn"&&<Confirm message="Delete all terrain analyses?" onConfirm={async()=>{setAn({});setScanStatus({});await sd(SK.analyses);setConfirm(null);}} onCancel={()=>setConfirm(null)}/>}
      {confirm?.what==="clearPat"&&<Confirm message="Delete current pattern synthesis?" onConfirm={async()=>{setPat("");await sd(SK.patterns);setConfirm(null);}} onCancel={()=>setConfirm(null)}/>}
      {confirm?.what==="clearTargets"&&<Confirm message="Delete all saved targets?" onConfirm={async()=>{setTargets([]);await sd(SK.targets);setConfirm(null);}} onCancel={()=>setConfirm(null)}/>}
      {confirm?.what==="delPat"&&<Confirm message={`Delete "${savedPats.find(p=>p.id===confirm.id)?.name}"?`} onConfirm={()=>{setSavedPats(prev=>{const n=prev.filter(p=>p.id!==confirm.id);ss(SK.savedPatterns,n);return n;});setConfirm(null);}} onCancel={()=>setConfirm(null)}/>}

      {/* HEADER */}
      <div style={{background:PNL,borderBottom:`1px solid ${BDR}`,padding:"9px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <svg width="18" height="18" viewBox="0 0 20 20"><polygon points="10,2 13,8 20,8 14.5,12.5 16.5,19 10,15 3.5,19 5.5,12.5 0,8 7,8" fill={G}/></svg>
          <div>
            <div style={{fontSize:"0.9rem",fontWeight:700,color:G,letterSpacing:"0.14em"}}>AUSCAN</div>
            <div style={{fontSize:"0.48rem",color:D,letterSpacing:"0.08em"}}>MULTI-SENSOR GOLD TERRAIN INTELLIGENCE v2.1</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{fontSize:"0.55rem",color:D}}>{analyzedCount}/{GOLD_REGIONS.length}</div>
          <div style={{fontSize:"0.5rem",color:"#2ecc71",border:"1px solid #1a4a2a",padding:"2px 7px",borderRadius:2}}>● LIVE</div>
        </div>
      </div>

      {loading&&(
        <ScanProgressBar
          step={scanStep.label}
          pct={scanStep.pct}
          overallLabel={overallLabel}
          showStop={true}
          onStop={()=>{ abortRef.current=true; searchAbortRef.current=true; claudeCtrlRef.current?.abort(); }}
          onForceReset={()=>{ setLoading(false); setOvLabel(""); setScanStep({label:"",pct:0}); setScanAllActive(false); setSearchActive(false); claudeCtrlRef.current=null; stopClaudeAnim(); }}
        />
      )}

      {/* TABS */}
      <div style={{display:"flex",background:PNL,borderBottom:`1px solid ${BDR}`,flexShrink:0}}>
        {Tab("regions","Regions")}
        {Tab("viewer","Satellite")}
        {Tab("analysis",`Analysis`,analyzedCount)}
        {Tab("patterns","Patterns")}
        {Tab("search","Search",targets.length)}
        {Tab("settings","⚙ Setup")}
      </div>

      <div style={{flex:1,overflowY:"auto",overflowX:"hidden"}}>

        {/* ══ REGIONS ══════════════════════════════════════════════════════════ */}
        {tab==="regions"&&(
          <div>
            <div style={{padding:"12px 14px",borderBottom:`1px solid ${BDR}`,background:"#060c18"}}>
              {!scanAllActive?(
                <button onClick={handleScanAll} disabled={loading} style={{width:"100%",padding:"13px",fontSize:"0.78rem",fontFamily:"Space Mono, monospace",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",background:loading?"#2a3a4a":`linear-gradient(135deg,${G},#e8c84a)`,color:loading?D:"#050b14",border:"none",cursor:loading?"not-allowed":"pointer",borderRadius:4,display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:failedCount?8:0}}>
                  <svg width="13" height="13" viewBox="0 0 20 20"><polygon points="10,2 13,8 20,8 14.5,12.5 16.5,19 10,15 3.5,19 5.5,12.5 0,8 7,8" fill={loading?D:"#050b14"}/></svg>
                  {pendingCount===0?"RESCAN ALL":pendingCount===GOLD_REGIONS.length?`SCAN ALL ${GOLD_REGIONS.length} REGIONS`:`SCAN REMAINING ${pendingCount}`}
                </button>
              ):(
                <div style={{background:"#0a1a2a",border:`1px solid ${BDR}`,borderRadius:3,padding:"9px 12px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <div style={{fontSize:"0.6rem",color:G}}>SCANNING {scanProg.current}/{scanProg.total}</div>
                    <div style={{fontSize:"0.6rem",color:D}}>{scanProg.total>0?Math.round((scanProg.current/scanProg.total)*100):0}%</div>
                  </div>
                  <div style={{height:2,background:"#0d1929",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${scanProg.total>0?(scanProg.current/scanProg.total)*100:0}%`,background:G,transition:"width 0.4s"}}/>
                  </div>
                </div>
              )}
              {failedCount>0&&!scanAllActive&&(
                <button onClick={handleRetryFailed} disabled={loading} style={{width:"100%",padding:"9px",background:"#1a0d0d",border:"1px solid #7a2020",color:"#ff9966",fontFamily:"Space Mono, monospace",fontSize:"0.62rem",fontWeight:700,cursor:loading?"not-allowed":"pointer",borderRadius:3,marginTop:6,letterSpacing:"0.08em"}}>
                  ↻ RETRY {failedCount} FAILED REGION{failedCount!==1?"S":""}
                </button>
              )}
              <div style={{fontSize:"0.52rem",color:"#2a4a6a",textAlign:"center",marginTop:6}}>
                {pendingCount===0?`All ${GOLD_REGIONS.length} analyzed`:`${analyzedCount} done · ${pendingCount} pending`}
                {failedCount>0&&<span style={{color:"#ff6b6b",marginLeft:8}}>{failedCount} failed</span>}
              </div>
            </div>
            {GOLD_REGIONS.map((r,idx)=>{
              const st=scanStatus[r.id];
              const isDone=!!analyses[r.id];
              const isSel=selected?.id===r.id;
              const status=st?.status||(isDone?'done':'pending');
              return(
                <div key={r.id} onClick={()=>{if(!scanAllActive){setSel(r);setTab("viewer");}}}
                  style={{padding:"11px 14px",borderBottom:`1px solid #0d1929`,cursor:scanAllActive?"default":"pointer",
                    background:status==='active'?"#0d2a1a":isSel?"#0d1f35":"transparent",
                    borderLeft:`3px solid ${status==='active'?"#2ecc71":status==='error'?"#ff6b6b":status==='skipped'?"#f0a500":isSel?G:isDone?"#2a6a4a":"transparent"}`,transition:"background 0.2s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{flex:1,paddingRight:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:2}}>
                        <span style={{fontSize:"0.58rem",color:"#2a4a6a"}}>{String(idx+1).padStart(2,"0")}</span>
                        <span style={{fontSize:"0.76rem",fontWeight:600,color:status==='active'?"#2ecc71":isSel?LT:B}}>{r.name}</span>
                      </div>
                      <div style={{fontSize:"0.58rem",color:D,paddingLeft:22}}>{r.country} · <span style={{color:G}}>{r.type}</span></div>
                      {st?.error&&status==='error'&&<div style={{fontSize:"0.5rem",color:"#ff6b6b",paddingLeft:22,marginTop:2}}>{st.error.slice(0,55)}</div>}
                    </div>
                    <StatusBadge status={status} retryCount={st?.retryCount||0}/>
                  </div>
                </div>
              );
            })}
            <div style={{height:20}}/>
          </div>
        )}

        {/* ══ SATELLITE ════════════════════════════════════════════════════════ */}
        {tab==="viewer"&&(
          <div style={{padding:"12px 14px"}}>
            {!selected?(
              <div style={{textAlign:"center",padding:"60px 20px",color:BDR}}><div style={{fontSize:"3rem",marginBottom:10}}>◎</div><div style={{fontSize:"0.62rem",letterSpacing:"0.1em"}}>SELECT A REGION FIRST</div></div>
            ):(
              <>
                <div style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"10px 12px",marginBottom:12}}>
                  <div style={{fontSize:"0.8rem",fontWeight:600,color:LT}}>{selected.name}</div>
                  <div style={{fontSize:"0.62rem",color:G,marginTop:2}}>{selected.type} · {selected.country}</div>
                  <div style={{fontSize:"0.6rem",color:D,marginTop:4,lineHeight:1.5}}>{selected.desc}</div>
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:"0.52rem",color:D,letterSpacing:"0.08em",marginBottom:7,textTransform:"uppercase"}}>Zoom</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {[10,11,12,13,14,15,16].map(z=>(
                      <button key={z} onClick={()=>setZoom(z)} style={{width:34,height:34,background:zoom===z?G:"#0d1929",border:`1px solid ${zoom===z?G:BDR}`,color:zoom===z?"#050b14":D,fontFamily:"Space Mono, monospace",fontSize:"0.65rem",cursor:"pointer",borderRadius:3,fontWeight:zoom===z?700:400}}>{z}</button>
                    ))}
                  </div>
                </div>
                <SatImg lat={selected.lat} lon={selected.lon} zoom={zoom}/>
                <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:10}}>
                  {Object.entries(enabledSrc).map(([k,v])=>(
                    <span key={k} style={{fontSize:"0.46rem",padding:"2px 5px",borderRadius:2,background:v?"#0d1f0d":"#0d0d0d",border:`1px solid ${v?"#2a6a2a":"#1e2a1e"}`,color:v?"#2ecc71":"#2a4a2a"}}>{k.toUpperCase()}</span>
                  ))}
                </div>
                <button onClick={handleSingleScan} disabled={loading} style={{width:"100%",padding:"14px",fontSize:"0.78rem",fontFamily:"Space Mono, monospace",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",background:loading?"#2a3a4a":G,color:loading?D:"#050b14",border:"none",cursor:loading?"not-allowed":"pointer",borderRadius:4,marginBottom:8}}>
                  {loading?"SCANNING…":analyses[selected?.id]?"↻ RE-ANALYZE":"◉ ANALYZE TERRAIN"}
                </button>
                {analyses[selected?.id]&&!loading&&(
                  <button onClick={()=>setTab("analysis")} style={{width:"100%",padding:"10px",fontSize:"0.68rem",fontFamily:"Space Mono, monospace",letterSpacing:"0.1em",textTransform:"uppercase",background:"transparent",color:B,border:`1px solid ${BDR}`,cursor:"pointer",borderRadius:4}}>VIEW RESULTS →</button>
                )}
              </>
            )}
          </div>
        )}

        {/* ══ ANALYSIS ═════════════════════════════════════════════════════════ */}
        {tab==="analysis"&&(
          <div style={{padding:"12px 14px"}}>
            {analyzedCount===0&&!loading?(
              <div style={{textAlign:"center",padding:"60px 20px",color:BDR}}><div style={{fontSize:"3rem",marginBottom:10}}>◉</div><div style={{fontSize:"0.62rem",letterSpacing:"0.1em"}}>NO ANALYSES YET</div><div style={{fontSize:"0.58rem",color:"#2a3a4a",marginTop:6}}>Use Scan All on Regions tab</div></div>
            ):(
              <>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontSize:"0.57rem",color:D,textTransform:"uppercase"}}>{analyzedCount}/{GOLD_REGIONS.length} analyzed</div>
                  <div style={{display:"flex",gap:6}}>
                    {analyzedCount>=2&&<button onClick={handleSynthesize} disabled={loading} style={{padding:"5px 9px",background:loading?"#0a1520":"#0d2a4a",border:`1px solid ${loading?BDR:B}`,color:loading?"#2a3a4a":B,fontFamily:"Space Mono, monospace",fontSize:"0.52rem",cursor:loading?"not-allowed":"pointer",borderRadius:3}}>◈ SYNTHESIZE →</button>}
                    <button onClick={()=>setConfirm({what:"clearAn"})} style={{padding:"5px 8px",background:"transparent",border:"1px solid #3a1010",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.52rem",cursor:"pointer",borderRadius:3}}>✕</button>
                  </div>
                </div>
                {analyzedCount>1&&(
                  <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:12}}>
                    {Object.values(analyses).map(a=>{
                      const active=selected?.id===a.region.id;
                      return <button key={a.region.id} onClick={()=>setSel(a.region)} style={{padding:"5px 9px",fontFamily:"Space Mono, monospace",fontSize:"0.55rem",background:active?"#0d2a4a":"#0d1929",border:`1px solid ${active?B:BDR}`,color:active?B:D,cursor:"pointer",borderRadius:3}}>{a.region.name}</button>;
                    })}
                  </div>
                )}
                {(()=>{
                  const key=selected?.id&&analyses[selected.id]?selected.id:Object.keys(analyses)[0];
                  const a=analyses[key]; if(!a) return null;
                  return(
                    <div>
                      <div style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"10px 12px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div>
                          <div style={{fontSize:"0.78rem",fontWeight:600,color:LT}}>{a.region.name}</div>
                          <div style={{fontSize:"0.57rem",color:D,marginTop:1}}>{new Date(a.timestamp).toLocaleString()}</div>
                          {a.sources?.length>1&&<div style={{fontSize:"0.5rem",color:"#2a6a4a",marginTop:2}}>Sources: {a.sources.join(" + ")}</div>}
                        </div>
                        <div style={{fontSize:"0.52rem",color:"#2ecc71",border:"1px solid #1a4a2a",padding:"2px 7px",borderRadius:2}}>SAVED</div>
                      </div>
                      <MD text={a.text}/>
                    </div>
                  );
                })()}
              </>
            )}
            <div style={{height:20}}/>
          </div>
        )}

        {/* ══ PATTERNS ═════════════════════════════════════════════════════════ */}
        {tab==="patterns"&&(
          <div style={{padding:"12px 14px"}}>
            <div style={{display:"flex",gap:5,marginBottom:12}}>
              {[["current","Current"],["saved","Saved"],["compare","Compare"]].map(([id,lbl])=>(
                <button key={id} onClick={()=>setPSV(id)} style={{flex:1,padding:"7px 4px",background:patSubView===id?"#0d2a4a":"#0d1929",border:`1px solid ${patSubView===id?B:BDR}`,color:patSubView===id?B:D,fontFamily:"Space Mono, monospace",fontSize:"0.56rem",cursor:"pointer",borderRadius:3}}>{lbl}</button>
              ))}
            </div>
            {patSubView==="current"&&(
              <div>
                <div style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"12px",marginBottom:12}}>
                  <button onClick={handleSynthesize} disabled={analyzedCount<2||loading} style={{width:"100%",padding:"12px",fontSize:"0.7rem",fontFamily:"Space Mono, monospace",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",background:analyzedCount>=2&&!loading?"#0d2a4a":"#0a1520",color:analyzedCount>=2&&!loading?B:"#2a3a4a",border:`1px solid ${analyzedCount>=2&&!loading?B:BDR}`,cursor:analyzedCount>=2&&!loading?"pointer":"not-allowed",borderRadius:3}}>
                    {loading?"SYNTHESIZING…":"◈ RUN PATTERN SYNTHESIS"}
                  </button>
                  {analyzedCount<2&&<div style={{fontSize:"0.56rem",textAlign:"center",marginTop:5,color:"#2a3a4a"}}>Analyze {2-analyzedCount} more region{2-analyzedCount!==1?"s":""} first</div>}
                </div>
                {patternText&&(
                  <>
                    <div style={{background:"#060c18",border:`1px solid ${BDR}`,borderRadius:4,padding:"10px 12px",marginBottom:12}}>
                      <input type="text" value={patName} onChange={e=>setPatName(e.target.value)} placeholder={`Pattern Set ${new Date().toLocaleDateString()}`}
                        style={{width:"100%",padding:"8px 10px",background:"#0d1929",border:`1px solid ${BDR}`,color:"#a8c0d6",fontFamily:"Space Mono, monospace",fontSize:"0.62rem",borderRadius:3,marginBottom:7,outline:"none"}}/>
                      <div style={{display:"flex",gap:7}}>
                        <button onClick={handleSavePat} style={{flex:1,padding:"9px",background:"#0d1f0d",border:"1px solid #2a6a2a",color:"#2ecc71",fontFamily:"Space Mono, monospace",fontSize:"0.6rem",fontWeight:700,cursor:"pointer",borderRadius:3}}>↓ SAVE + DOWNLOAD .MD</button>
                        <button onClick={()=>setConfirm({what:"clearPat"})} style={{padding:"9px 10px",background:"transparent",border:"1px solid #3a1010",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.56rem",cursor:"pointer",borderRadius:3}}>✕</button>
                      </div>
                    </div>
                    <MD text={patternText}/>
                  </>
                )}
                {!patternText&&!loading&&<div style={{textAlign:"center",padding:"40px 20px",color:BDR}}><div style={{fontSize:"3rem",marginBottom:8}}>◈</div><div style={{fontSize:"0.58rem",color:"#2a3a4a"}}>No pattern synthesized yet</div></div>}
              </div>
            )}
            {patSubView==="saved"&&(
              <div>
                <div style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"10px 12px",marginBottom:12}}>
                  <input ref={fileInputRef} type="file" accept=".md,.txt" style={{display:"none"}} onChange={handleFileLoad}/>
                  <button onClick={()=>fileInputRef.current?.click()} style={{width:"100%",padding:"9px",background:"#0d1929",border:`1px solid ${BDR}`,color:B,fontFamily:"Space Mono, monospace",fontSize:"0.6rem",cursor:"pointer",borderRadius:3}}>↑ LOAD .MD FILE</button>
                </div>
                {savedPats.length===0?(
                  <div style={{textAlign:"center",padding:"40px 20px",color:BDR}}><div style={{fontSize:"2rem",marginBottom:8}}>◎</div><div style={{fontSize:"0.58rem",color:"#2a3a4a"}}>No saved pattern sets yet</div></div>
                ):savedPats.map(p=>(
                  <div key={p.id} style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"11px",marginBottom:9}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:7}}>
                      <div><div style={{fontSize:"0.72rem",fontWeight:600,color:LT}}>{p.name}</div><div style={{fontSize:"0.54rem",color:D,marginTop:1}}>{p.regionCount} regions · {new Date(p.timestamp).toLocaleDateString()}</div></div>
                      <button onClick={()=>setConfirm({what:"delPat",id:p.id})} style={{padding:"3px 7px",background:"transparent",border:"1px solid #3a1010",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.5rem",cursor:"pointer",borderRadius:2}}>✕</button>
                    </div>
                    <div style={{display:"flex",gap:5}}>
                      <button onClick={()=>dlMd(`auscan-${p.name.replace(/\s+/g,"-").toLowerCase()}.md`,patternToMd(p.name,p.text,p.regionCount,p.timestamp))} style={{flex:1,padding:"7px",background:"#0d1929",border:`1px solid ${BDR}`,color:D,fontFamily:"Space Mono, monospace",fontSize:"0.52rem",cursor:"pointer",borderRadius:3}}>↓ DOWNLOAD</button>
                      <button onClick={()=>{setPat(p.text);ss(SK.patterns,p.text);setPSV("current");}} style={{flex:1,padding:"7px",background:"#0d1f35",border:`1px solid ${B}`,color:B,fontFamily:"Space Mono, monospace",fontSize:"0.52rem",cursor:"pointer",borderRadius:3}}>← SET ACTIVE</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {patSubView==="compare"&&(()=>{
              const opts=[patternText?{id:"current",name:"Current Pattern Set"}:null,...savedPats.map(p=>({id:p.id,name:p.name}))].filter(Boolean);
              const aD=compareA==="current"?{name:"Current",text:patternText}:savedPats.find(p=>p.id===compareA);
              const bD=compareB==="current"?{name:"Current",text:patternText}:savedPats.find(p=>p.id===compareB);
              return(
                <div>
                  <div style={{display:"flex",gap:7,marginBottom:12}}>
                    {[["A",compareA,setCmpA],["B",compareB,setCmpB]].map(([lbl,val,setFn])=>(
                      <div key={lbl} style={{flex:1}}>
                        <div style={{fontSize:"0.52rem",color:D,marginBottom:4,textTransform:"uppercase"}}>Set {lbl}</div>
                        <select value={val||""} onChange={e=>setFn(e.target.value||null)} style={{width:"100%",padding:"7px",background:"#0d1929",border:`1px solid ${BDR}`,color:"#a8c0d6",fontFamily:"Space Mono, monospace",fontSize:"0.58rem",borderRadius:3}}>
                          <option value="">— select —</option>
                          {opts.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                  {aD&&bD?(
                    <div style={{display:"flex",gap:8}}>
                      {[aD,bD].map((d,i)=>(
                        <div key={i} style={{flex:1,background:"#060c18",border:`1px solid ${BDR}`,borderRadius:4,padding:10,overflowY:"auto",maxHeight:450}}>
                          <div style={{fontSize:"0.62rem",color:G,fontWeight:700,marginBottom:8}}>{d.name}</div>
                          <MD text={d.text}/>
                        </div>
                      ))}
                    </div>
                  ):<div style={{textAlign:"center",padding:"40px 20px",color:BDR,fontSize:"0.58rem"}}>Select two pattern sets to compare</div>}
                </div>
              );
            })()}
            <div style={{height:20}}/>
          </div>
        )}

        {/* ══ SEARCH ════════════════════════════════════════════════════════════ */}
        {tab==="search"&&(
          <div style={{padding:"12px 14px"}}>
            <div style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"12px",marginBottom:12}}>
              <div style={{fontSize:"0.7rem",color:LT,marginBottom:10,fontWeight:600}}>Region Prospectivity Search</div>
              <div style={{marginBottom:8}}>
                <div style={{fontSize:"0.52rem",color:D,marginBottom:4,textTransform:"uppercase"}}>Pattern Set</div>
                <select value={searchPat} onChange={e=>setSearchPat(e.target.value)} style={{width:"100%",padding:"7px",background:"#0d1929",border:`1px solid ${BDR}`,color:"#a8c0d6",fontFamily:"Space Mono, monospace",fontSize:"0.6rem",borderRadius:3}}>
                  {patternText&&<option value="current">Current Pattern Set ({analyzedCount} regions)</option>}
                  {savedPats.map(p=><option key={p.id} value={p.id}>{p.name} ({p.regionCount} regions)</option>)}
                  {!patternText&&!savedPats.length&&<option value="">— run synthesis first —</option>}
                </select>
              </div>
              <div style={{marginBottom:8}}>
                <div style={{fontSize:"0.52rem",color:D,marginBottom:4,textTransform:"uppercase"}}>Location</div>
                <input type="text" value={searchQ} onChange={e=>setSearchQ(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")handleSearch();}}
                  placeholder="City, region, ZIP, or coordinates"
                  style={{width:"100%",padding:"8px 10px",background:"#0d1929",border:`1px solid ${BDR}`,color:"#a8c0d6",fontFamily:"Space Mono, monospace",fontSize:"0.62rem",borderRadius:3,outline:"none"}}/>
              </div>
              <div style={{display:"flex",gap:12,marginBottom:10}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><div style={{fontSize:"0.52rem",color:D,textTransform:"uppercase"}}>Radius</div><div style={{fontSize:"0.58rem",color:G}}>{searchR}mi</div></div>
                  <input type="range" min={10} max={100} step={5} value={searchR} onChange={e=>setSearchR(Number(e.target.value))} style={{width:"100%"}}/>
                </div>
              </div>
              <div style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><div style={{fontSize:"0.52rem",color:D,textTransform:"uppercase"}}>Grid</div><div style={{fontSize:"0.58rem",color:G}}>{searchN}×{searchN} = {searchN*searchN} pts</div></div>
                <div style={{display:"flex",gap:5}}>
                  {[[2,"4"],[3,"9"],[4,"16"],[5,"25"]].map(([n,lbl])=>(
                    <button key={n} onClick={()=>setSearchN(n)} style={{flex:1,padding:"7px 3px",background:searchN===n?"#0d2a4a":"#0d1929",border:`1px solid ${searchN===n?B:BDR}`,color:searchN===n?B:D,fontFamily:"Space Mono, monospace",fontSize:"0.52rem",cursor:"pointer",borderRadius:3,textAlign:"center"}}>
                      {n}×{n}<br/><span style={{fontSize:"0.45rem",color:searchN===n?B:"#2a4a6a"}}>{lbl} pts</span>
                    </button>
                  ))}
                </div>
              </div>
              {searchActive?(
                <div>
                  <div style={{fontSize:"0.55rem",color:D,marginBottom:6,textAlign:"center"}}>{searchProg.current}/{searchProg.total} points scored</div>
                  <div style={{height:3,background:"#0d1929",borderRadius:2,overflow:"hidden",marginBottom:7}}>
                    <div style={{height:"100%",width:`${searchProg.total>0?(searchProg.current/searchProg.total)*100:0}%`,background:G,transition:"width 0.4s"}}/>
                  </div>
                </div>
              ):(()=>{
                const noPattern=!patternText&&!savedPats.length;
                const noQuery=!searchQ.trim();
                const isDisabled=loading||noPattern||noQuery;
                const reason=loading?"Scan in progress…":noPattern?"Run Pattern Synthesis first":noQuery?"Enter a location above":"";
                return(
                  <div>
                    <button onClick={handleSearch} disabled={isDisabled}
                      style={{width:"100%",padding:"13px",fontSize:"0.75rem",fontFamily:"Space Mono, monospace",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",background:isDisabled?"#2a3a4a":`linear-gradient(135deg,${G},#e8c84a)`,color:isDisabled?D:"#050b14",border:"none",cursor:isDisabled?"not-allowed":"pointer",borderRadius:4}}>
                      ◉ SCAN REGION
                    </button>
                    {reason&&<div style={{fontSize:"0.52rem",color:"#4a7a9b",textAlign:"center",marginTop:5}}>⚠ {reason}</div>}
                    {searchError&&<div style={{fontSize:"0.58rem",color:"#ff6b6b",marginTop:6,padding:"6px 10px",background:"#1a0808",border:"1px solid #3a1010",borderRadius:3}}>{searchError}</div>}
                  </div>
                );
              })()}
            </div>

            {/* Search history nav */}
            {searchHistory.length>0&&(
              <div style={{marginBottom:12}}>
                <div style={{fontSize:"0.52rem",color:D,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Search History ({searchHistory.length})</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                  {searchHistory.map(h=>(
                    <button key={h.id} onClick={()=>setActiveSearchId(h.id)} style={{padding:"5px 9px",fontFamily:"Space Mono, monospace",fontSize:"0.52rem",background:activeSearchId===h.id?"#0d2a4a":"#0d1929",border:`1px solid ${activeSearchId===h.id?B:BDR}`,color:activeSearchId===h.id?B:D,cursor:"pointer",borderRadius:3}}>
                      {h.query.slice(0,18)}{h.query.length>18?"…":""}<br/>
                      <span style={{fontSize:"0.44rem",color:"#2a4a6a"}}>{new Date(h.timestamp).toLocaleDateString()} · {h.results?.filter(r=>r.score>=50).length||0} hits</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {searchCtr&&activeSearchId&&(()=>{
              const h=searchHistory.find(x=>x.id===activeSearchId);
              return h?<div style={{background:"#060c18",border:`1px solid ${BDR}`,borderRadius:3,padding:"7px 10px",marginBottom:10,fontSize:"0.55rem",color:D}}><span style={{color:G}}>CENTER: </span>{h.center?.lat?.toFixed(4)}°, {h.center?.lon?.toFixed(4)}° · {h.center?.display?.split(",").slice(0,3).join(",")}</div>:null;
            })()}

            {displayRes.length>0&&(
              <>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9}}>
                  <div style={{fontSize:"0.57rem",color:D}}>{displayRes.length} pts · {displayRes.filter(r=>r.score>=50).length} high-confidence</div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>dlMd(`auscan-hits-${searchQ.replace(/\s+/g,"-").toLowerCase()}.md`,targetsToMd(displayRes.filter(r=>r.score>=40),searchQ,getSearchPatName()))} style={{padding:"4px 7px",background:"#0d1f0d",border:"1px solid #2a6a2a",color:"#2ecc71",fontFamily:"Space Mono, monospace",fontSize:"0.5rem",cursor:"pointer",borderRadius:2}}>↓ HITS</button>
                    <button onClick={()=>dlMd(`auscan-all.md`,targetsToMd(displayRes,searchQ,getSearchPatName()))} style={{padding:"4px 7px",background:"#0d1929",border:`1px solid ${BDR}`,color:D,fontFamily:"Space Mono, monospace",fontSize:"0.5rem",cursor:"pointer",borderRadius:2}}>↓ ALL</button>
                  </div>
                </div>
                {/* Score grid */}
                <div style={{background:"#060c18",border:`1px solid ${BDR}`,borderRadius:4,padding:9,marginBottom:12}}>
                  <div style={{fontSize:"0.52rem",color:D,marginBottom:5,textTransform:"uppercase"}}>Score Grid</div>
                  <div style={{display:"grid",gridTemplateColumns:`repeat(${searchN},1fr)`,gap:3}}>
                    {Array.from({length:searchN}).map((_,row)=>Array.from({length:searchN}).map((_,col)=>{
                      const pt=displayRes.find(r=>r.row===row&&r.col===col);
                      const s=pt?.score??-1;
                      return <div key={`${row}-${col}`} style={{background:s>=75?"#2a1500":s>=50?"#1a1200":s>=30?"#0d1929":"#0a0f1a",border:`1px solid ${s>=50?"#c9a227":"#0d1929"}`,borderRadius:2,padding:"5px 2px",textAlign:"center"}}>
                        <div style={{fontSize:"0.68rem",fontWeight:700,color:s>=75?"#f0a500":s>=50?"#c9a227":s>=30?"#4a7a9b":"#2a3a4a"}}>{s>=0?s:"…"}</div>
                      </div>;
                    }))}
                  </div>
                </div>
                {displayRes.filter(r=>r.score>0).map((r,i)=>{
                  const ptKey=`${r.row}-${r.col}`;
                  const mrds=mrdsByPoint[ptKey];
                  return (
                  <div key={`${r.row}-${r.col}-${i}`} style={{background:GRADE_B[r.grade]||"#050b14",border:`1px solid ${r.score>=50?"#c9a227":"#0d1929"}`,borderRadius:4,padding:"10px 12px",marginBottom:9}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:5}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:7}}>
                          <div style={{fontSize:"0.88rem",fontWeight:700,color:GRADE_C[r.grade]||D}}>{r.score}%</div>
                          <div style={{fontSize:"0.55rem",color:GRADE_C[r.grade]||D,border:`1px solid ${GRADE_C[r.grade]||BDR}`,padding:"1px 5px",borderRadius:2}}>{r.grade?.replace("_"," ")}</div>
                          {r.dataSources?.length>1&&<div style={{fontSize:"0.45rem",color:"#2a6a4a",border:"1px solid #1a4a2a",padding:"1px 4px",borderRadius:2}}>{r.dataSources.length} sensors</div>}
                        </div>
                        <div style={{fontSize:"0.55rem",color:D,marginTop:1}}>{r.lat?.toFixed(5)}°, {r.lon?.toFixed(5)}°</div>
                        <div style={{fontSize:"0.52rem",color:"#2a4a6a"}}>Anomaly: {r.anomalyRadius} · Conf: {r.confidence}</div>
                        {r.mineralSignature&&<div style={{fontSize:"0.52rem",color:"#4a9a4a",marginTop:2}}>Mineral: {r.mineralSignature}</div>}
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end"}}>
                        <button onClick={()=>handleSaveTarget(r)} style={{padding:"4px 7px",background:"#0d1f0d",border:"1px solid #2a6a2a",color:"#2ecc71",fontFamily:"Space Mono, monospace",fontSize:"0.48rem",cursor:"pointer",borderRadius:2}}>SAVE</button>
                        <a href={`https://maps.google.com/@${r.lat?.toFixed(5)},${r.lon?.toFixed(5)},14z/data=!3m1!1e3`} target="_blank" rel="noopener noreferrer" style={{padding:"4px 7px",background:"#0d1929",border:`1px solid ${BDR}`,color:B,fontFamily:"Space Mono, monospace",fontSize:"0.48rem",textDecoration:"none",borderRadius:2}}>MAPS ↗</a>
                      </div>
                    </div>
                    <div style={{fontSize:"0.58rem",color:"#a8c0d6",marginBottom:4,lineHeight:1.5}}>{r.keyObservation}</div>
                    {r.matchedFeatures?.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>{r.matchedFeatures.map((f,j)=><span key={j} style={{fontSize:"0.48rem",color:"#2a6a2a",background:"#0d1f0d",border:"1px solid #1a4a2a",padding:"1px 5px",borderRadius:8}}>{f}</span>)}</div>}
                    {r.missingFeatures?.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:6}}>{r.missingFeatures.map((f,j)=><span key={j} style={{fontSize:"0.48rem",color:"#7a3a3a",background:"#1a0d0d",border:"1px solid #3a1010",padding:"1px 5px",borderRadius:8}}>{f}</span>)}</div>}
                    <SatImg lat={r.lat} lon={r.lon} zoom={13}/>

                    {/* MRDS Lookup */}
                    <div style={{marginTop:8,borderTop:`1px solid ${BDR}`,paddingTop:8}}>
                      {!mrds&&(
                        <button onClick={()=>handleMRDSLookup(r.lat,r.lon,ptKey)}
                          style={{width:"100%",padding:"7px",background:"#0a1929",border:`1px solid #1e3a5f`,color:"#4a7a9b",fontFamily:"Space Mono, monospace",fontSize:"0.55rem",cursor:"pointer",borderRadius:3,letterSpacing:"0.06em"}}>
                          ◎ CHECK USGS MRDS — Historic Claims &amp; Mining Districts
                        </button>
                      )}
                      {mrds?.status==='loading'&&(
                        <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0"}}>
                          <div style={{width:6,height:6,borderRadius:"50%",background:G,animation:"pulse 1s infinite"}}/>
                          <span style={{fontSize:"0.55rem",color:D}}>Querying MRDS records…</span>
                        </div>
                      )}
                      {mrds?.status==='done'&&(
                        <div style={{background:"#060c18",border:`1px solid ${BDR}`,borderRadius:3,padding:"8px 10px"}}>
                          <div style={{fontSize:"0.52rem",color:G,letterSpacing:"0.08em",marginBottom:6,textTransform:"uppercase"}}>USGS MRDS — Historic Claims &amp; Districts</div>
                          <MD text={mrds.text}/>
                        </div>
                      )}
                      {mrds?.status==='error'&&(
                        <div style={{fontSize:"0.52rem",color:"#ff6b6b",padding:"4px 0"}}>{mrds.text}</div>
                      )}
                    </div>
                  </div>
                );})}
              </>
            )}

            {targets.length>0&&(
              <div style={{marginTop:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                  <div style={{fontSize:"0.57rem",color:D,textTransform:"uppercase"}}>{targets.length} Saved Target{targets.length!==1?"s":""}</div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>dlMd("auscan-all-targets.md",targetsToMd(targets,"All","Various"))} style={{padding:"4px 7px",background:"#0d1f0d",border:"1px solid #2a6a2a",color:"#2ecc71",fontFamily:"Space Mono, monospace",fontSize:"0.5rem",cursor:"pointer",borderRadius:2}}>↓ EXPORT</button>
                    <button onClick={()=>setConfirm({what:"clearTargets"})} style={{padding:"4px 7px",background:"transparent",border:"1px solid #3a1010",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.5rem",cursor:"pointer",borderRadius:2}}>✕</button>
                  </div>
                </div>
                {targets.map(t=>(
                  <div key={t.id} style={{background:"#060c18",border:`1px solid ${t.score>=50?"#2a4a1a":"#0d1929"}`,borderRadius:3,padding:"8px 10px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontSize:"0.62rem",color:GRADE_C[t.grade]||D,fontWeight:600}}>{t.score}% · {t.grade?.replace("_"," ")}</div>
                      <div style={{fontSize:"0.55rem",color:D}}>{t.lat?.toFixed(5)}°, {t.lon?.toFixed(5)}°</div>
                      <div style={{fontSize:"0.5rem",color:"#2a4a6a"}}>{t.searchQuery} · {new Date(t.savedAt).toLocaleDateString()}</div>
                    </div>
                    <a href={`https://maps.google.com/@${t.lat?.toFixed(5)},${t.lon?.toFixed(5)},14z/data=!3m1!1e3`} target="_blank" rel="noopener noreferrer" style={{padding:"5px 7px",background:"#0d1929",border:`1px solid ${BDR}`,color:B,fontFamily:"Space Mono, monospace",fontSize:"0.5rem",textDecoration:"none",borderRadius:2}}>MAPS ↗</a>
                  </div>
                ))}
              </div>
            )}
            <div style={{height:20}}/>
          </div>
        )}

        {/* ══ SETTINGS ══════════════════════════════════════════════════════════ */}
        {tab==="settings"&&(
          <div style={{padding:"12px 14px"}}>
            <div style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"12px",marginBottom:14}}>
              <div style={{fontSize:"0.72rem",color:LT,marginBottom:4,fontWeight:600}}>NASA Earthdata Token</div>
              <div style={{fontSize:"0.58rem",color:D,marginBottom:10,lineHeight:1.6}}>
                Unlocks EMIT L2B mineral data, Landsat C2, and ASTER via NASA CMR. Free account: urs.earthdata.nasa.gov
                <span style={{color:"#f0a500"}}> Session only — never saved to storage.</span>
              </div>
              <div style={{position:"relative",marginBottom:8}}>
                <input type={tokenVis?"text":"password"} value={nasaToken} onChange={e=>setNasaToken(e.target.value)}
                  placeholder="Paste NASA Earthdata Bearer token"
                  style={{width:"100%",padding:"9px 38px 9px 10px",background:"#0d1929",border:`1px solid ${nasaToken?"#2a6a2a":BDR}`,color:"#a8c0d6",fontFamily:"Space Mono, monospace",fontSize:"0.6rem",borderRadius:3,outline:"none"}}/>
                <button onClick={()=>setTokenVis(v=>!v)} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",color:D,cursor:"pointer",fontSize:"0.7rem",padding:0}}>{tokenVis?"●":"○"}</button>
              </div>
              {nasaToken?(
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:"#2ecc71"}}/>
                  <div style={{fontSize:"0.55rem",color:"#2ecc71"}}>Token active · EMIT + Landsat + ASTER enabled</div>
                  <button onClick={()=>setNasaToken("")} style={{marginLeft:"auto",padding:"3px 7px",background:"transparent",border:"1px solid #3a1010",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.48rem",cursor:"pointer",borderRadius:2}}>CLEAR</button>
                </div>
              ):(
                <div style={{fontSize:"0.55rem",color:D}}>No token — CMR uses public access (limited data)</div>
              )}
            </div>

            <div style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"12px",marginBottom:14}}>
              <div style={{fontSize:"0.72rem",color:LT,marginBottom:4,fontWeight:600}}>Data Sources</div>
              {[
                ["gibs","GIBS MODIS False Color","SWIR/NIR false color. Free, no auth — but NASA rate-limits after 1–2 requests. Disabled by default to prevent scan hangs. Enable only for single test scans.","free"],
                ["emit","NASA EMIT L2B Mineralogy","Hyperspectral mineral identification from ISS. 285 spectral bands. Token recommended.","token"],
                ["landsat","Landsat OLI-TIRS C2","Clay + iron oxide band ratios. Token for best coverage.","token"],
                ["aster","ASTER Surface Reflectance","14-band including thermal IR. Gold standard for surface mineralogy.","token"],
                ["sentinel","Sentinel-2 L2A","10m resolution multispectral. Free public STAC. No token needed.","free"],
              ].map(([key,name,desc,auth])=>(
                <div key={key} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 0",borderBottom:`1px solid ${BDR}`}}>
                  <button onClick={()=>setEnabledSrc(prev=>({...prev,[key]:!prev[key]}))} style={{width:36,height:22,flexShrink:0,background:enabledSrc[key]?"#0d2a0d":"#0d1929",border:`1px solid ${enabledSrc[key]?"#2a6a2a":BDR}`,borderRadius:11,cursor:"pointer",position:"relative",transition:"all 0.2s"}}>
                    <div style={{width:16,height:16,borderRadius:"50%",background:enabledSrc[key]?"#2ecc71":"#2a3a4a",position:"absolute",top:2,left:enabledSrc[key]?16:2,transition:"left 0.2s"}}/>
                  </button>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                      <div style={{fontSize:"0.65rem",fontWeight:600,color:enabledSrc[key]?LT:D}}>{name}</div>
                      <span style={{fontSize:"0.45rem",padding:"1px 5px",borderRadius:2,background:auth==="free"?"#0d1f0d":"#1a1200",border:`1px solid ${auth==="free"?"#2a6a2a":"#4a3000"}`,color:auth==="free"?"#2ecc71":"#f0a500"}}>{auth==="free"?"FREE":"TOKEN"}</span>
                    </div>
                    <div style={{fontSize:"0.55rem",color:"#3a5a7a",lineHeight:1.5}}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{background:PNL,border:`1px solid ${BDR}`,borderRadius:4,padding:"12px",marginBottom:14}}>
              <div style={{fontSize:"0.72rem",color:LT,marginBottom:6,fontWeight:600}}>Error Recovery</div>
              <div style={{fontSize:"0.58rem",color:D,lineHeight:1.7}}>
                All external API calls time out at 8 seconds to prevent freezes. Scan failures retry 3× with exponential backoff (4s → 6.4s → 10s). Skipped items auto-retry after the main pass. The progress bar shows exact step + percentage throughout each scan.
              </div>
            </div>

            <div style={{background:"#0a0808",border:"1px solid #2a1010",borderRadius:4,padding:"12px"}}>
              <div style={{fontSize:"0.68rem",color:"#ff6b6b",marginBottom:8,fontWeight:600}}>Danger Zone</div>
              <div style={{display:"flex",gap:7}}>
                <button onClick={()=>setConfirm({what:"clearAn"})} style={{flex:1,padding:"9px",background:"transparent",border:"1px solid #3a1010",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.55rem",cursor:"pointer",borderRadius:3}}>CLEAR ANALYSES</button>
                <button onClick={async()=>{setPat("");setSavedPats([]);setTargets([]);setAn({});setScanStatus({});setSearchHistory([]);await Promise.all([sd(SK.analyses),sd(SK.patterns),sd(SK.savedPatterns),sd(SK.targets),sd(SK.searchHistory)]);}} style={{flex:1,padding:"9px",background:"#3a0808",border:"1px solid #7a1010",color:"#ff6b6b",fontFamily:"Space Mono, monospace",fontSize:"0.55rem",fontWeight:700,cursor:"pointer",borderRadius:3}}>CLEAR ALL DATA</button>
              </div>
            </div>
            <div style={{height:20}}/>
          </div>
        )}
      </div>

      {/* FOOTER */}
      <div style={{background:PNL,borderTop:`1px solid ${BDR}`,padding:"5px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
        <span style={{fontSize:"0.48rem",color:"#2a4a6a"}}>ESRI · GIBS · CMR · STAC · PERSISTED</span>
        <span style={{fontSize:"0.48rem",color:nasaToken?"#2a6a4a":"#2a3a4a"}}>{nasaToken?"NASA TOKEN ACTIVE":"NO NASA TOKEN"}</span>
      </div>
    </div>
  );
}
