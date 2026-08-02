import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:420,height:900}, deviceScaleFactor:2});
await p.goto('http://localhost:8092/');
await p.locator('[aria-label*="settings" i]').first().click();
await p.waitForTimeout(400);
const ta = p.locator('textarea').first();
await ta.click();
await p.keyboard.type('1girl, solo, long hair, blue eyes, school uniform, cherry blossoms, wlop, masterpiece', {delay:5});
await p.waitForTimeout(400);
console.log(await p.evaluate(async ()=>{
  const t=document.querySelector('textarea');
  const m=t.parentElement.querySelector('div[aria-hidden]');
  const {caretRect}=await import('/src/lib/caret.js');
  const out=[];
  for (const c of [3, 20, 40, 60, t.value.length]) {
    const mine=caretRect(t,m,c);
    m.textContent=t.value.slice(0,c);
    const r=document.createRange(); r.setStart(m.firstChild,c); r.setEnd(m.firstChild,c);
    const truth=r.getBoundingClientRect(); m.textContent='';
    out.push(`caret ${String(c).padStart(3)}  mine x=${mine.x.toFixed(1)} y=${mine.y.toFixed(1)}  range x=${truth.left.toFixed(1)} y=${truth.top.toFixed(1)}  dx=${(mine.x-truth.left).toFixed(1)} dy=${(mine.y-truth.top).toFixed(1)}`);
  }
  return out.join('\n');
}));
await b.close();
