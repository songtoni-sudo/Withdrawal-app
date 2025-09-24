// v1.9.0 – Guardrails enligt User Guide
const KEY='uttags_config_v19';
const state={ hicpLatest:null, hicpPeriod:'', proposedReal:null };

const fmtLocale = (v,d=0)=> isFinite(v)? new Intl.NumberFormat(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}).format(v):'—';
const fmtEUR = (v,d=0)=> isFinite(v)? `${fmtLocale(v,d)} €`:'—';
const fmtPct = (x,d=1)=> `${(x*100).toFixed(d).replace('.',',')} %`;
const parseCurrency=s=>{ if(typeof s!=='string') return Number(s)||0; s=s.replace(/[^0-9,.-]/g,'').replace(/\s/g,''); if(s.count){} if(s.count){}
  if(s.count){}; if(s.includes(',')&&s.includes('.')){const i=s.lastIndexOf(','); return Number(s.slice(0,i).replace(/[.,]/g,'')+'.'+s.slice(i+1).replace(/[^0-9]/g,''))||0;}
  if(s.includes(',')) return Number(s.replace('.', '').replace(',', '.'))||0; return Number(s)||0; };
const Q=id=>document.getElementById(id);

// ====== defaults & storage
function def(){ return {
  // Core
  normalReal:6600, currentReal:6600,
  iskNom:0, peakNom:0, birth:'1976-01-01',
  // Cadence & autos
  cadence:'m', autoPeak:'on', autoSync:'off',
  // HICP/CPI
  inflType:'hicp', country:'ES', hicpBase:126.88, hicpManual:'',
  // Guardrails profile
  profile:'balanced', bandsMode:'bands',
  // Custom band multipliers (procent 0–100)
  customMul:[90,80,70,60,50],
  // Softeners
  inflPause:'on', maxChangePct:10, floorReal:0,
  // Remote
  remoteUrl:'', remoteFirst:'off',
  // History
  histStartYM:'2025-08', hist:[],
  // Targets
  wrTarget:null,
  lastChangeTs:'', lastRealLevel:6600,
};}
function migrate(cfg){
  const d=def();
  return {...d, ...(cfg||{})};
}
function load(){ try{ return migrate(JSON.parse(localStorage.getItem(KEY)||'null')); }catch{ return def(); } }
function save(c){ localStorage.setItem(KEY, JSON.stringify(c)); }

// ====== HICP (ECB SDMX)
async function fetchHICP(country='ES'){
  try{
    const q=encodeURIComponent(`https://sdw-wsrest.ecb.europa.eu/service/data/ICP/M.${country}.N.000000.4.INX?lastNObservations=36&detail=dataonly&format=jsondata`);
    const url=`https://api.allorigins.win/raw?url=${q}`;
    const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw 0;
    const d=await r.json();
    const obsDim=(d.structure.dimensions.observation||[])[0]; const times=(obsDim&&obsDim.values)?obsDim.values:[];
    const seriesKey=Object.keys(d.dataSets[0].series)[0]; const obs=d.dataSets[0].series[seriesKey].observations;
    const idxs=Object.keys(obs).map(k=>parseInt(k,10)).sort((a,b)=>a-b); const lastIdx=idxs[idxs.length-1];
    const val=Number(obs[lastIdx][0]); const period=(times[lastIdx]&&(times[lastIdx].id||times[lastIdx].name))||'';
    return {value:val, period};
  }catch(e){ return null; }
}

// ====== math helpers
const guardrailIndex = dd => dd<0.10?0 : dd<0.20?1 : dd<0.30?2 : dd<0.40?3 : 4;
function profileBands(profile){
  // return multipliers in percent at 10/20/30/40/50 (right-edge of each band)
  if(profile==='aggressive') return [87.5,75,62.5,50,40];
  if(profile==='conservative') return [92.5,85,77.5,70,65];
  // balanced default
  return [90,80,70,60,50];
}
function linearMultiplier(profile, d){
  // Power user linear rules with floors
  if(profile==='aggressive'){ const m=1-1.25*d; return Math.max(m,0.40); }
  if(profile==='conservative'){ return 1-0.75*d; }
  return 1-d; // balanced
}
function multiplierFrom(cfg, dd){
  if(cfg.profile==='custom'){
    const arr=cfg.customMul||[90,80,70,60,50];
    const idx=guardrailIndex(dd); return (arr[idx]||arr[arr.length-1])/100;
  }
  if(cfg.bandsMode==='linear'){
    return linearMultiplier(cfg.profile, dd);
  }else{
    const arr=profileBands(cfg.profile);
    const idx=guardrailIndex(dd);
    return (arr[idx])/100;
  }
}
function AF(n,rm){ return rm<=0? n : (1-Math.pow(1+rm,-n))/rm; }
function computeFR(cfg, realMonthly){
  const now=new Date(); const [Y,M,D]=cfg.birth.split('-').map(Number); const b=new Date(Y,M-1,D);
  const age=(now-b)/(365.2425*24*3600*1000); const mLeft=Math.max(0, Math.round((90-age)*12));
  const rm=Math.pow(1+0.047,1/12)-1; // 4,7 % real antagande
  const PV_need=realMonthly*AF(mLeft,rm);
  const PV=cfg.iskNom; // enkel FR (utan pensioner här)
  return {FR: PV_need>0? PV/PV_need:0};
}
function withdrawalRate(monthly, portfolioNow){ return portfolioNow>0? (12*monthly)/portfolioNow : Infinity; }

// ====== history helpers
function ymOfClosedMonth(d=new Date()){ const dt=new Date(d.getFullYear(), d.getMonth(), 1); dt.setMonth(dt.getMonth()-1); return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`; }
function ymToDate(ym){ const [y,m]=ym.split('-').map(Number); return new Date(y,m-1,1); }
function ensureHistoryAndMaybeAppend(cfg){
  if(!cfg.histStartYM) cfg.histStartYM='2025-08';
  if(!Array.isArray(cfg.hist)) cfg.hist=[];
  const closed=ymOfClosedMonth(); const start=cfg.histStartYM;
  if(ymToDate(closed) < ymToDate(start)) return;
  const lastYM=cfg.hist.length?cfg.hist[cfg.hist.length-1].ym:null;
  if(!lastYM){ cfg.hist.push({ym:start, isk:cfg.iskNom, peak:cfg.peakNom}); }
  if(cfg.hist[cfg.hist.length-1].ym !== closed){
    let cur=ymToDate(cfg.hist[cfg.hist.length-1].ym);
    while(true){
      cur.setMonth(cur.getMonth()+1);
      const ym=`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}`;
      if(ym>closed) break;
      cfg.hist.push({ym, isk:cfg.iskNom, peak:cfg.peakNom});
      if(ym===closed) break;
    }
  }else{
    const p=cfg.hist[cfg.hist.length-1]; p.isk=cfg.iskNom; p.peak=cfg.peakNom;
  }
  save(cfg);
  const meta = cfg.hist.length? `${cfg.hist[0].ym} → ${cfg.hist[cfg.hist.length-1].ym} · ${cfg.hist.length} mån` : '—';
  Q('hist-meta').textContent=meta;
}
function drawHistory(cfg){
  const cvs=Q('hist-canvas'); const ctx=cvs.getContext('2d');
  const dpr=window.devicePixelRatio||1; const W=cvs.clientWidth*dpr,H=cvs.clientHeight*dpr;
  if(cvs.width!==W) cvs.width=W; if(cvs.height!==H) cvs.height=H;
  ctx.clearRect(0,0,W,H);
  const padL=80*dpr,padR=20*dpr,padT=26*dpr,padB=36*dpr;
  const data=cfg.hist||[]; if(!data.length){ ctx.fillStyle='#5f7a94'; ctx.font=`${12*dpr}px -apple-system,Segoe UI,Roboto`; ctx.fillText('Ingen historik ännu.',16*dpr,24*dpr); return; }
  const xs=data.map(d=>d.ym); const ys1=data.map(d=>d.isk||0), ys2=data.map(d=>d.peak||0);
  const yMax=Math.max(1, Math.max(...ys1,...ys2)); const yMin=0;
  // grid
  ctx.strokeStyle='rgba(6,148,240,.15)'; ctx.lineWidth=1*dpr;
  for(let i=0;i<=5;i++){ const y=padT+(H-padT-padB)*i/5; ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(W-padR,y); ctx.stroke(); }
  // axes
  ctx.strokeStyle='rgba(6,148,240,.40)'; ctx.lineWidth=1.5*dpr; ctx.beginPath(); ctx.moveTo(padL,padT); ctx.lineTo(padL,H-padB); ctx.lineTo(W-padR,H-padB); ctx.stroke();
  // y labels
  ctx.fillStyle='#0b3b6f'; ctx.textAlign='right'; ctx.textBaseline='middle'; ctx.font=`${12*dpr}px -apple-system,Segoe UI,Roboto`;
  for(let i=0;i<=5;i++){ const val=yMax - (yMax-yMin)*i/5; const y=padT+(H-padT-padB)*i/5; ctx.fillText(fmtLocale(Math.round(val)), padL-8*dpr, y); }
  // x labels
  ctx.fillStyle='#466079'; ctx.textAlign='center'; ctx.textBaseline='alphabetic';
  const n=xs.length, w=(W-padL-padR)/Math.max(1,n-1); for(let i=0;i<n;i++){ const x=padL+w*i; const y=H-padB+16*dpr; ctx.fillText(xs[i],x,y); }
  function plot(ys,color){ ctx.strokeStyle=color; ctx.lineWidth=2.5*dpr; ctx.beginPath();
    ys.forEach((v,i)=>{ const x=padL+w*i; const y=padT+(H-padT-padB)*(1-(v-yMin)/(yMax-yMin)); if(i==0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke(); }
  plot(ys2,'#0b3b6f'); plot(ys1,'#0aa2ff');
}

// ====== core compute & render
function computeAndRender(cfg, hicpNow){
  // Auto‑ATH
  if(cfg.autoPeak==='on' && cfg.iskNom>cfg.peakNom){ cfg.peakNom=cfg.iskNom; save(cfg); }
  const dd = (cfg.peakNom>0)? Math.max(0, 1 - cfg.iskNom/cfg.peakNom): 0;
  const {FR}=computeFR(cfg, cfg.currentReal);

  // HICP factor (för nominell visning)
  let H = 1;
  if(cfg.inflType==='hicp'){
    const base=Number(String(cfg.hicpBase).replace(',','.'))||1;
    H = (hicpNow||base)/base;
  }else{
    const man=Number((Q('inp-hicp-manual').value||'').replace(',','.'));
    const base=Number(String(cfg.hicpBase).replace(',','.'))||1;
    H = isFinite(man)&&man>0? man/base : 1;
  }

  // Guardrails multiplier
  const m = multiplierFrom(cfg, dd);
  // Föreslaget realt
  let proposed = (cfg.normalReal||0) * m;

  // Softeners
  //   Inflation pause: om (last year real return < 0) eller (WR > target at start) => höj ej
  if(cfg.inflPause==='on'){
    let negativeRealYear=false;
    // yoy real: kräver 12 mån historik
    if(cfg.hist && cfg.hist.length>=12){
      const nowISK = cfg.iskNom;
      const thenISK = cfg.hist[cfg.hist.length-12].isk||0;
      // approximera inflationskvot (om vi har HICP historik här inte hämtas, så lämna denna som portfölj-approx)
      negativeRealYear = nowISK < thenISK; // konservativ approx
    }
    // WR target
    if(!cfg.wrTarget && cfg.peakNom>0){ cfg.wrTarget = withdrawalRate(cfg.normalReal, cfg.peakNom); save(cfg); }
    const wrNow = withdrawalRate(proposed, cfg.iskNom);
    if(negativeRealYear || (cfg.wrTarget && wrNow > cfg.wrTarget)){
      proposed = Math.min(proposed, cfg.lastRealLevel||cfg.currentReal);
    }
  }
  //   Max change per review ±%
  const maxPct = (cfg.maxChangePct||0)/100;
  if(maxPct>0 && (cfg.lastRealLevel||cfg.currentReal)>0){
    const lo = (cfg.lastRealLevel||cfg.currentReal)*(1 - maxPct);
    const hi = (cfg.lastRealLevel||cfg.currentReal)*(1 + maxPct);
    proposed = Math.max(lo, Math.min(hi, proposed));
  }
  //   Spending floor (realt)
  if((cfg.floorReal||0)>0) proposed = Math.max(proposed, cfg.floorReal);

  state.proposedReal = Math.round(proposed);

  // Nominal visning
  const totalNom = state.proposedReal * H;
  const restNom = totalNom; // pensionsdel ej modellerad i denna version

  // KPI & badges
  Q('kpi-phase').textContent = `Fas ${phaseFromBirth(cfg.birth)}`;
  Q('kpi-real-current').textContent = fmtEUR(cfg.currentReal);
  Q('kpi-real-proposed').textContent = fmtEUR(state.proposedReal);
  Q('kpi-dd').textContent = fmtPct(dd,1);
  Q('kpi-fr').textContent = (FR>=1?'≥ ':'') + (FR.toFixed(2).replace('.',','));
  Q('kpi-total').textContent = fmtEUR(totalNom);
  Q('kpi-isk').textContent = fmtEUR(restNom);

  let badge='pill ok', msg='Planen är finansierad. Håll nivå.';
  if(FR<1.0){ badge='pill warn'; msg='FR < 1,0: justera enligt förslaget.'; }
  if(dd>=0.3){ badge='pill danger'; msg='Stor drawdown: tillämpa nedskalning.'; }
  const bEl=Q('badge'); bEl.className=badge; bEl.textContent=({'pill ok':'Grön','pill warn':'Gul','pill danger':'Röd'})[badge]||'—';
  Q('badge-txt').textContent = msg;
  Q('drawdown-line').textContent = `Drawdown: ${fmtPct(dd,1)} | ISK: ${fmtEUR(cfg.iskNom)} | ATH: ${fmtEUR(cfg.peakNom)}`;

  // Guardrails tabell
  renderRails(cfg, dd);

  // Cadence
  const days=(cfg.cadence==='q'?90:30);
  const canChange=(!cfg.lastChangeTs)||((new Date()-new Date(cfg.lastChangeTs))/(24*3600*1000)>=days);
  Q('commit-hint').textContent = `Cadens: ${cfg.cadence==='q'?'Kvartal (≥90 d)':'Månadsvis (≥30 d)'} · ${canChange?'Du kan ändra nu.':'Vänta tills viloperioden passerat.'}`;
  Q('btn-commit').disabled=!canChange;

  // Historik
  ensureHistoryAndMaybeAppend(cfg); drawHistory(cfg);
}
function phaseFromBirth(birth){
  const [Y,M,D]=birth.split('-').map(Number); const b=new Date(Y||1976,(M||1)-1,D||1);
  const age=(new Date()-b)/(365.2425*24*3600*1000);
  return (age<55)?1:(age<65)?2:3;
}
function renderRails(cfg, dd){
  const tb=Q('tbl-rails'); tb.innerHTML='';
  const labels=['0–10 %','10–20 %','20–30 %','30–40 %','40–50 %'];
  let arr=[];
  if(cfg.profile==='custom'){ arr=cfg.customMul; }
  else if(cfg.bandsMode==='linear'){
    const points=[0.10,0.20,0.30,0.40,0.50];
    arr = points.map(p=>Math.round(linearMultiplier(cfg.profile, p)*1000)/10);
  }else{
    arr = profileBands(cfg.profile);
  }
  const idx=guardrailIndex(dd);
  arr.forEach((v,i)=>{
    const tr=document.createElement('tr'); if(i===idx) tr.className='sel';
    const real = Math.round((cfg.normalReal||0)*(v/100));
    tr.innerHTML=`<td>${labels[i]}</td><td class="mono">${v.toString().replace('.',',')} %</td><td class="mono">${fmtEUR(real)}</td>`;
    tb.appendChild(tr);
  });
}

// ====== inputs & actions
function initInputs(cfg){
  // Settings
  Q('inp-normal').value=fmtLocale(cfg.normalReal);
  Q('inp-birth').value=cfg.birth;
  Q('inp-isk').value=fmtLocale(cfg.iskNom);
  Q('inp-peak').value=fmtLocale(cfg.peakNom);
  Q('sel-cadence').value=cfg.cadence;
  Q('sel-auto-peak').value=cfg.autoPeak;
  Q('sel-auto-sync').value=cfg.autoSync;

  // Inflation
  Q('sel-infl-type').value=cfg.inflType;
  Q('sel-country').value=cfg.country||'ES';
  Q('inp-hicp-base').value=String(cfg.hicpBase).replace('.',',');
  Q('inp-hicp-manual').value=cfg.hicpManual||'';

  // Guardrails
  Q('sel-profile').value=cfg.profile;
  Q('sel-bands-mode').value=cfg.bandsMode;
  ['m10','m20','m30','m40','m50'].forEach((id,i)=> Q(id).value=(cfg.customMul||[90,80,70,60,50])[i]);

  // Softeners
  Q('sel-infl-pause').value=cfg.inflPause;
  Q('inp-max-chg').value=cfg.maxChangePct;
  Q('inp-floor').value=fmtLocale(cfg.floorReal||0);

  // Remote & Hist
  Q('inp-remote-url').value=cfg.remoteUrl||''; Q('sel-remote-first').value=cfg.remoteFirst||'off';
  Q('inp-hist-start').value=cfg.histStartYM||'2025-08';
}
function readCurrency(id){ return parseCurrency(Q(id).value); }

// ====== main
async function main(){
  let cfg=load();
  initInputs(cfg);

  // HICP fetch/show
  let hicpNow=null;
  if(cfg.inflType==='hicp'){
    const res=await fetchHICP(cfg.country||'ES');
    if(res){ state.hicpLatest=res.value; state.hicpPeriod=res.period; Q('hicp-latest').textContent=`${res.value.toFixed(2).replace('.',',')}`; Q('hicp-date').textContent=`Period: ${res.period}`; hicpNow=res.value; }
    else { Q('hicp-latest').textContent='—'; Q('hicp-date').textContent='—'; }
  }else{
    const man=Number((Q('inp-hicp-manual').value||'').replace(',','.')); if(isFinite(man)&&man>0){ hicpNow=man; Q('hicp-latest').textContent=man.toFixed(2).replace('.',','); Q('hicp-date').textContent='Manual'; }
  }

  computeAndRender(cfg, hicpNow||cfg.hicpBase);

  // Bind: export/import
  Q('btn-export').onclick=()=>{ const blob=new Blob([JSON.stringify(load(),null,2)],{type:'application/json'}); const a=document.createElement('a'); a.download='uttags_config_v19.json'; a.href=URL.createObjectURL(blob); a.click(); URL.revokeObjectURL(a.href); };
  Q('file-import').addEventListener('change',e=>{ if(e.target.files&&e.target.files[0]){ const rd=new FileReader(); rd.onload=()=>{ try{ const obj=JSON.parse(rd.result); const merged=migrate({...load(),...obj}); save(merged); alert('Importerad. Uppdaterar…'); location.reload(); }catch{ alert('Ogiltig JSON.'); } }; rd.readAsText(e.target.files[0]); } });

  // Set to Latest
  Q('btn-set-latest').onclick=async()=>{
    const typ=Q('sel-infl-type').value;
    if(typ==='hicp'){
      const cc=Q('sel-country').value;
      const res=await fetchHICP(cc);
      if(!res){ alert('Kunde inte hämta HICP.'); return; }
      const c=load(); c.hicpBase=res.value; c.country=cc; save(c);
      Q('inp-hicp-base').value=String(res.value).replace('.',',');
      Q('hicp-latest').textContent=res.value.toFixed(2).replace('.',',');
      Q('hicp-date').textContent=`Period: ${res.period}`;
      computeAndRender(c, res.value);
      alert('HICP-bas satt till senaste.');
    }else{
      alert('Välj HICP-läge för automatisk hämtning. I manuellt läge fyll i nivån själv.');
    }
  };

  // Guardrails UI
  Q('sel-profile').onchange=()=>{ const c=load(); c.profile=Q('sel-profile').value; save(c); Q('custom-edit').hidden=(c.profile!=='custom'); computeAndRender(c, state.hicpLatest||c.hicpBase); };
  Q('sel-bands-mode').onchange=()=>{ const c=load(); c.bandsMode=Q('sel-bands-mode').value; save(c); computeAndRender(c, state.hicpLatest||c.hicpBase); };
  ['m10','m20','m30','m40','m50'].forEach((id,i)=> Q(id).addEventListener('change',()=>{ const c=load(); const vals=['m10','m20','m30','m40','m50'].map(id=> Number(Q(id).value)||0); c.customMul=vals; save(c); computeAndRender(c, state.hicpLatest||c.hicpBase); }));

  // Save
  Q('btn-save').onclick=()=>{
    const c=load();
    c.normalReal=readCurrency('inp-normal');
    c.birth=Q('inp-birth').value;
    c.iskNom=readCurrency('inp-isk');
    c.peakNom=readCurrency('inp-peak');
    c.cadence=Q('sel-cadence').value;
    c.autoPeak=Q('sel-auto-peak').value;
    c.autoSync=Q('sel-auto-sync').value;
    c.inflType=Q('sel-infl-type').value;
    c.country=Q('sel-country').value;
    c.hicpBase=parseCurrency(Q('inp-hicp-base').value.replace('.',','));
    c.hicpManual=Q('inp-hicp-manual').value;
    c.profile=Q('sel-profile').value;
    c.bandsMode=Q('sel-bands-mode').value;
    c.inflPause=Q('sel-infl-pause').value;
    c.maxChangePct=Number(Q('inp-max-chg').value)||0;
    c.floorReal=readCurrency('inp-floor');
    c.remoteUrl=(Q('inp-remote-url').value||'').trim();
    c.remoteFirst=Q('sel-remote-first').value;
    if(c.autoSync==='on') c.currentReal=c.normalReal;
    if(!c.wrTarget && c.peakNom>0) c.wrTarget=withdrawalRate(c.normalReal, c.peakNom);
    save(c);
    computeAndRender(c, state.hicpLatest||c.hicpBase);
    alert('Sparat.');
  };

  // Commit & Sync
  Q('btn-commit').onclick=()=>{
    const c=load();
    const days=(c.cadence==='q'?90:30);
    const allowed=(!c.lastChangeTs)||((new Date()-new Date(c.lastChangeTs))/(24*3600*1000)>=days);
    if(!allowed) return alert('Vänta tills viloperioden passerat.');
    c.currentReal = state.proposedReal||c.currentReal;
    c.lastRealLevel = c.currentReal;
    c.lastChangeTs = new Date().toISOString();
    save(c); computeAndRender(c, state.hicpLatest||c.hicpBase);
    alert(`Verkställt: ${fmtEUR(c.currentReal)}`);
  };
  Q('btn-sync').onclick=()=>{
    const c=load();
    c.currentReal=c.normalReal; c.lastRealLevel=c.currentReal; c.lastChangeTs=new Date().toISOString();
    save(c); computeAndRender(c, state.hicpLatest||c.hicpBase);
    alert('Aktuell = Normal.');
  };

  // Hist
  Q('btn-hist-update').onclick=()=>{ const c=load(); ensureHistoryAndMaybeAppend(c); drawHistory(c); alert('Historiken uppdaterad.'); };
  Q('btn-hist-clear').onclick=()=>{ if(!confirm('Töm historik?')) return; const c=load(); c.hist=[]; save(c); drawHistory(c); Q('hist-meta').textContent='—'; };

  // Remote at start
  if(cfg.remoteFirst==='on' && cfg.remoteUrl){ try{ const r=await fetch(cfg.remoteUrl,{cache:'no-store'}); if(r.ok){ const obj=await r.json(); const merged=migrate({...cfg,...obj}); save(merged); initInputs(merged); computeAndRender(merged, state.hicpLatest||merged.hicpBase); } }catch{} }
}

window.addEventListener('error', e=>{ const el=Q('err'); el.textContent='Fel: '+(e.message||'Okänt'); el.hidden=false; });
document.addEventListener('DOMContentLoaded', main);