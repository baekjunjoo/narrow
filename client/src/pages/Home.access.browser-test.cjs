// Run: node client/src/pages/Home.access.browser-test.cjs (Chromium + installed dependencies required).
// Mocks long-running engines only; checks real React DOM transitions, not screen-reader speech.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '../../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narravo-home-access-'));
const fake = {
  'lib/tts-engine': `export class TtsEngine { async generate(o,p){p('모의 제작 중',10);await new Promise(r=>setTimeout(r,350));return {blob:new Blob(['voice']),cues:[],duration:1}} dispose(){} }`,
  'lib/soundscape': `export function hasPendingSoundscapeWork(){return false} export async function waitForSoundscapeIdle(){} export async function mixSoundscape(b,c,o,p,s){window.mixCalls++;window.lastMixOptions={...o};const fail=window.failNextMix;window.failNextMix=false;await new Promise(r=>setTimeout(r,300));if(fail)throw Error('모의 음향 실패');return {blob:new Blob(['mix']),events:[{label:'비',time:0}],warnings:[]}}`,
  'lib/manuscript-import': `export async function extractManuscript(){await new Promise(r=>setTimeout(r,1200));return {text:'파일 원고',warnings:[]}}`,
  'lib/audio-converter': `export class AudioConverter {async convert(f,fmt,p){p('모의 변환 중');await new Promise(r=>setTimeout(r,300));return {blob:new Blob(['converted']),warnings:[],inputChannels:1,outputChannels:1,inputSampleRate:24000,outputSampleRate:24000}}dispose(){}}`,
  'components/QualityPanel': `export default function QualityPanel(){return null}`,
};
const source = `
import React from 'react'; import {createRoot} from 'react-dom/client'; import Home from '${root}/client/src/pages/Home.tsx';
window.React=React; window.confirmAnswer=true; window.confirmMessages=[]; window.confirm=message=>{window.confirmMessages.push(message);return window.confirmAnswer}; window.mixCalls=0;
window.revokedUrls=[]; const revokeUrl=URL.revokeObjectURL.bind(URL); URL.revokeObjectURL=url=>{window.revokedUrls.push(url);revokeUrl(url)};
window.mediaPauseCalls=0; const pauseMedia=HTMLMediaElement.prototype.pause; HTMLMediaElement.prototype.pause=function(){window.mediaPauseCalls++;return pauseMedia.call(this)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const checks=[];
const check=(name,condition,details='')=>checks.push({name,pass:!!condition,details});
const button=t=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(t));
const active=()=>document.activeElement; const body=()=>document.body;
const setValue=(el,value)=>{Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))};
const add=(input,names)=>{let d=new DataTransfer();for(const name of names)d.items.add(new File(['dummy'],name,{type:'audio/wav'}));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
const unload=()=>{let e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented};
const voiceUrl=()=>document.querySelector('.audio-result a.download-btn')?.href;
const mixUrl=()=>document.querySelector('.audio-result a.voice-download')?.href;
const selected=()=>document.querySelector('input[name=play-version]:checked')?.value;
(async()=>{try {
createRoot(document.getElementById('app')).render(React.createElement(Home)); await sleep(80);
check('empty page has no unload guard',!unload());
button('예시 원고 넣기').click(); await sleep(30);
let gen=button('오디오 만들기'); gen.focus();gen.click();await sleep(35);
check('start focus goes to cancel',active()===button('제작 취소'),active().tagName);
check('active generation guards unload',unload());
await sleep(760);
check('completion restores focus',active()===document.querySelector('.audio-result a.download-btn'),active().tagName);
check('generation completion in persistent status', [...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('음성 제작이 완료되었어요')));
check('result guards unload',unload());
check('result explains browser save limit',document.querySelector('.audio-result').textContent.includes('저장 여부'));
const download=document.querySelector('.audio-result a.download-btn');download.addEventListener('click',e=>e.preventDefault(),{once:true});download.click();check('download click does not clear unload protection',unload());
// Move focus to another element while work runs; the completion must never steal it.
gen=button('오디오 만들기');gen.focus();gen.click();await sleep(30);let brand=document.querySelector('.brand');brand.focus();await sleep(760);check('completion does not steal moved focus',active()===brand,active().tagName);
check('new narration generation does not prompt',window.confirmMessages.length===0);
// Cancellation by a non-focused control must not steal focus either.
gen=button('오디오 만들기');gen.focus();gen.click();await sleep(30);brand.focus();button('제작 취소').click();await sleep(30);check('cancel does not steal moved focus',active()===brand,active().tagName);
gen=button('오디오 만들기');gen.focus();gen.click();await sleep(30);button('제작 취소').focus();button('제작 취소').click();await sleep(30);check('cancel restores actionable focus',active()===document.querySelector('.audio-result a.download-btn'),active().tagName);
// Reject a normal remix without changing either file, player, settings, or focus.
document.querySelector('input[value=mixed]').click();setValue(document.querySelector('#music-volume'),'0.7');setValue(document.querySelector('#effects-volume'),'0.3');setValue(document.querySelector('#manuscript'),'수정한 원고');await sleep(30);
let remix=button('완성된 낭독에 음향 설정 다시 적용');let before=window.mixCalls;let oldVoice=voiceUrl();let oldMix=mixUrl();let audio=document.querySelector('.audio-result audio');let oldRevocations=window.revokedUrls.length;let oldPauses=window.mediaPauseCalls;let oldStatus=[...document.querySelectorAll('[role=status]')].map(n=>n.textContent).join('|');
window.confirmAnswer=false;remix.focus();remix.click();await sleep(40);
let prompt=window.confirmMessages.at(-1);
check('normal remix warning explains replacement, deletion and unknown download',prompt.includes('음향 포함 MP3')&&prompt.includes('교체')&&prompt.includes('삭제')&&prompt.includes('다운로드했는지 알 수 없')&&prompt.includes('먼저 다운로드')&&prompt.includes('낭독만'));
check('normal remix rejection does not run mixer',window.mixCalls===before);
check('normal remix rejection preserves both URLs and does not revoke',voiceUrl()===oldVoice&&mixUrl()===oldMix&&window.revokedUrls.length===oldRevocations);
check('normal remix rejection preserves player and mixed selection without pausing',document.querySelector('.audio-result audio')===audio&&audio.src===oldMix&&selected()==='mixed'&&window.mediaPauseCalls===oldPauses);
check('normal remix rejection preserves settings and unapplied state',document.querySelector('#music-volume').value==='0.7'&&document.querySelector('#effects-volume').value==='0.3'&&button('완성된 낭독에 음향 설정 다시 적용')===remix);
check('normal remix rejection preserves focus and status',active()===remix&&[...document.querySelectorAll('[role=status]')].map(n=>n.textContent).join('|')===oldStatus);
document.querySelector('input[value=voice]').click();await sleep(30);audio=document.querySelector('.audio-result audio');oldPauses=window.mediaPauseCalls;remix.focus();remix.click();await sleep(30);
check('normal rejection also preserves voice selection without pausing',selected()==='voice'&&document.querySelector('.audio-result audio')===audio&&audio.src===oldVoice&&window.mediaPauseCalls===oldPauses&&active()===remix&&window.mixCalls===before);
document.querySelector('input[value=mixed]').click();await sleep(30);remix.focus();
// Acceptance retains old files while rendering, then replaces only the mix.
let oldPrompts=window.confirmMessages.length;window.confirmAnswer=true;remix.click();await sleep(40);
check('normal remix acceptance prompts and runs mixer with chosen volumes',window.confirmMessages.length===oldPrompts+1&&window.mixCalls===before+1&&window.lastMixOptions.musicVolume===0.7&&window.lastMixOptions.effectsVolume===0.3);
check('normal remix retains both URLs during processing',voiceUrl()===oldVoice&&mixUrl()===oldMix&&!window.revokedUrls.includes(oldMix));
await sleep(350);
check('normal remix acceptance replaces only mixed URL',voiceUrl()===oldVoice&&mixUrl()&&mixUrl()!==oldMix&&window.revokedUrls.includes(oldMix)&&!window.revokedUrls.includes(oldVoice));
check('normal remix keeps selected mixed version',selected()==='mixed'&&document.querySelector('.audio-result audio').src===mixUrl());
// Failed or cancelled async re-mixes never destroy the previously successful mix.
oldMix=mixUrl();oldRevocations=window.revokedUrls.length;setValue(document.querySelector('#music-volume'),'0.8');await sleep(30);window.failNextMix=true;button('완성된 낭독에 음향 설정 다시 적용').click();await sleep(350);
check('failed remix preserves voice and mixed URLs',voiceUrl()===oldVoice&&mixUrl()===oldMix&&window.revokedUrls.length===oldRevocations&&selected()==='mixed');
check('failed remix reports previous files are intact',document.querySelector('[role=alert]')?.textContent.includes('이전 음향 포함 버전과 낭독만 버전은 그대로'));
before=window.mixCalls;window.confirmAnswer=false;button('완성된 낭독에 음향 설정 다시 적용').click();await sleep(30);
check('rejected retry preserves previous error and files',document.querySelector('[role=alert]')?.textContent.includes('모의 음향 실패')&&voiceUrl()===oldVoice&&mixUrl()===oldMix&&window.mixCalls===before);
window.confirmAnswer=true;
setValue(document.querySelector('#music-volume'),'0.9');await sleep(30);button('완성된 낭독에 음향 설정 다시 적용').click();await sleep(40);button('제작 취소').click();await sleep(350);
check('cancelled in-flight remix preserves previous files and selection',voiceUrl()===oldVoice&&mixUrl()===oldMix&&window.revokedUrls.length===oldRevocations&&selected()==='mixed');
// Zero-volume rejection is also side-effect free; acceptance removes only the mix.
setValue(document.querySelector('#music-volume'),'0');setValue(document.querySelector('#effects-volume'),'0');await sleep(30);
remix=button('완성된 낭독에 음향 설정 다시 적용');before=window.mixCalls;audio=document.querySelector('.audio-result audio');oldRevocations=window.revokedUrls.length;oldPauses=window.mediaPauseCalls;oldPrompts=window.confirmMessages.length;window.confirmAnswer=false;remix.focus();remix.click();await sleep(40);
check('zero-volume remix prompts before deletion',window.confirmMessages.length===oldPrompts+1&&window.confirmMessages.at(-1).includes('교체')&&window.confirmMessages.at(-1).includes('삭제'));
check('zero-volume rejection preserves files, player, selection, settings and focus',window.mixCalls===before&&voiceUrl()===oldVoice&&mixUrl()===oldMix&&window.revokedUrls.length===oldRevocations&&document.querySelector('.audio-result audio')===audio&&window.mediaPauseCalls===oldPauses&&selected()==='mixed'&&document.querySelector('#music-volume').value==='0'&&document.querySelector('#effects-volume').value==='0'&&active()===remix);
oldPrompts=window.confirmMessages.length;window.confirmAnswer=true;remix.click();await sleep(40);
check('zero-volume acceptance prompts again',window.confirmMessages.length===oldPrompts+1);
check('zero-volume remix skips renderer',window.mixCalls===before,'calls '+before+' -> '+window.mixCalls);
check('zero-volume remix removes only old mix',!document.querySelector('input[value=mixed]')&&!mixUrl()&&voiceUrl()===oldVoice&&window.revokedUrls.includes(oldMix)&&!window.revokedUrls.includes(oldVoice));
check('zero-volume settings applied and old voice stays stale',!!document.querySelector('.stale-notice')&&!button('완성된 낭독에 음향 설정 다시 적용'));
check('zero-volume remix has clear explanation',document.querySelector('.version-single')?.textContent.includes('0'));
check('zero-volume remix preserves focus',active()!==body(),active().tagName);
before=window.mixCalls;gen=button('오디오 만들기');gen.click();await sleep(450);check('zero-volume generation skips renderer',window.mixCalls===before&&document.querySelector('.version-single')?.textContent.includes('0'));
let promptCount=window.confirmMessages.length;before=window.mixCalls;window.confirmAnswer=false;setValue(document.querySelector('#music-volume'),'0.5');await sleep(30);remix=button('완성된 낭독에 음향 설정 다시 적용');remix.focus();remix.click();await sleep(30);brand.focus();await sleep(400);
check('remix without existing mix does not prompt and runs mixer',window.confirmMessages.length===promptCount&&window.mixCalls===before+1&&!!mixUrl());window.confirmAnswer=true;
check('remix completion remains in live status',[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('음향을 다시 적용했어요')));
check('remix completion does not steal moved focus',active()===brand,active().tagName);
// Start, stop, and removal focus behavior; focus remains where user moved it.
add(document.querySelector('#batch-files'),['one.wav','two.wav']);await sleep(30);let start=button('대기 항목 변환 시작');start.focus();start.click();await sleep(30);
check('batch start focus goes to stop',active()===button('변환 중단'),active().tagName);
button('변환 중단').focus();button('변환 중단').click();await sleep(30);check('batch stop restores focus',active()===button('대기 항목 변환 시작'),active().tagName);
let remove=document.querySelector('.batch-item .batch-remove');remove.focus();remove.click();await sleep(30);check('remove restores focus',active()!==body(),active().tagName);
start=button('대기 항목 변환 시작');start.focus();start.click();await sleep(500);let clear=button('완료 항목 모두 삭제');clear.focus();clear.click();await sleep(40);check('remove completed restores focus',active()!==body(),active().tagName);
// A stale pending import must keep the lock until the actual read settles.
add(document.querySelector('.manuscript-panel input[type=file]'),['old.pdf']);await sleep(30);button('예시 원고 넣기').click();await sleep(30);check('invalidated file read keeps lock',button('오디오 만들기').disabled && document.querySelector('.editor-note[role=status]').textContent.includes('기다려'));
await sleep(1300);check('invalidated file result discarded after read',!document.querySelector('#manuscript').value.includes('파일 원고')&&!button('오디오 만들기').disabled);
} catch(e){checks.push({name:'harness error',pass:false,details:String(e)+' '+e.stack});} document.getElementById('output').textContent=JSON.stringify(checks);})();`;
const plugin = {name:'mocks',setup(build){build.onResolve({filter:/^@\//},args=>{const name=args.path.slice(2);if(fake[name])return {path:name,namespace:'fake'};const base=path.join(root,'client/src',name);return {path:['','.tsx','.ts','.js'].map(ext=>base+ext).find(fs.existsSync)||base}});build.onLoad({filter:/.*/,namespace:'fake'},args=>({contents:fake[args.path],loader:'tsx'}));}};
(async()=>{try{await esbuild.build({stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,outfile:path.join(tmp,'bundle.js'),format:'iife',platform:'browser',jsx:'automatic',plugins:[plugin],define:{'import.meta.env.BASE_URL':'"/"'},logLevel:'warning'});fs.writeFileSync(path.join(tmp,'fixture.html'),`<!doctype html><html><body><div id="app"></div><pre id="output">waiting</pre><script src="file://${tmp}/bundle.js"></script></body></html>`);const dom=execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--allow-file-access-from-files',`--user-data-dir=${tmp}/profile`,'--virtual-time-budget=12000','--dump-dom',`file://${tmp}/fixture.html`],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','ignore']});const raw=dom.match(/<pre id="output">([\s\S]*?)<\/pre>/)?.[1];if(!raw||raw==='waiting')throw Error('browser test did not complete');const results=JSON.parse(raw.replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));console.log(JSON.stringify(results,null,2));if(results.some(c=>!c.pass))process.exitCode=1;}catch(e){console.error(e);process.exitCode=1;}finally{fs.rmSync(tmp,{recursive:true,force:true});}})();
