// v1.8.4b – stabil + robust + tydliga Y‑etiketter
const KEY='uttags_config_v18';
const state={ hicpLatest:null, proposedReal: null };
// ====== helpers
const fmtEUR=(v,d=0)=>isFinite(v)?new Intl.NumberFormat('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d}).format(v).replace(/\u00A0/g,' ')+' €':'–';
const fmtPct=(v,d=2)=>`${(v*100).toFixed(d).replace('.', ',')} %`;
const fmtIntSE=n=>new Intl.NumberFormat('sv-SE',{maximumFractionDigits:0}).format(n).replace(/\u00A0/g,' ');
const parseCurrency=s=>{ if(typeof s!=='string') return Number(s)||0; s=s.replace(/[^0-9,.-]/g,'').replace(/\s/g,''); if(s.includes(',')&&s.includes('.')){const i=s.lastIndexOf(','); return Number(s.slice(0,i).replace(/[.,]/g,'')+'.'+s.slice(i+1).replace(/[^0-9]/g,''))||0;} if(s.includes(',')) return Number(s.replace('.', '').replace(',', '.'))||0; return Number(s)||0; };
const Q=id=>document.getElementById(id);
// ====== config
function def(){ return {
  normalReal:7000, currentReal:7000,
  railMul:[1.0,0.8928571429,0.8,0.7285714286,0.6571428571],
  lastTroughDD:0, lastChangeTs:'', cadence:'q', autoPeak:'on', autoSync:'off',
  hicpBase:126.88, hicpManual:'', bgBright:128, bgOverlay:3,
  tjpNet:0, ppmNet:0, inkNet:613, birth:'1976-01-01',
  iskNom:0, peakNom:0,
  remoteUrl:'', remoteFirst:'off',
  histStartYM:'2025-08', hist:[]
};}
function migrate(cfg){
  if(cfg.railMul==null && Array.isArray(cfg.rails) && cfg.normalReal){ const norm=cfg.normalReal||7000; cfg.railMul=cfg.rails.map(r=>(r.real||norm)/norm); delete cfg.rails; }
  if(!cfg.currentReal) cfg.currentReal=cfg.normalReal||7000;
  if(!cfg.autoSync) cfg.autoSync='off';
  if(!('remoteUrl' in cfg)) cfg.remoteUrl='';
  if(!('remoteFirst' in cfg)) cfg.remoteFirst='off';
  if(!('histStartYM' in cfg)) cfg.histStartYM='2025-08';
  if(!Array.isArray(cfg.hist)) cfg.hist=[];
  return cfg;
}
function safeLoad(){
  try{ const raw=localStorage.getItem(KEY); return migrate(raw?JSON.parse(raw):def()); }
  catch(e){ console.warn('Config parse fail → default', e); return def(); }
}
const save=c=>localStorage.setItem(KEY, JSON.stringify(c));
// error boundary
function showErr(msg){ const el=Q('err'); el.textContent='Fel: '+msg; el.hidden=false; }
window.addEventListener('error', e=> showErr(e.message||'Okänt fel'));

// ====== HICP
async function fetchHICP(){
  try{
    const q=encodeURIComponent('https://sdw-wsrest.ecb.europa.eu/service/data/ICP/M.ES.N.000000.4.INX?lastNObservations=36&detail=dataonly&format=jsondata');
    const url=`https://api.allorigins.win/raw?url=${q}`;
    const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw 0;
    const d=await r.json();
    const obsDim=(d.structure.dimensions.observation||[])[0]; const times=(obsDim&&obsDim.values)?obsDim.values:[];
    const seriesKey=Object.keys(d.dataSets[0].series)[0]; const obs=d.dataSets[0].series[seriesKey].observations;
    const idxs=Object.keys(obs).map(k=>parseInt(k,10)).sort((a,b)=>a-b); const lastIdx=idxs[idxs.length-1];
    return { value:Number(obs[lastIdx][0]), period:(times[lastIdx]&&(times[lastIdx].id||times[lastIdx].name))||'' };
  }catch{return null;}
}

// ====== math
function AF(n,rm){ return rm<=0? n : (1-Math.pow(1+rm,-n))/rm; }
function computeFR(cfg, realMonthly){
  const now=new Date(); const [Y,M,D]=cfg.birth.split('-').map(Number); const b=new Date(Y,M-1,D);
  const age=(now-b)/(365.2425*24*3600*1000); const mLeft=Math.max(0, Math.round((90-age)*12));
  const rm=Math.pow(1+0.047,1/12)-1;
  const PV_need=realMonthly*AF(mLeft,rm);
  let PV=cfg.iskNom;
  function pvDef(pay,startAge,endAge){
    const startM=Math.max(0, Math.round((startAge-age)*12)); const dur=Math.max(0, Math.round((endAge-startAge)*12));
    return (dur<=0||pay<=0)?0: pay*AF(dur,rm)/Math.pow(1+rm,startM);
  }
  PV+=pvDef(cfg.tjpNet,55,65)+pvDef(cfg.ppmNet,65,90)+pvDef(cfg.inkNet,65,90);
  return {FR: PV_need>0? PV/PV_need:0};
}
const guardrailIndex=dd=> dd<0.10?0 : dd<0.20?1 : dd<0.30?2 : dd<0.40?3 : 4;
function proposeReal(cfg,dd,FR){
  const idx=guardrailIndex(dd); const rails=cfg.railMul.map(m=>Math.round(cfg.normalReal*m));
  let level=rails[idx];
  if(FR<0.95 && idx<rails.length-1) level=rails[idx+1];
  if(cfg.lastTroughDD>0 && dd<=cfg.lastTroughDD*0.5 && idx>0) level=Math.max(level, rails[idx-1]);
  if(dd<=0.0001 && FR>=1.05) level=Math.min(cfg.normalReal, Math.round(cfg.currentReal*1.03));
  return {level, rails, idx};
}
function renderRails(cfg,dd){
  const tb=Q('tbl-rails'); tb.innerHTML='';
  const rails=cfg.railMul.map(m=>Math.round(cfg.normalReal*m)); const idx=guardrailIndex(dd);
  const labels=['0–10 %','10–20 %','20–30 %','30–40 %','> 40 %'];
  cfg.railMul.forEach((m,i)=>{ const tr=document.createElement('tr'); if(i===idx) tr.className='sel';
    tr.innerHTML=`<td>${labels[i]}</td><td class="mono">${(m*100).toFixed(2).replace('.',',')} %</td><td class="mono">${fmtEUR(rails[i])}</td>`; tb.appendChild(tr); });
}

// ====== compute & render (med try/catch)
function computeAndRender(cfg,hicp){
  try{
    if(cfg.autoPeak==='on' && cfg.iskNom>cfg.peakNom){ cfg.peakNom=cfg.iskNom; save(cfg); }
    const dd=(cfg.peakNom>0)?Math.max(0,1-cfg.iskNom/cfg.peakNom):0;
    const {FR}=computeFR(cfg, cfg.currentReal);
    const prop=proposeReal(cfg,dd,FR); state.proposedReal=prop.level;
    const I=hicp/Number(String(cfg.hicpBase).replace(',','.'));
    const [Y,M,D]=cfg.birth.split('-').map(Number); const b=new Date(Y,M-1,D);
    const age=(new Date()-b)/(365.2425*24*3600*1000); const phase=(age<55)?1:(age<65)?2:3;
    const tjp=(phase>=2)?cfg.tjpNet:0, ppm=(phase>=3)?cfg.ppmNet:0, ink=(phase>=3)?cfg.inkNet:0;
    const totalNom=prop.level*I; const restReal=Math.max(0,prop.level-(tjp+ppm+ink)); const iskNom=restReal*I;

    Q('kpi-phase').textContent=`Fas ${phase}`;
    Q('kpi-real-current').textContent=fmtEUR(cfg.currentReal);
    Q('kpi-real-proposed').textContent=fmtEUR(prop.level);
    Q('kpi-hicp').textContent=I.toFixed(4).replace('.',',');
    Q('kpi-dd').textContent=fmtPct(dd,1);
    Q('kpi-fr').textContent=(FR>=1?'≥ ':'')+(FR.toFixed(2).replace('.',','));
    Q('kpi-total').textContent=fmtEUR(totalNom);
    Q('kpi-isk').textContent=fmtEUR(iskNom);

    let badge='pill ok', msg='Planen är finansierad. Håll nivå.';
    if(FR<1.0){badge='pill warn'; msg='FR < 1,0: justera enligt föreslagen nivå.';}
    if(dd>=0.3){badge='pill danger'; msg='Stor drawdown: sänk snabbt till föreslagen nivå.';}
    const bEl=Q('badge'); bEl.className=badge; bEl.textContent=({'pill ok':'Grön','pill warn':'Gul','pill danger':'Röd'})[badge]||'–';
    Q('badge-txt').textContent=msg;
    Q('drawdown-line').textContent=`Drawdown: ${fmtPct(dd,1)} | ISK: ${fmtEUR(cfg.iskNom)} | Högsta: ${fmtEUR(cfg.peakNom)}`;

    renderRails(cfg,dd);

    const days=(cfg.cadence==='q'?90:30);
    const canChange=(!cfg.lastChangeTs) || ((new Date()-new Date(cfg.lastChangeTs))/(24*3600*1000) >= days);
    Q('commit-hint').textContent=`Cadens: ${cfg.cadence==='q'?'Kvartal (≥90 d)':'Månadsvis (≥30 d)'} · ${canChange?'Du kan ändra nu.':'Vänta tills viloperioden passerat.'}`;
    Q('btn-commit').disabled=!canChange;

    // historik
    ensureHistoryAndMaybeAppend(cfg); drawHistory(cfg);
  }catch(e){ showErr(e.message||String(e)); console.error(e); }
}

// ====== inputs & appearance
function bindCurrencyFields(){
  document.querySelectorAll('input[data-type="currency"]').forEach(el=>{
    el.value=fmtIntSE(parseCurrency(el.value));
    el.addEventListener('focus',()=>{const v=parseCurrency(el.value); el.value=isFinite(v)?String(Math.round(v)):''; setTimeout(()=>{ try{ el.selectionStart=el.selectionEnd=el.value.length; }catch{} },0); });
    el.addEventListener('blur',()=>{ el.value=fmtIntSE(parseCurrency(el.value)); });
    el.addEventListener('input',()=>{ el.value=el.value.replace(/[^0-9,\.\s-]/g,''); });
  });
}
function bindInputs(cfg){
  Q('inp-normal').value=fmtIntSE(cfg.normalReal);
  Q('inp-hicp-base').value=String(cfg.hicpBase).replace('.',',');
  Q('inp-tjp').value=fmtIntSE(cfg.tjpNet); Q('inp-ppm').value=fmtIntSE(cfg.ppmNet); Q('inp-ink').value=fmtIntSE(cfg.inkNet);
  Q('inp-birth').value=cfg.birth; Q('sel-cadence').value=cfg.cadence; Q('sel-auto-peak').value=cfg.autoPeak;
  Q('inp-isk').value=fmtIntSE(cfg.iskNom); Q('inp-peak').value=fmtIntSE(cfg.peakNom);
  Q('sel-auto-sync').value=cfg.autoSync||'off';
  Q('inp-remote-url').value=cfg.remoteUrl||''; Q('sel-remote-first').value=cfg.remoteFirst||'off';
  Q('inp-hist-start').value=cfg.histStartYM||'2025-08';
  bindCurrencyFields();
}

// ====== base buttons
function setBase(){
  const latest=state.hicpLatest, label=Number((Q('hicp-latest').textContent||'').replace(',','.')), input=Number((Q('inp-hicp-base').value||'').replace(',','.'));
  let v=[latest,label,input].filter(x=>isFinite(x)&&x>0)[0];
  if(!isFinite(v)){ const p=prompt('HICP-bas (t.ex. 126,88):','126,88'); if(p) v=Number(p.replace(',','.')); }
  if(!isFinite(v)||v<=0) return alert('Ogiltig nivå.');
  const c=safeLoad(); c.hicpBase=v; save(c); Q('inp-hicp-base').value=String(v).replace('.',',');
  computeAndRender(c, state.hicpLatest||v); alert('HICP‑bas satt.');
}
function exportConfig(){ const blob=new Blob([JSON.stringify(safeLoad(),null,2)],{type:'application/json'}); const a=document.createElement('a'); a.download='uttags_config_v18.json'; a.href=URL.createObjectURL(blob); a.click(); URL.revokeObjectURL(a.href); }
function importConfig(file){ const rd=new FileReader(); rd.onload=()=>{ try{ const obj=JSON.parse(rd.result); const merged=migrate({...safeLoad(),...obj}); save(merged); alert('Importerad. Uppdaterar…'); location.reload(); }catch{ alert('Ogiltig JSON.'); } }; rd.readAsText(file); }
function resetRails(){ const c=safeLoad(); c.railMul=[1.0,0.8928571429,0.8,0.7285714286,0.6571428571]; delete c.rails; save(c); computeAndRender(c, state.hicpLatest||Number(String(c.hicpBase).replace(',','.'))); }
function syncCurrentToNormal(){ const c=safeLoad(); c.currentReal=c.normalReal; c.lastChangeTs=new Date().toISOString(); save(c); computeAndRender(c, state.hicpLatest||Number(String(c.hicpBase).replace(',','.'))); alert('Aktuell = Normal är nu synkat.'); }

// ====== historik
function ymOfClosedMonth(d=new Date()){ const dt=new Date(d.getFullYear(), d.getMonth(), 1); dt.setMonth(dt.getMonth()-1); const y=dt.getFullYear(); const m=String(dt.getMonth()+1).padStart(2,'0'); return `${y}-${m}`; }
function ymToDate(ym){ const [y,m]=ym.split('-').map(Number); return new Date(y, m-1, 1); }
function ensureHistoryAndMaybeAppend(cfg){
  if(!cfg.histStartYM) cfg.histStartYM='2025-08';
  if(!Array.isArray(cfg.hist)) cfg.hist=[];
  const closed=ymOfClosedMonth(); const start=cfg.histStartYM;
  if(ymToDate(closed) < ymToDate(start)) return;
  const lastYM = cfg.hist.length? cfg.hist[cfg.hist.length-1].ym : null;
  if(!lastYM){ cfg.hist.push({ym:start, isk:cfg.iskNom, peak:cfg.peakNom}); }
  if(cfg.hist[cfg.hist.length-1].ym !== closed){
    let cur=ymToDate(cfg.hist[cfg.hist.length-1].ym);
    while(true){
      cur.setMonth(cur.getMonth()+1);
      const ym = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}`;
      if(ym>closed) break;
      cfg.hist.push({ym, isk:cfg.iskNom, peak:cfg.peakNom});
      if(ym===closed) break;
    }
  }else{
    const p=cfg.hist[cfg.hist.length-1]; p.isk=cfg.iskNom; p.peak=cfg.peakNom;
  }
  save(cfg);
  Q('hist-meta').textContent= cfg.hist.length? `${cfg.hist[0].ym} → ${cfg.hist[cfg.hist.length-1].ym} · ${cfg.hist.length} mån` : '—';
}
function drawHistory(cfg){
  const cvs=Q('hist-canvas'); const ctx=cvs.getContext('2d');
  const dpr = window.devicePixelRatio||1; const W=cvs.clientWidth*dpr, H=cvs.clientHeight*dpr;
  if(cvs.width!==W) cvs.width=W; if(cvs.height!==H) cvs.height=H;
  ctx.clearRect(0,0,W,H);
  const padL=80*dpr, padR=20*dpr, padT=26*dpr, padB=36*dpr;
  const data=cfg.hist||[];
  if(!data.length){ ctx.fillStyle='#5f7a94'; ctx.font=`${12*dpr}px -apple-system,Segoe UI,Roboto,Arial`; ctx.fillText('Ingen historik ännu.', 16*dpr, 24*dpr); return; }
  const xs=data.map(d=>d.ym);
  const ys1=data.map(d=>d.isk||0), ys2=data.map(d=>d.peak||0);
  const yMax = Math.max(1, Math.max(...ys1, ...ys2)); const yMin=0;
  // grid
  ctx.strokeStyle='rgba(6,148,240,.15)'; ctx.lineWidth=1*dpr;
  const gridN=5;
  for(let i=0;i<=gridN;i++){
    const y = padT + (H - padT - padB) * i / gridN;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
  }
  // axes
  ctx.strokeStyle='rgba(6,148,240,.40)'; ctx.lineWidth=1.5*dpr;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H-padB); ctx.lineTo(W-padR, H-padB); ctx.stroke();
  // Y labels (högerjusterad, €)
  ctx.fillStyle='#0b3b6f'; ctx.textAlign='right'; ctx.textBaseline='middle'; ctx.font=`${12*dpr}px -apple-system,Segoe UI,Roboto,Arial`;
  for(let i=0;i<=gridN;i++){
    const val = yMax - (yMax - yMin) * i / gridN;
    const y = padT + (H - padT - padB) * i / gridN;
    const label = new Intl.NumberFormat('sv-SE',{maximumFractionDigits:0}).format(Math.round(val)) + ' €';
    ctx.fillText(label, padL-8*dpr, y);
  }
  // X labels
  ctx.fillStyle='#466079'; ctx.textAlign='center'; ctx.textBaseline='alphabetic';
  const n=xs.length, w=(W-padL-padR)/(Math.max(1,n-1));
  for(let i=0;i<n;i++){ const x = padL + w*i; const y = H - padB + 16*dpr; ctx.fillText(xs[i], x, y); }
  function plot(ys, color){
    ctx.strokeStyle=color; ctx.lineWidth=2.5*dpr; ctx.beginPath();
    ys.forEach((v,i)=>{ const x = padL + w*i; const y = padT + (H - padT - padB) * (1 - (v - yMin)/(yMax - yMin)); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
  }
  plot(ys2, '#0b3b6f'); plot(ys1, '#0aa2ff');
  // legend
  ctx.fillStyle='#0b3b6f'; ctx.fillRect(W-padR-160*dpr, padT-14*dpr, 10*dpr, 10*dpr); ctx.fillStyle='#0f172a'; ctx.fillText('Högsta', W-padR-142*dpr, padT-5*dpr);
  ctx.fillStyle='#0aa2ff'; ctx.fillRect(W-padR-90*dpr, padT-14*dpr, 10*dpr, 10*dpr); ctx.fillStyle='#0f172a'; ctx.fillText('ISK', W-padR-72*dpr, padT-5*dpr);
}

// ====== main
async function main(){
  const err=Q('err'); err.hidden=true;
  let cfg=safeLoad();
  // inputs
  bindInputs(cfg);
  // HICP
  const res=await fetchHICP(); let hicp=null;
  if(res){ hicp=res.value; Q('hicp-latest').textContent=res.value.toFixed(2).replace('.',','); Q('hicp-date').textContent=`Period: ${res.period}`; }
  else { const manual=Number((Q('inp-hicp-manual').value||'').replace(',','.')); hicp=isFinite(manual)&&manual>0?manual:Number(String(cfg.hicpBase).replace(',','.')); Q('hicp-latest').textContent=isFinite(manual)?manual.toFixed(2).replace('.',','):'—'; Q('hicp-date').textContent=isFinite(manual)?'Manuell nivå används':'—'; }
  // render
  computeAndRender(cfg, hicp);
  // bind
  Q('btn-export').onclick=exportConfig;
  Q('file-import').addEventListener('change',e=>{ if(e.target.files&&e.target.files[0]) importConfig(e.target.files[0]); });
  Q('btn-base-inline').onclick=setBase; Q('btn-reset-rails').onclick=resetRails; Q('btn-sync').onclick=syncCurrentToNormal;
  Q('btn-save').onclick=()=>{
    const c=safeLoad();
    c.normalReal=parseCurrency(Q('inp-normal').value);
    c.hicpBase=parseCurrency(Q('inp-hicp-base').value.replace('.',','));
    c.tjpNet=parseCurrency(Q('inp-tjp').value); c.ppmNet=parseCurrency(Q('inp-ppm').value); c.inkNet=parseCurrency(Q('inp-ink').value);
    c.birth=Q('inp-birth').value; c.cadence=Q('sel-cadence').value; c.autoPeak=Q('sel-auto-peak').value;
    c.iskNom=parseCurrency(Q('inp-isk').value); c.peakNom=parseCurrency(Q('inp-peak').value);
    c.autoSync=Q('sel-auto-sync').value;
    c.remoteUrl=(Q('inp-remote-url').value||'').trim(); c.remoteFirst=Q('sel-remote-first').value;
    c.histStartYM=(Q('inp-hist-start').value||'2025-08').trim();
    if(c.autoSync==='on') c.currentReal=c.normalReal;
    save(c); computeAndRender(c, hicp||Number(String(c.hicpBase).replace(',','.'))); alert('Sparat.');
  };
  Q('btn-commit').onclick=()=>{
    const c=safeLoad();
    const coolDays=(c.cadence==='q'?90:30);
    const allowed=(!c.lastChangeTs)||((new Date()-new Date(c.lastChangeTs))/(24*3600*1000)>=coolDays);
    if(!allowed) return alert('Vänta tills viloperioden passerat.');
    const dd=(c.peakNom>0)?Math.max(0,1-c.iskNom/c.peakNom):0; c.lastTroughDD=Math.max(c.lastTroughDD||0, dd);
    c.currentReal=state.proposedReal||c.currentReal; c.lastChangeTs=new Date().toISOString(); save(c);
    computeAndRender(c, hicp||Number(String(c.hicpBase).replace(',','.'))); alert(`Verkställt ny real nivå: ${fmtEUR(c.currentReal)}`);
  };
  Q('btn-hist-update').onclick=()=>{ const c=safeLoad(); ensureHistoryAndMaybeAppend(c); drawHistory(c); alert('Historiken är uppdaterad till senaste stängda månad.'); };
  Q('btn-hist-clear').onclick=()=>{ if(!confirm('Tömma historik? (Detta kan inte ångras)')) return; const c=safeLoad(); c.hist=[]; save(c); drawHistory(c); Q('hist-meta').textContent='—'; alert('Historik tömd.'); };
}

document.addEventListener('DOMContentLoaded', main);