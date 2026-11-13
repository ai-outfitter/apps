// Shared browser evidence capture for container/workspace runners. The caller
// owns authentication and artifact publication; credentials never enter evidence.

export async function captureEvidence(page, { url, readySelector, previewSelector }) {
  const errors=[];
  const onError=error=>errors.push(error.message);
  page.on('pageerror',onError);
  const images=[];
  const add=(kind,bytes)=>images.push({kind,bytes,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)});
  try {
    for (const [kind,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
      await page.setViewportSize(viewport);
      await page.goto(url,{waitUntil:'networkidle'});
      await page.locator(readySelector).waitFor({timeout:90000});
      if(await page.locator(readySelector).getAttribute('data-ready')==='false') throw new Error('No renderable geometry');
      await page.evaluate(()=>document.fonts.ready);
      if(kind==='desktop'&&previewSelector) add('preview',await page.locator(previewSelector).screenshot({type:'png'}));
      add(kind,await page.screenshot({type:'png'}));
    }
    if(errors.length) throw new Error(`Capture page errors: ${errors.join('; ')}`);
    return {capturedAt:new Date().toISOString(),renderer:`Chromium ${page.context().browser().version()}`,images};
  } finally { page.off('pageerror',onError); }
}
