import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import SoundRules, { readSoundRules, saveSoundRules } from "./SoundRules";
import type { SoundRuleSettings } from "../lib/soundscape";

const KEY = "narravo.sound-rules.v1";
const blank = (): SoundRuleSettings => ({ disabledBuiltins: [], customRules: [] });
const rule = (id: string, phrase = "비") => ({ id, phrase, effect: "rain" as const, enabled: true });
const storage = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(KEY, initial);
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
};
const useStorage = (store: ReturnType<typeof storage>, confirm = () => true) =>
  vi.stubGlobal("window", { localStorage: store, confirm });
afterEach(() => vi.unstubAllGlobals());

describe("sound rule storage", () => {
  it("is safe without a browser and when localStorage is denied", async () => {
    vi.stubGlobal("window", undefined);
    const result = readSoundRules();
    expect(result).toEqual({ settings: blank(), warning: "", snapshot: null });
    expect((await saveSoundRules(blank(), result.snapshot)).warning).toContain("저장 실패");
    vi.stubGlobal("window", { get localStorage() { throw new DOMException("denied", "SecurityError"); } });
    expect(readSoundRules().settings).toEqual(blank());
    expect(readSoundRules().warning).not.toBe("");
    expect((await saveSoundRules(blank(), readSoundRules().snapshot)).warning).toContain("저장 실패");
  });
  it("renders safely without a browser", () => {
    vi.stubGlobal("window", undefined);
    const html = renderToString(createElement(SoundRules, { value: blank(), onChange: () => {} }));
    expect(html).toContain("기본 단서");
    expect(html).toContain("찾을 문구");
  });
  it("round trips normalized phrases and six effect names", async () => {
    const store = storage(); useStorage(store);
    const settings: SoundRuleSettings = {
      disabledBuiltins: ["rain", "forest", "ocean", "footsteps", "door", "page"],
      customRules: [rule("one", "  가  ")],
    };
    expect((await saveSoundRules(settings, readSoundRules().snapshot)).warning).toBe("");
    expect(settings.customRules[0].phrase).toBe("  가  ");
    const restored = readSoundRules();
    expect(restored.settings).toEqual({ ...settings, customRules: [rule("one", "가")] });
    expect(restored.warning).toBe("");
  });
  it("preserves old data when settings are invalid or writes fail", async () => {
    const store = storage("original"); useStorage(store);
    const snapshot = readSoundRules().snapshot;
    const malformed = [
      { ...blank(), customRules: [rule("same"), rule("same")] },
      { ...blank(), customRules: [rule("", "valid")] },
      { ...blank(), customRules: [rule("a", "  ")] },
      { ...blank(), customRules: [rule("a", "🙂".repeat(81))] },
      { ...blank(), customRules: [{ ...rule("a"), effect: "thunder" }] },
      { ...blank(), customRules: [{ ...rule("a"), enabled: "yes" }] },
      { ...blank(), customRules: Array.from({ length: 51 }, (_, i) => rule(String(i))) },
      { ...blank(), disabledBuiltins: ["rain", "rain"] },
    ];
    for (const value of malformed) {
      expect((await saveSoundRules(value as SoundRuleSettings, snapshot)).warning).not.toBe("");
      expect(store.data.get(KEY)).toBe("original");
    }
    vi.stubGlobal("window", { localStorage: { ...store, setItem() { throw new DOMException("quota", "QuotaExceededError"); } }, confirm: () => true });
    expect((await saveSoundRules(blank(), snapshot)).warning).toContain("저장 실패");
    expect(store.data.get(KEY)).toBe("original");
  });
  it("filters corrupt data without writing and confirms before replacement", async () => {
    const raw = JSON.stringify({disabledBuiltins:["rain","rain","bad"],customRules:[rule("ok","  가 "), rule("ok","duplicate"),rule("bad"," ")]});
    const store=storage(raw); useStorage(store, () => false);
    const result=readSoundRules();
    expect(result.warning).not.toBe("");
    expect(result.settings).toEqual({disabledBuiltins:["rain"],customRules:[rule("ok","가")]});
    expect(result.snapshot?.requiresConfirmation).toBe(true);
    expect(store.data.get(KEY)).toBe(raw);
    const rejected=await saveSoundRules(result.settings,result.snapshot);
    expect(rejected.warning).toContain("취소");
    expect(store.data.get(KEY)).toBe(raw);
    useStorage(store, () => true);
    const accepted=await saveSoundRules(result.settings,result.snapshot);
    expect(accepted.warning).toBe("");
    expect(JSON.parse(store.data.get(KEY)!)).toEqual(result.settings);
  });
  it("handles malformed, oversized and wrong-shape values without writing", () => {
    for (const raw of ["{", "[]", JSON.stringify({disabledBuiltins:null}), "x".repeat(100001)]) {
      const store=storage(raw); useStorage(store);
      const result=readSoundRules();
      expect(result.warning).not.toBe("");
      expect(result.settings).toEqual(blank());
      expect(result.snapshot?.requiresConfirmation).toBe(true);
      expect(store.data.get(KEY)).toBe(raw);
    }
  });
  it("allows 80 Unicode code points and rejects 81", async () => {
    const store=storage(); useStorage(store);
    const ok=await saveSoundRules({...blank(),customRules:[rule("emoji","🙂".repeat(80))]},readSoundRules().snapshot);
    expect(ok.warning).toBe("");
    const previous=store.data.get(KEY);
    expect((await saveSoundRules({...blank(),customRules:[rule("emoji","🙂".repeat(81))]},ok.snapshot)).warning).not.toBe("");
    expect(store.data.get(KEY)).toBe(previous);
  });
  it("does not overwrite a prior change from another tab", async () => {
    const store=storage(); useStorage(store);
    const tabA=readSoundRules().snapshot, tabB=readSoundRules().snapshot;
    const a=await saveSoundRules({...blank(),disabledBuiltins:["rain"]},tabA);
    const raw=store.data.get(KEY);
    const b=await saveSoundRules({...blank(),disabledBuiltins:["door"]},tabB);
    expect(a.warning).toBe("");
    expect(b.warning).toContain("다른 탭");
    expect(store.data.get(KEY)).toBe(raw);
    expect(readSoundRules().settings.disabledBuiltins).toEqual(["rain"]);
  });
  it("checks for changed data again after repair confirmation", async () => {
    const store=storage("broken");
    useStorage(store, () => {store.data.set(KEY,"changed by another tab"); return true;});
    const result=readSoundRules();
    const saved=await saveSoundRules(blank(),result.snapshot);
    expect(saved.warning).toContain("다른 탭");
    expect(store.data.get(KEY)).toBe("changed by another tab");
  });
});

// No browser-testing library is needed: bundle a tiny fixture and use Chromium's
// DevTools protocol. Run only these tests: pnpm exec vitest run client/src/components/SoundRules.test.ts
it.skipIf(
  spawnSync("chromium", ["--version"], { stdio: "ignore" }).status !== 0
)(
  "supports accessible editing, confirmation, focus, limits and disabled state in Chromium",
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const temp = mkdtempSync(join(tmpdir(), "narravo-soundrules-"));
    const component = resolve(import.meta.dirname, "SoundRules.tsx");
    const fixture = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import SoundRules from ${JSON.stringify(component)};
    function App(){
      const [value,setValue]=useState({disabledBuiltins:[],customRules:[]});
      const [disabled,setDisabled]=useState(false);
      window.current=value; window.calls=window.calls||0;
      window.setValue=setValue; window.setDisabled=setDisabled;
      return <SoundRules value={value} disabled={disabled} storageError="저장 경고" onChange={v=>{window.calls++; if(window.failUpdate)throw Error('failed'); setValue(v)}}/>;
    }
    const sleep=()=>new Promise(r=>setTimeout(r,30));
    const checks=[]; function check(name,condition){checks.push({name,pass:!!condition});}
    const button=t=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t);
    const input=()=>document.querySelector('.sound-rules-editor input');
    function type(value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input(),value); input().dispatchEvent(new Event('input',{bubbles:true}));}
    function clickName(name){const el=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')?.includes(name)); if(!el)throw Error('missing button '+name);el.focus();el.click();}
    window.confirm=()=>true;
    (async()=>{try{
      createRoot(document.querySelector('#app')).render(<App/>);await sleep();
      check('six builtin controls',document.querySelectorAll('.sound-rules-builtins input').length===6);
      check('storage warning present',document.querySelector('[role=status]').textContent.includes('저장 경고'));
      check('disabled semantics described',document.body.textContent.includes('사용자 규칙은 따로 적용'));
      button('규칙 추가').click();await sleep();check('empty input rejected with status and focus',window.calls===0&&input().getAttribute('aria-invalid')==='true'&&document.activeElement===input()&&document.querySelector('.sound-rules-status').textContent.includes('1~80'));
      type('  가  ');await sleep();button('규칙 추가').click();await sleep();check('NFC trim and focus after add',window.current.customRules[0].phrase==='가'&&document.activeElement===input());
      const firstId=window.current.customRules[0].id;
      document.querySelector('.sound-rules-builtins input').click();await sleep();check('builtin independent of custom',window.current.disabledBuiltins.includes('rain')&&window.current.customRules[0].enabled);
      type('가');await sleep();button('규칙 추가').click();await sleep();check('duplicate phrases have unique row names',[...document.querySelectorAll('.sound-rules-item button')].filter(b=>b.getAttribute('aria-label').includes('수정')).map(b=>b.getAttribute('aria-label')).join('|').includes('2번'));
      clickName('1번 규칙 가 수정');await sleep();check('edit moves focus to input',document.activeElement===input()&&input().value==='가');
      type('');await sleep();button('수정 적용').click();await sleep();check('invalid edit leaves old value intact',window.current.customRules[0].phrase==='가'&&input().getAttribute('aria-invalid')==='true');
      type('수정 중');await sleep();window.confirm=()=>false;clickName('2번 규칙 가 수정');await sleep();check('unsaved draft protected when switching',input().value==='수정 중');
      window.setValue({...window.current,customRules:window.current.customRules.map((r,i)=>i===0?{...r,enabled:false}:r)});await sleep();button('수정 적용').click();await sleep();check('concurrent change prevents overwrite while keeping draft',input().value==='수정 중'&&window.current.customRules[0].phrase==='가'&&document.querySelector('.sound-rules-status').textContent.includes('다른 곳에서 변경'));
      window.setValue({...window.current,customRules:window.current.customRules.map((r,i)=>i===0?{...r,enabled:true}:r)});await sleep();
      window.confirm=()=>true;button('수정 적용').click();await sleep();check('edit applied and focus returns to row',window.current.customRules[0].phrase==='수정 중'&&document.activeElement.getAttribute('aria-label').includes('수정'));
      document.querySelector('.sound-rules-item input').click();await sleep();check('custom enable checkbox toggles',!window.current.customRules[0].enabled);
      window.confirm=()=>false;clickName('1번 규칙 수정 중 삭제');await sleep();check('cancelled deletion preserved',window.current.customRules.length===2);
      window.confirm=()=>true;clickName('1번 규칙 수정 중 삭제');await sleep();check('delete and focus next',window.current.customRules.length===1&&document.activeElement.getAttribute('aria-label').includes('1번 규칙'));
      clickName('1번 규칙 가 삭제');await sleep();check('last delete focuses input',window.current.customRules.length===0&&document.activeElement===input());
      window.failUpdate=true;type('유지할 입력');await sleep();button('규칙 추가').click();await sleep();check('failed parent update keeps draft',input().value==='유지할 입력'&&document.querySelector('.sound-rules-status').textContent.includes('유지'));
      window.failUpdate=false;window.setValue({disabledBuiltins:[],customRules:Array.from({length:50},(_,i)=>({id:'id-'+i,phrase:'문구'+i,effect:'rain',enabled:true}))});await sleep();button('규칙 추가').click();await sleep();check('50-rule maximum keeps input',window.current.customRules.length===50&&input().value==='유지할 입력'&&document.querySelector('.sound-rules-status').textContent.includes('50개'));
      window.setDisabled(true);await sleep();const before=window.calls;button('규칙 추가').click();await sleep();check('fieldset disables all controls',document.querySelector('.sound-rules-controls').disabled&&window.calls===before);
    }catch(e){checks.push({name:'harness: '+String(e)+' '+e.stack,pass:false})}document.querySelector('#output').textContent=JSON.stringify(checks)})();
  `;
    let browser: ReturnType<typeof spawn> | undefined;
    try {
      await build({
        stdin: { contents: fixture, resolveDir: root, loader: "tsx" },
        bundle: true,
        outfile: join(temp, "fixture.js"),
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        logLevel: "silent",
      });
      writeFileSync(
        join(temp, "fixture.html"),
        `<!doctype html><html lang="ko"><head><link rel="stylesheet" href="fixture.css"></head><body><div id="app"></div><pre id="output">waiting</pre><script src="fixture.js"></script></body></html>`
      );
      const profile = join(temp, "profile");
      browser = spawn(
        "chromium",
        [
          "--headless",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-background-networking",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          `file://${join(temp, "fixture.html")}`,
        ],
        { stdio: "ignore", detached: true }
      );
      const sleep = (ms: number) =>
        new Promise(resolve => setTimeout(resolve, ms));
      let port = "";
      for (let i = 0; i < 150 && !port; i++) {
        try {
          port = readFileSync(
            join(profile, "DevToolsActivePort"),
            "utf8"
          ).split("\n")[0];
        } catch {
          await sleep(50);
        }
      }
      if (!port) throw new Error("Chromium DevTools did not start");
      const targets = (await (
        await fetch(`http://127.0.0.1:${port}/json`)
      ).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const target = targets.find(item => item.type === "page");
      if (!target) throw new Error("No Chromium page");
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = reject;
      });
      let result: any;
      for (let id = 1; id <= 20; id++) {
        const response = new Promise<any>((resolve, reject) => {
          socket.onmessage = event => {
            const message = JSON.parse(String(event.data));
            if (message.id === id)
              message.error ? reject(message.error) : resolve(message.result);
          };
        });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: {
              expression: `new Promise((resolve,reject)=>{const start=Date.now();const t=setInterval(()=>{const s=document.querySelector('#output')?.textContent;if(s&&s!=='waiting'){clearInterval(t);resolve(s)}else if(Date.now()-start>20000){clearInterval(t);reject(Error('browser timeout'))}},25)})`,
              awaitPromise: true,
              returnByValue: true,
            },
          })
        );
        try {
          result = await response;
          break;
        } catch (error) {
          if (!String((error as { message?: string }).message).includes("Execution context was destroyed") || id === 20) throw error;
          await sleep(50);
        }
      }
      socket.close();
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      const checks = JSON.parse(result.result.value) as {
        name: string;
        pass: boolean;
      }[];
      expect(checks.filter(check => !check.pass)).toEqual([]);
      expect(checks.length).toBeGreaterThanOrEqual(15);
    } finally {
      if (browser) {
        try {
          if (browser.pid) process.kill(-browser.pid, "SIGTERM");
        } catch {
          browser.kill("SIGTERM");
        }
        await new Promise<void>(resolve => {
          if (browser!.exitCode !== null) return resolve();
          browser!.once("exit", () => resolve());
          setTimeout(resolve, 1000);
        });
      }
      rmSync(temp, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
  30000
);
