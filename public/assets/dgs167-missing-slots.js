/* DGS V167 - Multi-chapter missing media and narration slot indicators.
 * Additive read-only UI. Does not change script, media, VO, or source clocks.
 * Works with the existing Smart Match dialog and replacement modal.
 */
(function(factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof window==='object'&&typeof document==='object')api.mount(window,document);
})(function(){
 'use strict';
 const VERSION='V167-MISSING-IMAGE-VIDEO-VO-20261102';
 const BASE='/dgs-editor-benchmarks-20261029';
 const validTime=n=>n!==null&&n!==undefined&&Number.isFinite(Number(n));
 const sceneIndex=s=>Number(s?.scene_no)||Number(String(s?.screen||'').replace(/\D/g,''))||0;
 const isPoem=s=>s?.is_poem===true||s?.is_poem==='true';
 const silent=s=>{
   const track=String(s?.audio_track||s?.audioTrack||'').trim().toUpperCase();
   return Boolean(s?.narration_silent_visual||s?.narration_silent_reason||
     ['NONE','SILENT','SILENCE','VISUAL_ONLY','NO_AUDIO'].includes(track));
 };
 const typeFor=(s,c)=>{
   const kind=String(c?.kind||'').toLowerCase();
   if(kind==='video'||kind==='image')return kind;
   return /\.(mp4|mov|m4v|webm|mkv)$/i.test(s?.asset_filename||c?.filename||'')?'video':'image';
 };
 const labelFor=k=>({
   missing_image:'MISSING IMAGE',missing_video:'MISSING VIDEO',
   missing_vo:'MISSING VO',relink_image:'RELINK IMAGE',
   relink_video:'RELINK VIDEO',relink_vo:'RELINK VO',
   unaligned_vo:'VO NOT ALIGNED'
 })[k]||'NEEDS REVIEW';
 const needsFix=k=>k.startsWith('missing_')||k.startsWith('relink_')||k==='unaligned_vo';
 function classifyProject(p){
   if(!p||!Array.isArray(p.scenes))return[];
   const byScreen=new Map((p.timeline?.clips||[]).map(c=>[c.screen,c]));
   const byMedia=new Map((p.media||[]).map(m=>[m.id,m]));
   const voiced=Boolean(p.voiceover?.filename);
   const output=[];
   for(const s of p.scenes){
     const screen=s.screen||'screen_'+sceneIndex(s);
     if(!screen||!sceneIndex(s))continue;
     const c=byScreen.get(screen),m=byMedia.get(c?.media_id),n=sceneIndex(s);
     const duration=validTime(c?.end)&&validTime(c?.start)?
       Math.max(0,Number(c.end)-Number(c.start)):
       validTime(s.duration)?Number(s.duration):0;
     const expectedKind=typeFor(s,c);
     const clipName=String(c?.filename||'');
     const explicitMissing=Boolean(c?.v140f_missing_visual?.active||
       c?.v167_missing_visual?.active||/\bMISSING[\s_-]*(IMAGE|VIDEO)\b/i.test(clipName));
     const noVisual=Boolean(c&&!explicitMissing&&(!c.media_id||!m)&&
       (s.asset_filename||c.kind==='image'||c.kind==='video'));
     let visual=null;
     if(explicitMissing||noVisual)visual='missing_'+expectedKind;
     else if(m?.local_only)visual='relink_'+expectedKind;
     if(visual){
       output.push({
         key:screen+':'+visual,screen,sceneNumber:n,type:visual,kind:expectedKind,
         label:labelFor(visual),duration,filename:m?.filename||clipName||s.asset_filename||'',
         narration:String(s.voiceover_text||''),reason:explicitMissing?
          'The timeline explicitly marks this scene as missing '+expectedKind+'.':
          noVisual?'This scene has no '+expectedKind+' media assignment.':
          'The '+expectedKind+' is referenced locally but is not available to the cloud scanner. Relink or upload it.',
         severity:visual.startsWith('missing_')?'error':'review',
         source:'chapter_media_inventory'
       });
     }
     const narration=String(s.voiceover_text||'').trim();
     if(!narration||isPoem(s)||silent(s))continue;
     const hasWindow=Boolean(c&&validTime(c.narration_in)&&validTime(c.narration_out)&&
       Number(c.narration_out)>Number(c.narration_in)+.01);
     let audio=null;
     if(!voiced)audio='missing_vo';
     else if(p.voiceover.local_only)audio='relink_vo';
     else if(c&&!hasWindow)audio='unaligned_vo';
     if(audio){
       output.push({
         key:screen+':'+audio,screen,sceneNumber:n,type:audio,kind:'vo',
         label:labelFor(audio),duration,filename:p.voiceover?.filename||'',
         narration,reason:audio==='missing_vo'?
           'The script requires spoken narration, but no narration recording has been imported.':
           audio==='relink_vo'?
           'The narration source is local-only. Relink the recording before confirming playback.':
           'The narration exists, but no verified source-audio window has been assigned to this scene.',
         severity:audio==='missing_vo'?'error':'review',source:'chapter_narration_inventory'
       });
     }
   }
   return output.sort((a,b)=>a.sceneNumber-b.sceneNumber||a.type.localeCompare(b.type));
 }
 function mount(win,doc){
   if(win.DGS167_MISSING_SLOTS)return win.DGS167_MISSING_SLOTS;
   const ctx=()=>win.DGS140C_GET_SMART_CONTEXT?.();
   const current=()=>ctx()?.projectId||null;
   let pid=null,project=null,issues=[],inflight=null,serial=0,lastFetch=0,lastFingerprint='';
   let lastVisible='',popupFingerprint='';
   let refreshing=false;
   const qa=()=>win.DGS140F_VISUAL_QA;
   const clock=()=>JSON.stringify((ctx()?.plan?.clips||[]).map(c=>
     [c.screen,c.media_id,c.filename,c.kind,c.narration_in,c.narration_out,
       c.v140f_missing_visual?.active||false]));
   const mk=(tag,cls,text)=>{
     const e=doc.createElement(tag);if(cls)e.className=cls;
     if(text!==undefined)e.textContent=text;
     return e;
   };
   const issueByScreen=()=>{
     const m=new Map();
     for(const issue of issues){
       const rows=m.get(issue.screen)||[];rows.push(issue);m.set(issue.screen,rows);
     }
     return m;
   };
   async function refresh(force=false){
     const id=current();
     if(!id){reset();return false}
     if(inflight&&!force)return inflight;
     const token=++serial;
     inflight=(async()=>{
       try{
         const r=await win.fetch(BASE+'/api/projects/'+encodeURIComponent(id)+'/load',{
           cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(24000)
         });
         if(!r.ok)throw Error('Project load HTTP '+r.status);
         const p=await r.json();
         if(token!==serial||current()!==id)return false;
         pid=id;project=p;issues=classifyProject(p);
         lastFetch=Date.now();lastFingerprint=clock();
         render();return true;
       }catch(err){
         if(token===serial&&current()===id){
           win.console?.warn?.('V167 missing-slot audit unavailable:',String(err?.message||err));
         }
         return false;
       }finally{if(token===serial)inflight=null}
     })();
     return inflight;
   }
   function reset(){
     ++serial;inflight=null;pid=null;project=null;issues=[];lastFetch=0;
     lastFingerprint='';lastVisible='';popupFingerprint='';
     removeFlags();const overlay=doc.querySelector('#dgs167-preview-overlay');
     overlay?.remove();doc.querySelector('#dgs167-qa-rows')?.remove();
   }
   function removeFlags(){
     doc.querySelectorAll('.dgs167-visual-flag').forEach(x=>x.remove());
     doc.querySelectorAll('.dgs167-audio-flag').forEach(x=>x.remove());
     doc.querySelectorAll('.dgs167-missing-clip').forEach(x=>x.classList.remove('dgs167-missing-clip'));
   }
   const screenFromClip=el=>String(el?.getAttribute('title')||'').match(/\bscreen_(\d+)\b/i)?.[0]||null;
   function issueAction(issue){
     if(!issue||!needsFix(issue.type)||current()!==pid)return;
     const replacement=win.DGS140F_REPLACEMENTS;
     // No master narration was ever imported: use the native audio import, not a fake per-scene splice.
     if(issue.type==='missing_vo'||issue.type==='relink_vo'){
       const buttons=[...doc.querySelectorAll('button,label')];
       const native=buttons.find(x=>/Import Narration VO\s*1/i.test(x.textContent||''));
       if(native){native.click();return}
     }
     if(typeof replacement?.open==='function'){
       replacement.open(issue.screen,issue.kind==='vo'?'vo':issue.kind);
       return;
     }
     showIssue(issue);
   }
   function showIssue(issue){
     if(!issue||current()!==pid)return;
     qa()?.open?.();renderPopup();
     let row=[...doc.querySelectorAll('#dgs140d-list [data-dgs167-key]')]
       .find(x=>x.dataset.dgs167Key===issue.key);
     if(!row&&['missing_vo','relink_vo'].includes(issue.type)){
       row=doc.querySelector('#dgs140d-list [data-dgs167-master="'+issue.type+'"]');
     }
     if(!row){
       row=[...doc.querySelectorAll('#dgs140d-list [data-qa-screen]')]
         .find(x=>x.dataset.qaScreen===issue.screen);
     }
     row?.scrollIntoView?.({behavior:'smooth',block:'center'});
   }
   function addFlag(parent,issue,isAudio=false){
     const marker=mk('button',isAudio?'dgs167-audio-flag':'dgs167-visual-flag',issue.label);
     marker.type='button';
     marker.title='Scene '+issue.sceneNumber+' Â· '+issue.label+' Â· '+issue.reason;
     marker.dataset.dgs167Key=issue.key;
     marker.dataset.dgs167Status=issue.type;
     marker.setAttribute('aria-label',marker.title);
     marker.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation()},{capture:true});
     marker.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();showIssue(issue)},{capture:true});
     parent.append(marker);return marker;
   }
   function renderTimeline(){
     const grouped=issueByScreen();
     const clips=[...doc.querySelectorAll('.lane.video-lane .clip')];
     const seen=new Set();
     for(const clip of clips){
       const screen=screenFromClip(clip),rows=grouped.get(screen)||[];
       const visual=rows.find(x=>x.kind==='image'||x.kind==='video');
       const marker=clip.querySelector('.dgs167-visual-flag');
       if(visual){
         seen.add(screen);
         clip.classList.add('dgs167-missing-clip');
         if(marker?.dataset.dgs167Key!==visual.key){marker?.remove();addFlag(clip,visual)}
       }else{marker?.remove();clip.classList.remove('dgs167-missing-clip')}
     }
     const narrationLane=doc.querySelector('.lane.audio-lane:not(.poem)');
     if(narrationLane){
       const required=issues.filter(x=>x.kind==='vo');
       const expectedKeys=new Set(required.map(x=>x.key));
       narrationLane.querySelectorAll('.dgs167-audio-flag').forEach(x=>{
         if(!expectedKeys.has(x.dataset.dgs167Key))x.remove();
       });
       const byScreen=new Map(clips.map(x=>[screenFromClip(x),x]));
       for(const issue of required){
         const matching=byScreen.get(issue.screen);
         if(!matching)continue;
         let flag=[...narrationLane.querySelectorAll('.dgs167-audio-flag')]
            .find(x=>x.dataset.dgs167Key===issue.key);
         if(!flag)flag=addFlag(narrationLane,issue,true);
         flag.style.left=matching.style.left||'0px';
         flag.style.width=matching.style.width||'32px';
       }
     }
   }
   function selectedScreen(){
     const playhead=doc.querySelector('.track-lanes .playhead');
     const left=Number.parseFloat(playhead?.style?.left||'');
     const clips=[...doc.querySelectorAll('.lane.video-lane .clip')];
     if(Number.isFinite(left)&&clips.length){
       const clip=clips.find(el=>{
         const a=Number.parseFloat(el.style.left||'');
         const w=Number.parseFloat(el.style.width||'');
         return Number.isFinite(a)&&Number.isFinite(w)&&left>=a-.04&&left<a+w-.04;
       });
       if(clip)return screenFromClip(clip);
     }
     return screenFromClip(doc.querySelector('.lane.video-lane .clip.selected'));
   }
   function renderPreview(){
     const frame=doc.querySelector('.preview-frame'),screen=selectedScreen();
     const rows=issues.filter(x=>x.screen===screen);
     if(!frame||!screen||!rows.length){
       doc.querySelector('#dgs167-preview-overlay')?.remove();
       lastVisible='';return;
     }
     const fingerprint=screen+'|'+rows.map(x=>x.key).join('|');
     if(fingerprint===lastVisible&&doc.querySelector('#dgs167-preview-overlay')?.parentElement===frame)return;
     doc.querySelector('#dgs167-preview-overlay')?.remove();
     lastVisible=fingerprint;
     const root=mk('div','dgs167-preview-overlay');root.id='dgs167-preview-overlay';
     const visual=rows.find(x=>x.kind==='image'||x.kind==='video');
     const audio=rows.find(x=>x.kind==='vo');
     if(visual){
       const block=mk('button','dgs167-preview-visual '+(visual.type.startsWith('relink')?'dgs167-relink':''));block.type='button';
       const parts=visual.label.split(' ');block.append(mk('strong',null,parts[0]),mk('span',null,parts.slice(1).join(' ')),
         mk('small',null,'Scene '+visual.sceneNumber+' Â· click to review or replace'));
       block.addEventListener('click',e=>{e.preventDefault();showIssue(visual)});
       root.append(block);
     }
     if(audio){
       const badge=mk('button','dgs167-preview-audio',audio.label+' Â· Click to review');
       badge.type='button';badge.title=audio.reason;
       badge.addEventListener('click',e=>{e.preventDefault();showIssue(audio)});
       root.append(badge);
     }
     frame.append(root);
   }
   function issueRow(issue){
     const card=mk('article','dgs167-issue',undefined);
     card.dataset.dgs167Key=issue.key;
     if(issue.masterType)card.dataset.dgs167Master=issue.masterType;
     card.dataset.qaScreen=issue.screen;
     card.append(mk('strong',null,'Scene '+issue.sceneNumber+' Â· '+issue.label),
       mk('p',null,issue.reason));
     if(issue.narration){
       const expected=mk('div','dgs167-expected');
       expected.append(mk('small',null,'Expected narration'),mk('span',null,issue.narration.slice(0,260)));
       card.append(expected);
     }
     const sub=mk('small','dgs167-scene-timing',
       'Scene duration preserved Â· '+(issue.duration||0).toFixed(2)+'s Â· '+(issue.filename||'No file'));
     card.append(sub);
     const actions=mk('div','dgs167-actions');
     const replace=mk('button','dgs140d-btn',issue.kind==='vo'?
       (issue.type==='missing_vo'||issue.type==='relink_vo'?'Import / relink narration':'Review / replace scene VO'):
       issue.type.startsWith('relink_')?'Relink / replace '+issue.kind:'Replace '+issue.kind);
     replace.type='button';replace.addEventListener('click',()=>issueAction(issue));
     const retry=mk('button','dgs140d-btn secondary','Retry Smart Match');
     retry.type='button';retry.addEventListener('click',()=>void (async()=>{
       await refresh(true);
       if(current()===pid)await qa()?.postAlignFlow?.('missing-slot-retry');
     })());
     actions.append(replace,retry);card.append(actions);
     return card;
   }
   function renderPopup(){
     const list=doc.querySelector('#dgs140d-list');
     if(!list||current()!==pid)return;
     const orig=new Set((qa()?.getReport?.()?.active||[]).filter(x=>x.type==='missing_visual_timeline')
       .map(x=>x.screen));
     const raw=issues.filter(x=>!(x.type==='missing_image'&&orig.has(x.screen)));
     const masterTypes=['missing_vo','relink_vo'];
     const byMaster=new Map(masterTypes.map(type=>[type,raw.filter(x=>x.type===type)]));
     const entries=raw.filter(x=>!masterTypes.includes(x.type)||
       byMaster.get(x.type)?.[0]?.key===x.key).map(issue=>{
       const group=byMaster.get(issue.type);
       if(!group||group.length<2)return issue;
       return {...issue,key:'master:'+issue.type,
         masterType:issue.type,
         label:issue.label+' Â· '+group.length+' scenes',
         reason:issue.reason+' This master VO affects '+group.length+
           ' narrated scenes. Each original narration slot remains visible on the audio timeline.',
         narration:'Affected scenes: '+group.map(x=>x.sceneNumber).join(', ')
       };
     });
     const fp=pid+'|'+raw.map(x=>x.key).join('|');
     const existing=doc.querySelector('#dgs167-qa-rows');
     if(!entries.length){existing?.remove();popupFingerprint='';return}
     if(existing?.parentElement===list&&fp===popupFingerprint)return;
     existing?.remove();popupFingerprint=fp;
     const wrapper=mk('section','dgs167-qa-rows');wrapper.id='dgs167-qa-rows';
     const errorCount=entries.filter(x=>x.severity==='error').length;
     wrapper.append(mk('h4',null,'Missing slots / relink needed Â· '+entries.length),
       mk('p','dgs167-intro',errorCount+' missing assets or VO recordings Â· '+(entries.length-errorCount)+
         ' relink or alignment checks. No scene cuts or other media were changed.'));
     for(const issue of entries)wrapper.append(issueRow(issue));
     list.prepend(wrapper);
   }
   function render(){
     if(current()!==pid)return;
     renderTimeline();renderPreview();renderPopup();
   }
   function check(){
     const id=current();
     if(!id){if(pid)reset();return}
     const fp=clock();
     if(pid!==id){reset();void refresh(true);return}
     if(!inflight&&(fp!==lastFingerprint&&Date.now()-lastFetch>1600||Date.now()-lastFetch>24000)){
       void refresh(true);return;
     }
     render();
   }
   const api=Object.freeze({
     VERSION,classifyProject,getState:()=>({
       projectId:pid,issues:issues.map(x=>({...x})),counts:issues.reduce((a,x)=>
         (a[x.type]=(a[x.type]||0)+1,a),{}),readOnly:true
     }),refresh:()=>refresh(true),openIssue:(screen,kind)=>{
       const issue=issues.find(x=>x.screen===screen&&(!kind||x.kind===kind));
       if(issue)showIssue(issue);return !!issue
     }
   });
   win.DGS167_MISSING_SLOTS=api;
   win.addEventListener('dgs159-matches-applied',()=>void refresh(true));
   win.addEventListener('dgs140f-pending-media',()=>void refresh(true));
   win.addEventListener('dgs140d-align-complete',()=>void refresh(true));
   const start=()=>{check();win.setInterval(check,950)};
   if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start,{once:true});
   else start();
   return api;
 }
 return {VERSION,classifyProject,mount,labelFor};
});

