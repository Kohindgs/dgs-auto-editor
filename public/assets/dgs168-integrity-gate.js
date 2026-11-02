/* V168 asset-integrity check: reports verified server availability and playback.
 * Read-only; does NOT declare semantic Smart Match passed without content analysis.
 */
(function(root,factory){
 'use strict';
 const core=factory();
 if(typeof module==='object'&&module.exports)module.exports=core;
 if(root?.document)root.DGS168_INTEGRITY=core.start(root);
})(typeof window==='object'?window:null,function(){
 'use strict';
 const BASE='/dgs-editor-benchmarks-20261029',VERSION='V168-INTEGRITY-FAIL-CLOSED-20261102';
 const po=(x)=>Number.isFinite(Number(x))?Number(x):0;
 async function inspectProject(project,doHead,playback=[]){
  const id=String(project?.project_id||project?.id||'').trim();
  const media=Array.isArray(project?.media)?project.media:[];
  const scenes=Array.isArray(project?.scenes)?project.scenes:[];
  const clips=Array.isArray(project?.timeline?.clips)?project.timeline.clips:[];
  const needNarration=Boolean((project?.voiceover?.filename||'')||
   scenes.some(s=>s?.voiceover_text&&!s?.is_poem&&!s?.narration_silent_visual));
  const needPoem=Boolean((project?.poem_voiceover?.filename||'')||
   scenes.some(s=>s?.is_poem));
  let pending=0;let n=0;
  const files=media.map(m=>({id:m.id,filename:m.filename,kind:m.kind||'media',
    localOnly:!!m.local_only,expectedBytes:po(m.size),http:0,contentType:'',length:0,verified:false}));
  const HEAD=async(url)=>{
   try{return await doHead(url)}catch(e){return{http:0,error:String(e?.message||e)}}
  };
  const run=Array.from({length:Math.min(8,files.length)||1},async()=>{
    while(n<files.length){
      const item=files[n++];
      const p=await HEAD(BASE+'/api/projects/'+encodeURIComponent(id)+
       '/media-file/'+encodeURIComponent(item.id));
      item.http=Number(p.http||0);item.contentType=String(p.contentType||'');
      item.length=po(p.length);
      // 200 OK with an HTML fallback is still a missing asset.
      item.verified=item.http===200 &&
        !/text\/html|application\/json/i.test(item.contentType) &&
        (!item.expectedBytes||item.length===item.expectedBytes);
    }
  });
  await Promise.all(run);
  const audio={};
  for(const [key,required] of [['narration',needNarration],['poem',needPoem]]){
   const result=required?await HEAD(BASE+'/api/projects/'+encodeURIComponent(id)+'/audio/'+key):null;
   audio[key]={required,http:result?.http||0,contentType:result?.contentType||'',
    reachable:!required||(Number(result?.http)===200 &&
     /audio\/|application\/octet-stream/i.test(String(result?.contentType||''))),playback:'NOT_VERIFIED'};
  }
  for(const a of playback){
   if(!a||!(a.kind in audio)||!audio[a.kind].required)continue;
   if(a.errorCode)audio[a.kind].playback='FAILED (browser media error '+a.errorCode+')';
   else if(a.readyState>=2)audio[a.kind].playback='DECODED (audible output not tested)';
   else audio[a.kind].playback='NOT_VERIFIED';
  }
  const successful=files.filter(x=>x.verified).length;
  const missing=files.filter(x=>x.http===404).length;
  const otherFailures=files.filter(x=>!x.verified&&x.http!==404).length;
  const assetReady=successful===files.length && media.length>0;
  const audioReady=audio.narration.reachable&&audio.poem.reachable;
  const failedPlayback=Object.values(audio).some(x=>x.required&&x.playback.startsWith('FAILED'));
  const unmetAssets=files.filter(x=>!x.verified).map(x=>({name:x.filename,http:x.http,kind:x.kind,localOnly:x.localOnly,contentType:x.contentType,actualBytes:x.length}));
  return {
   VERSION,projectId:id,sceneCount:scenes.length,clipCount:clips.length,
   mediaRecords:media.length,mediaAvailable:successful,mediaMissing:missing,
   mediaOtherFailures:otherFailures,unmetAssets, audio, assetReady,audioReady,
   failedPlayback,contentMatching:'NOT_RUN',
   // A filename and script similarity are NOT evidence for OCR/VLM content agreement.
   benchmarkReady:false,
   verdict:!assetReady||!audioReady||failedPlayback?'BLOCKED':'NOT_VERIFIED',
   note:!assetReady||!audioReady?'Asset/audio transfer is incomplete. Do not benchmark.':
     'Asset requests succeeded, but playback and semantic Smart Match still require independent checks.',
   checkedAt:new Date().toISOString()
  };
 }
 function start(win){
  if(win.DGS168_INTEGRITY)return win.DGS168_INTEGRITY;
  let projectId='',status='idle',report=null,task=null,checked=0,epoch=0;
  const current=()=>win.DGS140C_GET_SMART_CONTEXT?.()?.projectId||
    win.DGS140_GET_STATE?.()?.projectId||'';
  const head=async(url)=>{
   const r=await win.fetch(url,{method:'HEAD',cache:'no-store',
    credentials:'same-origin',signal:AbortSignal.timeout(13000)});
   return{http:r.status,contentType:r.headers.get('content-type'),
     length:r.headers.get('content-length')};
  };
  const playbacks=()=>{
   const audios=[...win.document.querySelectorAll('audio')];
   return audios.map(a=>{
     const src=a.currentSrc||a.src||'';
     return{kind:src.includes('/audio/poem')?'poem':
       src.includes('/audio/narration')?'narration':null,
       errorCode:Number(a.error?.code||0),readyState:Number(a.readyState||0)};
   }).filter(x=>x.kind);
  };
  async function check(force){
   const id=current();
   if(!id){projectId='';report=null;status='idle';render();return null}
   if(task&&!force)return task;
   if(!force&&id===projectId&&Date.now()-checked<45000)return report;
   const serial=++epoch;
   projectId=id;status='checking';render();
   task=(async()=>{
    try{
     const url=BASE+'/api/projects/'+encodeURIComponent(id)+'/load';
     const p=await win.fetch(url,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(18000)});
     if(!p.ok)throw Error('Project load HTTP '+p.status);
     const data=await p.json();data.project_id=id;
     const r=await inspectProject(data,head,playbacks());
     if(serial===epoch&&current()===id){report=r;status='finished';checked=Date.now();render()}
     return r;
    }catch(e){
     if(serial===epoch&&current()===id){
       report={VERSION,projectId:id,benchmarkReady:false,verdict:'CHECK_FAILED',
         note:String(e.message||e),checkedAt:new Date().toISOString()};
       status='failed';checked=Date.now();render()
     }
     return report;
    }finally{if(serial===epoch)task=null}
   })();return task;
  }
  const mk=(tag,cls,label)=>{
   const x=win.document.createElement(tag);
   if(cls)x.className=cls;if(label!==undefined)x.textContent=label;return x;
  };
  function render(){
    const host=win.document.querySelector('#dgs140d-list');
    if(!host)return;
    const old=host.querySelector('#dgs168-integrity-panel');
    if(!projectId||current()!==projectId){old?.remove();return}
    if(old?.dataset?.fingerprint===JSON.stringify({id:projectId,report,status}))return;
    const panel=mk('section','dgs168-integrity-panel');panel.id='dgs168-integrity-panel';
    panel.dataset.fingerprint=JSON.stringify({id:projectId,report,status});
    panel.append(mk('h4',null,'Live Asset & Audio Verification'));
    if(status==='checking'){
     panel.append(mk('p',null,'Checking real server media and audio URLs for this chapter�?�'));
    }else if(report){
     const failure=report.verdict==='BLOCKED'||report.verdict==='CHECK_FAILED';
     const headline=mk('strong',failure?'dgs168-fail':'dgs168-pending',
       failure?'BENCHMARK BLOCKED':'BENCHMARK NOT VERIFIED');
     panel.append(headline);
     if(report.mediaRecords!==undefined){
      panel.append(mk('p',null,'Server media: '+report.mediaAvailable+'/'+report.mediaRecords+
        ' reachable; '+report.mediaMissing+' return 404.'));
      for(const [type,data] of Object.entries(report.audio||{})){
       if(!data.required)continue;
       panel.append(mk('p',null,
         (type==='poem'?'Poem audio':'Narration audio')+': HTTP '+data.http+
         ' A� '+data.playback));
      }
      panel.append(mk('p','dgs168-note','OCR / visual-content-to-narration match: NOT RUN. A media filename match does not prove the visual is correct.'));
      if(report.mediaMissing)panel.append(mk('p','dgs168-note','Media records exist but file bytes are unavailable from the live server. Re-upload/synchronize the original assets. Do not change scene cuts.'));
      if(report.unmetAssets?.length)panel.append(mk('p','dgs168-samples',
         'Unavailable examples: '+report.unmetAssets.slice(0,5).map(x=>x.name).join(', ')+
         (report.unmetAssets.length>5?'�?�':'')
      ));
     }
     panel.append(mk('small',null,'Project '+projectId+' A� '+String(report.checkedAt||'')+
       ' A� No project modifications'));
    }else panel.append(mk('p',null,'Availability not checked.'));
    old?.replaceWith(panel);
    if(!old)host.prepend(panel);
  }
  let last='';
  const heartbeat=()=>{
    const id=current();
    if(id!==last){last=id;projectId='';report=null;status='idle';checked=0;epoch++;task=null}
    if(!id)return;
    render();
    if(!task&&(!checked||Date.now()-checked>45000)&&
      win.DGS140F_VISUAL_QA?.getState?.()?.open===true&&win.document.querySelector('#dgs140d-list'))
      void check(false);
  };
  const api=Object.freeze({VERSION,inspectProject,getState:()=>({status,report}),
    refresh:()=>check(true),isBenchmarkReady:()=>Boolean(report?.benchmarkReady)});
  win.DGS168_INTEGRITY=api;
  const init=()=>{
   heartbeat();
   win.setInterval(heartbeat,1350);
   win.addEventListener('dgs159-matches-applied',()=>void check(true));
   win.addEventListener('dgs140d-align-complete',()=>void check(true));
  };
  if(win.document.readyState==='loading')win.document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
  return api;
 }
 return{VERSION,inspectProject,start};
});

