// Headless UI regression. Build first; requires Google Chrome on macOS.
// Desktop RPCs and WebRTC are mocked; no real display or input is changed.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { parse, stringify } = require('superjson');
const dir = await mkdtemp(path.join(tmpdir(), 'lanfly-chat-ui-'));
const children = [];
let ws;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function start(name) {
  const p = spawn(
    process.execPath,
    [
      'dist/cli.js',
      '123456',
      '--no-open',
      '--no-discovery',
      '--port',
      '0',
      '--name',
      name,
      '--out',
      path.join(dir, name),
    ],
    {
      env: { ...process.env, LANFLY_CONFIG_DIR: path.join(dir, name + '-config') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(p);
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(Error('Server startup timeout: ' + text)), 10000);
    p.stdout.on('data', (b) => {
      text += b;
      const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ base: m[0], port: Number(m[1]) });
      }
    });
    p.stderr.on('data', (b) => {
      text += b;
    });
    p.on('error', reject);
  });
}
async function rpc(server, name, input) {
  const r = await fetch(server.base + '/__rpc/' + name, {
    method: 'POST',
    body: input === undefined ? undefined : stringify(input),
  });
  const [error, data] = parse(await r.text());
  if (error) throw Error(name + ': ' + error.code);
  return data;
}
async function chrome() {
  const p = spawn(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--user-data-dir=' + path.join(dir, 'chrome'),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  children.push(p);
  const url = await new Promise((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(Error('Chrome timeout: ' + logs)), 15000);
    p.stderr.on('data', (b) => {
      logs += b;
      const m = logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    p.on('error', reject);
  });
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let counter = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.exceptionThrown')
      console.error('Browser exception:', JSON.stringify(m.params));
    const item = pending.get(m.id);
    if (item) {
      pending.delete(m.id);
      if (m.error) item.reject(Error(JSON.stringify(m.error)));
      else item.resolve(m.result);
    }
  };
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++counter;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}
try {
  const a = await start('Controlled UI'),
    b = await start('Controller Peer');
  await rpc(a, 'connectPeer', { address: '127.0.0.1:' + b.port });
  const peer = (await rpc(b, 'appState')).self;
  const session = {
    sessionId: 'minimize-test',
    role: 'controller',
    peerId: peer.id,
    peerName: peer.name,
    phase: 'accepted',
    controlRequested: true,
    control: true,
    width: 1440,
    height: 900,
    createdAt: Date.now(),
  };
  const call = await chrome();
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const run = (method, params = {}) => call(method, params, sessionId);
  await run('Page.enable');
  await run('Runtime.enable');
  await run('Page.addScriptToEvaluateOnNewDocument', {
    source: `(()=>{const ES=window.EventSource;window.EventSource=class extends ES{addEventListener(type,fn,...rest){if(type==='reload')return;return super.addEventListener(type,fn,...rest);}};const original=window.fetch;window.desktopCalls=[];window.requests=[];window.errors=[];window.addEventListener('error',e=>window.errors.push(String(e.error??e.message)));window.addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));const ce=console.error;console.error=(...args)=>{window.errors.push(args.map(String));ce(...args);};window.sent=[];window.dimensionsReady=false;
 Object.defineProperties(HTMLVideoElement.prototype,{videoWidth:{get:()=>window.dimensionsReady?1440:0},videoHeight:{get:()=>window.dimensionsReady?900:0}});
 window.RTCPeerConnection=class{connectionState='new';localDescription={sdp:'mock-offer'};createDataChannel(){this.dc={readyState:'connecting',send:v=>window.sent.push(JSON.parse(v)),close(){}};return this.dc;}addTransceiver(){}async createOffer(){return {type:'offer',sdp:'mock-offer'};}async setLocalDescription(){}async setRemoteDescription(){this.connectionState='connected';this.onconnectionstatechange?.();this.dc.readyState='open';this.dc.onopen?.();this.ontrack?.({streams:[new MediaStream()]});}async addIceCandidate(){}close(){}};
window.fetch=async(url,opts)=>{if(typeof url==='string'&&url.startsWith('/__rpc/desktop')){window.desktopCalls.push(url);if(opts?.body)window.requests.push({url,input:JSON.parse(opts.body).json});const name=url.slice('/__rpc/'.length);const data=name==='desktopState'?{sessions:[],resolutions:{[${JSON.stringify(peer.name)}]:'fit'}}:name==='desktopDisplay'?{supported:true,current:{width:2560,height:1600},modes:[{width:1280,height:800},{width:1440,height:900},{width:2560,height:1600}]}:name==='desktopRequest'?${JSON.stringify(session)}:name==='desktopOffer'?{sdp:'mock-answer',width:1440,height:900}:name==='desktopKeyboard'?{supported:false,active:false,events:[]}:name==='desktopStatus'?{supported:true,available:true,screenRecording:true,accessibility:true,inputMonitoring:true,screens:1,display:{width:2940,height:1912,logicalWidth:1470,logicalHeight:956,scale:2}}:{};return new Response(JSON.stringify({json:[null,data]}),{status:200});}return original(url,opts);};})()`,
  });
  const evaluate = async (expression) => {
    const r = await run('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  async function wait(expression, label) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await pause(50);
    }
    console.error('Page body:', await evaluate('document.body.innerText'));
    console.error(
      'Diagnostics:',
      await evaluate(
        `({errors:window.errors,calls:window.desktopCalls,requests:window.requests,dialogs:Array.from(document.querySelectorAll('dialog')).map(e=>({open:e.open,html:e.outerHTML}))})`,
      ),
    );
    throw Error('Timed out: ' + label);
  }
  await run('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await run('Page.navigate', { url: a.base });
  await wait(`Boolean(document.querySelector('button[aria-label="远程桌面"]'))`, 'desktop launch');
  await pause(1500);
  await evaluate(`document.querySelector('button[aria-label="远程桌面"]').click()`);
  await wait(
    `document.querySelector('select[aria-label="远端显示尺寸"]')?.options.length===5`,
    'supported modes loaded',
  );
  await wait(
    `document.querySelector('select[aria-label="远端显示尺寸"]').value==='fit'`,
    'saved pair preference',
  );
  await pause(30);
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(e=>e.innerText==='开始远程桌面').click()`,
  );
  await wait(
    `Boolean(document.querySelector('[aria-label="远程桌面画面"] video'))`,
    'stage mounted',
  );
  await pause(100);
  await evaluate(
    `(()=>{window.dimensionsReady=true;document.querySelector('video').dispatchEvent(new Event('loadedmetadata'));})()`,
  );
  await pause(100);
  await evaluate(
    `(()=>{const e=document.querySelector('[aria-label="远程桌面画面"]'),r=e.getBoundingClientRect();e.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true}));e.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:1,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true}));})()`,
  );
  const sent = await evaluate('window.sent');
  if (!sent.some((e) => e.t === 'button' && e.down))
    throw Error('Late video metadata did not attach mouse input: ' + JSON.stringify(sent));
  const request = (await evaluate('window.requests')).find(
    (e) => e.url === '/__rpc/desktopRequest',
  );
  if (
    request?.input?.resolution?.width !== 2560 ||
    request?.input?.resolution?.height !== 1600 ||
    request?.input?.resolutionChoice !== 'fit'
  )
    throw Error('Resolution was not sent: ' + JSON.stringify(request));
  if (await evaluate(`document.body.innerText.includes('切换远端输入法')`))
    throw Error('Input-source button still shown');
  const original = await evaluate(
    `(()=>{const r=document.querySelector('video').getBoundingClientRect(),d=document.querySelector('dialog').getBoundingClientRect();return {width:r.width,dialogWidth:d.width};})()`,
  );
  if (original.dialogWidth < 1500)
    throw Error('Expanded dialog does not fill window: ' + JSON.stringify(original));
  await evaluate(
    `(()=>{const e=document.querySelector('select[aria-label="缩放"]');e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await pause(80);
  const zoomed = await evaluate(`document.querySelector('video').getBoundingClientRect().width`);
  if (Math.abs(zoomed - original.width * 2) > 2)
    throw Error(
      'Zoom incorrect: ' +
        JSON.stringify({
          original,
          zoomed,
          state: await evaluate(
            `({stage:document.querySelector('[aria-label="远程桌面画面"]').getBoundingClientRect().toJSON(),style:document.querySelector('video').getAttribute('style'),zoom:document.querySelector('select[aria-label="缩放"]').value})`,
          ),
        }),
    );
  await evaluate(`document.querySelector('button[aria-label="拖动画面"]').click()`);
  await pause(40);
  const before = await evaluate(`document.querySelector('video').getBoundingClientRect().left`);
  await evaluate(
    `(()=>{window.sent=[];const e=document.querySelector('[aria-label="远程桌面画面"]'),r=e.getBoundingClientRect();for(const [type,x,y] of [['pointerdown',0,0],['pointermove',100,50],['pointerup',100,50]])e.dispatchEvent(new PointerEvent(type,{button:0,pointerId:4,clientX:r.x+r.width/2+x,clientY:r.y+r.height/2+y,bubbles:true}));})()`,
  );
  await pause(40);
  const after = await evaluate(`document.querySelector('video').getBoundingClientRect().left`);
  if (Math.abs(after - before - 100) > 2) throw Error('Pan incorrect: ' + before + ' -> ' + after);
  if ((await evaluate('window.sent')).some((e) => e.t === 'button' || e.t === 'move'))
    throw Error('Pan forwarded remote mouse events');
  await evaluate(`document.querySelector('button[aria-label="拖动画面"]').click()`);
  await pause(40);
  const expected = await evaluate(
    `(()=>{window.sent=[];const e=document.querySelector('[aria-label="远程桌面画面"]'),r=e.getBoundingClientRect(),v=document.querySelector('video').getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;e.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:5,clientX:x,clientY:y,bubbles:true}));e.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:5,clientX:x,clientY:y,bubbles:true}));return {x:(x-v.x)/v.width,y:(y-v.y)/v.height};})()`,
  );
  const click = (await evaluate('window.sent')).find((e) => e.t === 'button' && e.down);
  if (!click || Math.abs(click.x - expected.x) > 0.001 || Math.abs(click.y - expected.y) > 0.001)
    throw Error('Click coordinate mismatch: ' + JSON.stringify({ click, expected }));
  await evaluate(
    `document.querySelector('[aria-label="远程桌面画面"]').parentElement.requestFullscreen()`,
  );
  await pause(80);
  const full = await evaluate(
    `({active:!!document.fullscreenElement,toolbar:!!document.fullscreenElement.querySelector('select[aria-label="缩放"]'),width:document.querySelector('[aria-label="远程桌面画面"]').clientWidth})`,
  );
  if (!full.active || !full.toolbar || full.width < 1500)
    throw Error('Fullscreen layout failed: ' + JSON.stringify(full));
  const fullBounds = await evaluate(
    `(()=>{const r=document.querySelector('[aria-label="远程桌面画面"]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,screenWidth:innerWidth,screenHeight:innerHeight,toolbar:getComputedStyle(document.querySelector('.desktop-view-toolbar')).visibility};})()`,
  );
  if (
    fullBounds.x !== 0 ||
    fullBounds.y !== 0 ||
    Math.abs(fullBounds.width - fullBounds.screenWidth) > 1 ||
    Math.abs(fullBounds.height - fullBounds.screenHeight) > 1
  )
    throw Error('Fullscreen has reserved space: ' + JSON.stringify(fullBounds));
  await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 500 });
  await pause(200);
  if (
    (await evaluate(
      `getComputedStyle(document.querySelector('.desktop-view-toolbar')).visibility`,
    )) !== 'hidden'
  )
    throw Error('Fullscreen toolbar did not hide');
  await evaluate('window.sent=[]');
  await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 60 });
  await pause(200);
  if (
    (await evaluate(
      `getComputedStyle(document.querySelector('.desktop-view-toolbar')).visibility`,
    )) !== 'visible'
  )
    throw Error('Approaching the top did not reveal toolbar');
  await evaluate('window.sent=[]');
  const toolbar = await evaluate(
    `(()=>{const r=document.querySelector('.desktop-view-toolbar').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toolbar.x, y: toolbar.y });
  await evaluate(
    `(()=>{const e=document.fullscreenElement.querySelector('select[aria-label="缩放"]');e.focus();e.value='1.5';e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  if ((await evaluate('window.sent')).some((e) => e.t === 'button' || e.t === 'move'))
    throw Error('Fullscreen toolbar forwarded mouse events');
  await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 500 });
  await pause(200);
  if (
    (await evaluate(
      `getComputedStyle(document.querySelector('.desktop-view-toolbar')).visibility`,
    )) !== 'hidden'
  )
    throw Error('Toolbar stayed open after changing zoom and leaving');
  await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 60 });
  await pause(180);
  await evaluate(
    `document.fullscreenElement.querySelector('button[aria-label="退出全屏"]').click()`,
  );
  await wait(`!document.fullscreenElement`, 'exit fullscreen from floating toolbar');

  await pause(80);
  console.log(
    'PASS: resolution menu and request, fill/fullscreen, zoom/pan, accurate clicks and removed source button',
  );
} finally {
  ws?.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
}
