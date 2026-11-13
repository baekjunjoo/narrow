import fs from 'node:fs';
const targets = await (await fetch('http://127.0.0.1:9225/json')).json();
const target = targets.find(t => t.type === 'page');
if (!target) throw new Error('No Chromium page');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let seq=0; const pending=new Map(), requests=[];
socket.onmessage = ({data}) => {
  const msg = JSON.parse(data);
  if (msg.id) { const p=pending.get(msg.id); if(p) {pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);} }
  if (msg.method === 'Network.requestWillBeSent') requests.push({url: msg.params.request.url, method: msg.params.request.method});
};
function call(method, params={}) { const id=++seq; return new Promise((resolve,reject) => {pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));}); }
await call('Page.enable'); await call('Network.enable');
await call('Page.navigate',{url:'http://127.0.0.1:3091/'});
await new Promise(r=>setTimeout(r,2000));
const expression = `(async () => {
  const { AudioQualityAnalyzer } = await import('/src/lib/audio-quality.ts');
  const results=[];
  function wave(seconds, channels=1, sample=(i,c)=>0, rate=8000, type='s16') {
    const count=Math.round(seconds*rate), bits=type==='f32'?32:16, data=new ArrayBuffer(count*channels*bits/8), dv=new DataView(data);
    for(let i=0;i<count;i++) for(let c=0;c<channels;c++) {
      const v=sample(i,c), p=(i*channels+c)*bits/8;
      if(bits===32) dv.setFloat32(p,v,true); else dv.setInt16(p,Math.max(-32768,Math.min(32767,Math.round(v*32768))),true);
    }
    const h=new Uint8Array(44), hview=new DataView(h.buffer); const set=(at,s)=>h.set(new TextEncoder().encode(s),at);
    set(0,'RIFF'); hview.setUint32(4,36+data.byteLength,true); set(8,'WAVE'); set(12,'fmt '); hview.setUint32(16,16,true); hview.setUint16(20,bits===32?3:1,true); hview.setUint16(22,channels,true); hview.setUint32(24,rate,true); hview.setUint32(28,rate*channels*bits/8,true); hview.setUint16(32,channels*bits/8,true); hview.setUint16(34,bits,true); set(36,'data'); hview.setUint32(40,data.byteLength,true);
    return new Blob([h,data],{type:'audio/wav'});
  }
  async function run(name,blob,check,expectError=false) {
    const a=new AudioQualityAnalyzer(), progress=[];
    try { const r=await a.analyze(blob,m=>progress.push(m));
      if(expectError) throw new Error('Expected rejection but got report');
      const why=check(r); if(why!==true) throw new Error('Assertion failed: '+why+' report='+JSON.stringify(r));
      results.push({name,pass:true,duration:r.duration,channels:r.channels,sampleRate:r.sampleRate,peakDb:r.peakDb,rmsDb:r.rmsDb,silentRegions:r.silentRegions,issues:r.issues.map(x=>x.message),progress:progress.length,bytes:blob.size});
    } catch(e) { if(expectError && !e.message.startsWith('Expected rejection') && (typeof expectError !== 'string' || e.message.includes(expectError))) results.push({name,pass:true,rejected:e.message,bytes:blob.size}); else results.push({name,pass:false,error:e.message}); }
    finally { a.dispose(); }
  }
  const has=(r,s)=>r.issues.some(x=>x.message.includes(s));
  await run('silent WAV',wave(4),r=>r.duration===4 && r.peakDb===null && r.rmsDb===null && r.silentRegions.length===1 && r.silentRegions[0].start===0 && r.silentRegions[0].end===4);
  await run('short WAV Blob',wave(.2,1,()=>.5),r=>Math.abs(r.duration-.2)<.001 && Math.abs(r.rmsDb+6.0206)<.001 && !r.silentRegions.length);
  await run('loud WAV repeated digital ceiling',wave(1,1,()=>1),r=>r.peakDb>-.01 && has(r,'클리핑 의심'));
  await run('stereo one channel silent File',new File([wave(4,2,(i,c)=>c?0.5:0)],'stereo.wav',{type:'audio/wav'}),r=>r.channels===2 && r.silentRegions.length===0 && Math.abs(r.rmsDb+9.0309)<.001);
  await run('stereo opposite phase',wave(4,2,(i,c)=>c?-.5:.5),r=>r.channels===2 && !r.silentRegions.length && Math.abs(r.rmsDb+6.0206)<.001);
  await run('volume variation experimental',wave(10,1,i=>i<40000?.5:.1),r=>has(r,'구간별 음량 차이 의심'));
  await run('valid float WAV',wave(1,1,()=>.25,8000,'f32'),r=>Math.abs(r.rmsDb+12.0412)<.002);
  await run('non-finite float WAV',wave(1,1,(i)=>i===200?NaN:.25,8000,'f32'),()=>true,'NaN 또는 Infinity');
  const source=wave(4,1,()=>.25); await run('truncated RIFF WAV',source.slice(0,source.size-100),()=>true,true);
  await run('corrupt signature',new Blob(['not an audio file']),()=>true,true);
  const get=async name=>await (await fetch('/quality-test-fixtures/'+name)).blob();
  await run('24-bit WAV',await get('normal24.wav'),r=>Math.abs(r.duration-3)<.01 && r.peakDb < -17 && r.peakDb > -19);
  await run('24-bit FLAC',await get('normal24.flac'),r=>Math.abs(r.duration-3)<.01 && r.peakDb < -17 && r.peakDb > -19);
  await run('MP3 without declared length',await get('no-xing.mp3'),r=>has(r,'원본 전체 길이를 검증할 수 없습니다'));
  await run('normal MP3',await get('normal.mp3'),r=>r.duration>11.9 && r.duration<12.1 && r.channels===1 && has(r,'16비트'));
  await run('truncated MP3',await get('truncated.mp3'),()=>true,true);
  await run('frame-boundary truncated MP3',await get('truncated-boundary.mp3'),()=>true,'선언된 길이보다');
  await run('normal FLAC',await get('normal.flac'),r=>Math.abs(r.duration-12)<.01);
  await run('truncated FLAC',await get('truncated.flac'),()=>true,true);
  await run('frame-boundary truncated FLAC',await get('truncated-boundary.flac'),()=>true,'선언된 샘플 수');
  const unknownFlac = new Uint8Array(await (await get('normal.flac')).arrayBuffer()); unknownFlac[21] &= 0xf0; unknownFlac.fill(0,22,26);
  await run('FLAC unknown declared length',new Blob([unknownFlac]),r=>has(r,'전체 샘플 수가 없어'));
  // A 129 MiB JUNK metadata chunk proves a real uploaded >128 MiB WAV can be traversed without decoding/storing its entire contents.
  const raw=wave(1,1,()=>.25); const rawBytes=new Uint8Array(await raw.arrayBuffer());
  const junkSize=129*1024*1024, head=rawBytes.slice(0,36), hv=new DataView(head.buffer); hv.setUint32(4, raw.size-8+8+junkSize,true);
  const junkHead=new Uint8Array(8); junkHead.set(new TextEncoder().encode('JUNK')); new DataView(junkHead.buffer).setUint32(4,junkSize,true);
  const zero=new Uint8Array(1024*1024), big=new File([head,junkHead,...Array(129).fill(zero),rawBytes.slice(36)],'large.wav',{type:'audio/wav'});
  await run('129 MiB user File metadata seek',big,r=>r.duration===1 && Math.abs(r.rmsDb+12.0412)<.002);
  // This second large File contains actual PCM, not padding, so the worker must scan every sample.
  const pcmHeader=rawBytes.slice(0,44), ph=new DataView(pcmHeader.buffer);
  ph.setUint32(4,36+junkSize,true); ph.setUint32(40,junkSize,true);
  const bigPcm=new File([pcmHeader,...Array(129).fill(zero)],'long-silence.wav',{type:'audio/wav'});
  await run('129 MiB PCM body streamed',bigPcm,r=>r.duration===junkSize/2/8000 && r.peakDb===null && r.silentRegions.length===1 && r.silentRegions[0].end===r.duration);
  return results;
})()`;
const out = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:180000});
if(out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails));
const result=out.result.value;
const evidence={date:new Date().toISOString(), browser:'Chromium 156 headless via Chrome DevTools Protocol', server:'http://127.0.0.1:3091', cases:result, network:requests, summary:{passed:result.filter(x=>x.pass).length, failed:result.filter(x=>!x.pass).length}};
fs.writeFileSync('/tmp/audio-quality-browser-evidence.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
socket.close();
if(evidence.summary.failed) process.exitCode=1;
