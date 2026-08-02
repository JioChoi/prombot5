import { chromium } from 'playwright';
const S='/tmp/claude-1000/-home-jio-projects-prombot/72b0d6ed-f270-4439-8bce-3c9997b1d5b0/scratchpad';
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1280,height:900}, deviceScaleFactor:1});
await p.goto('https://prombot-one.vercel.app', {waitUntil:'networkidle'});
const ta = p.locator('#prompt_beg0');
await ta.evaluate(e=>e.focus());
await p.keyboard.press('Control+A'); await p.keyboard.press('Backspace');
await p.keyboard.type('1girl, solo, long hair, blue ey', {delay:35});
await p.waitForTimeout(900);
const info = await p.evaluate(()=>{
  const t=document.querySelector('#prompt_beg0');
  const r=t.getBoundingClientRect();
  const cands=[...document.querySelectorAll('body *')].filter(e=>{
    const cs=getComputedStyle(e), q=e.getBoundingClientRect();
    return (cs.position==='absolute'||cs.position==='fixed') && q.height>30 && q.width>60 && /blue/i.test(e.innerText||'');
  });
  const c=cands[cands.length-1];
  const chain=[]; let n=c;
  while(n && n!==document.body){ const cs=getComputedStyle(n); chain.push(`${n.tagName}.${String(n.className).slice(0,50)} pos=${cs.position} top=${cs.top} left=${cs.left} tf=${cs.transform}`); n=n.parentElement; }
  return {ta:r.toJSON(), pop:c&&c.getBoundingClientRect().toJSON(), style:c?.getAttribute('style'), text:(c?.innerText||'').slice(0,200).replace(/\n/g,' | '), chain};
});
console.log(JSON.stringify(info,null,1));
await p.screenshot({path:S+'/ref-desktop.png'});
await b.close();
