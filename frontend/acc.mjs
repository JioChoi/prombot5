import { chromium } from 'playwright';
const S='/tmp/claude-1000/-home-jio-projects-prombot/72b0d6ed-f270-4439-8bce-3c9997b1d5b0/scratchpad';
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:420,height:900}, deviceScaleFactor:2});
await p.goto('http://localhost:8092/');
await p.locator('[aria-label*="settings" i]').first().click();
await p.waitForTimeout(400);
const ta = p.locator('textarea').first();
await ta.click();
// long text so the caret sits on a wrapped 3rd line, worst case for a mirror
await p.keyboard.type('1girl, solo, long hair, blue eyes, school uniform, cherry blossoms, wlop', {delay:8});
await p.waitForTimeout(500);
console.log(JSON.stringify(await p.evaluate(()=>{
  const t=document.querySelector('textarea'), u=document.querySelector('ul.fixed');
  const m=t.parentElement.querySelector('div[aria-hidden]');
  // ground truth: measure where the browser itself paints the caret line by
  // walking the overlay's own text node with a Range
  m.textContent=t.value.slice(0,t.selectionStart);
  const r=document.createRange(); r.setStart(m.firstChild, m.firstChild.length); r.setEnd(m.firstChild, m.firstChild.length);
  const cr=r.getBoundingClientRect(); m.textContent='';
  const q=u.getBoundingClientRect();
  return {caretTop:+cr.top.toFixed(1), caretBottom:+cr.bottom.toFixed(1), caretLeft:+cr.left.toFixed(1),
          popTop:+q.top.toFixed(1), popLeft:+q.left.toFixed(1),
          dy:+(q.top-cr.bottom).toFixed(1), dx:+(q.left-cr.left).toFixed(1)};
})));
await p.screenshot({path:S+'/acc.png'});
await b.close();
