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
console.log(await p.evaluate(()=>{
  // the previous implementation: detached mirror on <body>, width = clientWidth
  const COPIED=["boxSizing","width","paddingTop","paddingRight","paddingBottom","paddingLeft","borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth","fontFamily","fontSize","fontWeight","fontStyle","letterSpacing","lineHeight","textTransform","wordSpacing","textIndent","whiteSpace","wordWrap","overflowWrap","tabSize"];
  const el=document.querySelector('textarea');
  const mirror=document.createElement('div');
  Object.assign(mirror.style,{position:'absolute',top:'0',left:'0',visibility:'hidden',whiteSpace:'pre-wrap',wordWrap:'break-word'});
  document.body.appendChild(mirror);
  const cs=getComputedStyle(el);
  for(const k of COPIED) mirror.style[k]=cs[k];
  mirror.style.width=`${el.clientWidth}px`;
  const live=el.parentElement.querySelector('div[aria-hidden]');
  const out=[];
  for(const c of [3,40,60,85]){
    mirror.textContent=el.value.slice(0,c);
    const s=document.createElement('span'); s.textContent='​'; mirror.appendChild(s);
    const box=el.getBoundingClientRect();
    const oldX=box.left+s.offsetLeft-el.scrollLeft, oldY=box.top+s.offsetTop-el.scrollTop;
    live.textContent=el.value.slice(0,c);
    const r=document.createRange(); r.setStart(live.firstChild,c); r.setEnd(live.firstChild,c);
    const t=r.getBoundingClientRect(); live.textContent='';
    out.push(`caret ${String(c).padStart(3)}  old x=${oldX.toFixed(1)} y=${oldY.toFixed(1)}  truth x=${t.left.toFixed(1)} y=${t.top.toFixed(1)}  dx=${(oldX-t.left).toFixed(1)} dy=${(oldY-t.top).toFixed(1)}`);
  }
  mirror.remove();
  return out.join('\n');
}));
await b.close();
