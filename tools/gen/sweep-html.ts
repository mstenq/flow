import type { SweepResult } from './sweep-core.ts';

export interface SweepMeta {
    mode: 'simplify-only' | 'full';
    difficulty: number;
    generated: string;
}

/** Self-contained dark contact sheet; all rendering/filtering happens client-side from the embedded JSON. */
export function sweepHtml(results: SweepResult[], meta: SweepMeta): string {
    const json = JSON.stringify({ meta, results }).replace(/</g, '\\u003c');
    return `<!doctype html><html><head><meta charset="utf-8"><title>FLOW sweep</title><style>
:root{color-scheme:dark}
body{margin:0;background:#07050f;color:#d8d4ee;font:13px/1.35 system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:#0d0a1c;border-bottom:1px solid #2a2150;padding:8px 12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
header label{display:flex;gap:4px;align-items:center;color:#9a93c4}
input,select,button{background:#16112e;color:#e6e2ff;border:1px solid #3a2f6e;border-radius:4px;padding:3px 6px;font:inherit}
input[type=number]{width:62px}
button{cursor:pointer}button:hover{background:#2a2150}
#count{margin-left:auto;color:#8ff}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px;padding:12px}
.tile{background:#100c22;border:1px solid #2a2150;border-radius:6px;padding:8px}
.tile.failed{border-color:#f44;background:#240c14}
.imgs{display:flex;gap:8px;align-items:flex-start}
.imgs img{width:160px;height:160px;object-fit:contain;image-rendering:pixelated;background:#07050f;border-radius:3px}
.title{display:flex;justify-content:space-between;gap:6px;margin-bottom:6px;font-weight:600}
.file{color:#8ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{margin-top:6px;color:#9a93c4;display:grid;grid-template-columns:1fr 1fr;gap:1px 8px}
.meta b{color:#e6e2ff;font-weight:500}
.err{color:#ff6b7a;margin-top:6px;word-break:break-word}
.warn{color:#fc6;margin-top:4px}
.trapb{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:999px;background:#5a0a1c;border:1px solid #ff2950;color:#ff9aab;font-weight:700;font-size:11px}
</style></head><body>
<header>
<label>sort <select id="sort"><option value="file">file</option><option value="colors">final colors</option><option value="src">source colors</option><option value="diff">difficulty</option><option value="err">|diff - target|</option><option value="time">time</option><option value="cells">cells</option></select></label>
<label>desc <input type="checkbox" id="desc"></label>
<label>status <select id="status"><option value="">all</option><option value="ok">ok</option><option value="failed">failed</option></select></label>
<label>colors <input type="number" id="cmin" placeholder="min"> - <input type="number" id="cmax" placeholder="max"></label>
<label>difficulty <input type="number" step="0.05" id="dmin" placeholder="min"> - <input type="number" step="0.05" id="dmax" placeholder="max"></label>
<label>time s <input type="number" step="0.5" id="tmax" placeholder="max"></label>
<label>search <input id="q" placeholder="file"></label>
<span id="count"></span>
</header><div id="grid"></div>
<script>
const D=${json};const R=D.results;const full=D.meta.mode==='full';
const $=id=>document.getElementById(id);
const key={file:r=>r.file,colors:r=>r.finalColors,src:r=>r.sourceColors,diff:r=>r.difficulty??-1,err:r=>Math.abs((r.difficulty??0)-(r.target??0)),time:r=>r.totalMs,cells:r=>r.cells};
function entry(r){return JSON.stringify({file:r.file,name:r.name,difficulty:full?Math.round(r.difficulty*100)/100:D.meta.difficulty});}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function tile(r,i){
 const f=r.status==='failed';
 let m='<div>size <b>'+r.width+'x'+r.height+'</b></div><div>colors <b>'+r.sourceColors+' → '+r.finalColors+'</b></div><div>cells <b>'+r.cells+'</b></div><div>time <b>'+(r.totalMs/1000).toFixed(2)+'s</b></div>';
 if(full&&!f){m+='<div>difficulty <b>'+r.difficulty.toFixed(3)+'</b> (target '+r.target+')</div><div>greedy/random <b>'+(r.greedy*100).toFixed(0)+'% / '+(r.random*100).toFixed(0)+'%</b></div><div>fast g/r <b>'+((r.fastGreedy??0)*100).toFixed(0)+'% / '+((r.fastRandom??0)*100).toFixed(0)+'%</b></div><div>max pod/drain <b>'+r.maxPod+' / '+(r.drainSec??0).toFixed(1)+'s</b></div><div>pods/lanes <b>'+r.pods+' / '+r.lanes+'</b> (min '+r.minLanes+')</div><div>mech <b>'+r.locks+' lock, '+r.pairs+' pair, '+r.hidden+' hidden</b></div>';}
 return '<div class="tile'+(f?' failed':'')+'"><div class="title"><span class="file" title="'+esc(r.file)+'">'+esc(r.file)+'</span><button data-i="'+i+'">copy entry</button></div><div class="imgs"><img src="'+r.thumbOrig+'">'+(r.thumbBoard?'<img src="'+r.thumbBoard+'">':'<div style="width:160px"></div>')+'</div><div class="meta">'+m+'</div>'+(f?'<div class="err">'+esc(r.error)+'</div>':'')+(r.trap?'<div class="trapb">FAST-PLAY TRAP</div>':'')+((r.warnings||[]).length?'<div class="warn">'+esc(r.warnings.join('; '))+'</div>':'')+'</div>';
}
function render(){
 const num=id=>{const v=$(id).value;return v===''?null:Number(v)};
 const cmin=num('cmin'),cmax=num('cmax'),dmin=num('dmin'),dmax=num('dmax'),tmax=num('tmax'),st=$('status').value,q=$('q').value.toLowerCase();
 let rows=R.map((r,i)=>[r,i]).filter(([r])=>(!st||r.status===st)&&(cmin==null||r.finalColors>=cmin)&&(cmax==null||r.finalColors<=cmax)&&(dmin==null||(r.difficulty??-1)>=dmin)&&(dmax==null||(r.difficulty??2)<=dmax)&&(tmax==null||r.totalMs/1000<=tmax)&&(!q||q.split(',').some(t=>r.file.toLowerCase().includes(t))));
 const k=key[$('sort').value];const s=$('desc').checked?-1:1;
 rows.sort((a,b)=>{const x=k(a[0]),y=k(b[0]);return (x<y?-1:x>y?1:0)*s||(a[0].file<b[0].file?-1:1)});
 $('grid').innerHTML=rows.map(([r,i])=>tile(r,i)).join('');
 $('count').textContent=rows.length+' / '+R.length+' shown · '+D.meta.mode+(full?' @ '+D.meta.difficulty:'');
}
document.querySelectorAll('header input,header select').forEach(e=>e.addEventListener('input',render));
$('grid').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const t=entry(R[b.dataset.i]);(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).catch(()=>{const a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();});b.textContent='copied!';setTimeout(()=>b.textContent='copy entry',900);});
render();
</script></body></html>`;
}
